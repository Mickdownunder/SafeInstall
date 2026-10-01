import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`));
    else resolve({ stdout, stderr });
  });
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const packageNamePath = (name) => name.split("/").join(path.sep);
async function resolvePackageRoot(name, from) {
  let current = from;
  while (true) {
    const candidate = path.join(current, "node_modules", packageNamePath(name));
    try {
      const resolved = await realpath(candidate);
      const pkg = JSON.parse(await readFile(path.join(resolved, "package.json"), "utf8"));
      if (pkg.name === name) return resolved;
    } catch { /* Try the next ancestor's node_modules directory. */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not resolve installed package ${name} from ${from}.`);
}
async function assertContainedLinks(directory, packageRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(full);
      const relative = path.relative(packageRoot, target);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Dependency package contains a symlink outside its own root: ${full} -> ${target}`);
      }
    } else if (entry.isDirectory()) {
      await assertContainedLinks(full, packageRoot);
    }
  }
}
async function assertNoNestedDependencies(packageRoot) {
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.name === "node_modules") {
        const contents = await readdir(child);
        if (contents.some((name) => name !== ".bin")) {
          throw new Error(`Refusing dependency package with nested node_modules: ${child}`);
        }
      } else if (entry.isDirectory()) {
        await scan(child);
      }
    }
  }
  await scan(packageRoot);
}
function packageCopyFilter(packageRoot, source) {
  const relative = path.relative(packageRoot, source);
  return relative.split(path.sep).includes("node_modules") === false;
}
function tarOctal(value, length) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("Plugin archive field exceeds USTAR limits.");
  return Buffer.from(`${text}\0`, "ascii");
}
function tarHeader(name, stat, type, link = "") {
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const split = fileName.lastIndexOf("/", 155);
    if (split < 1 || Buffer.byteLength(fileName.slice(split + 1)) > 100 || Buffer.byteLength(fileName.slice(0, split)) > 155) {
      throw new Error(`Plugin archive path exceeds USTAR limits: ${name}`);
    }
    prefix = fileName.slice(0, split);
    fileName = fileName.slice(split + 1);
  }
  if (Buffer.byteLength(link) > 100) throw new Error(`Plugin symlink target exceeds USTAR limits: ${name}`);
  const block = Buffer.alloc(512);
  const put = (offset, length, value) => Buffer.from(value).copy(block, offset, 0, length);
  put(0, 100, Buffer.from(fileName));
  tarOctal(stat.mode & 0o777, 8).copy(block, 100);
  tarOctal(0, 8).copy(block, 108);
  tarOctal(0, 8).copy(block, 116);
  tarOctal(type === "0" ? stat.size : 0, 12).copy(block, 124);
  tarOctal(Math.floor(stat.mtimeMs / 1000), 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  put(157, 100, Buffer.from(link));
  put(257, 6, Buffer.from("ustar\0"));
  put(263, 2, Buffer.from("00"));
  put(345, 155, Buffer.from(prefix));
  let checksum = 0;
  for (const byte of block) checksum += byte;
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(block, 148);
  return block;
}
async function* tarEntries(base, archiveName) {
  const absolute = path.join(base, archiveName);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    yield tarHeader(archiveName, stat, "2", await readlink(absolute));
  } else if (stat.isDirectory()) {
    yield tarHeader(`${archiveName}/`, stat, "5");
    for (const name of (await readdir(absolute)).sort()) {
      yield* tarEntries(base, `${archiveName}/${name}`);
    }
  } else if (stat.isFile()) {
    yield tarHeader(archiveName, stat, "0");
    for await (const chunk of createReadStream(absolute)) yield chunk;
    const padding = (512 - stat.size % 512) % 512;
    if (padding) yield Buffer.alloc(padding);
  } else {
    throw new Error(`Unsupported file type in plugin archive: ${archiveName}`);
  }
}
async function createArchive(base, target) {
  async function* entries() {
    for (const name of ["safeinstall", ".agents"]) yield* tarEntries(base, name);
    yield Buffer.alloc(1024);
  }
  await pipeline((async function* () { yield* entries(); })(), createGzip({ level: 9 }), createWriteStream(target));
}
async function swapDirectory(staged, target, parent) {
  const backup = path.join(parent, `.safeinstall-backup-${process.pid}-${Date.now()}`);
  let movedOld = false;
  try {
    try {
      await lstat(target);
      await rename(target, backup);
      movedOld = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(staged, target);
  } catch (error) {
    if (movedOld) await rename(backup, target).catch(() => {});
    throw error;
  }
  if (movedOld) await rm(backup, { recursive: true, force: true });
}
export async function buildPlugin(options = {}) {
  const project = options.root ?? root;
  const source = path.join(project, "plugins", "safeinstall");
  const manifestPath = path.join(source, "plugin.json");
  const rootPackage = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  const lock = await readFile(path.join(project, "pnpm-lock.yaml"));
  const installedLock = await readFile(path.join(project, "node_modules", ".pnpm", "lock.yaml"));
  if (!lock.equals(installedLock)) {
    throw new Error("Installed pnpm dependency graph differs from pnpm-lock.yaml; do not package stale dependencies.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.engineVersion !== undefined && manifest.engineVersion !== rootPackage.version) {
    throw new Error(`Plugin engineVersion ${manifest.engineVersion} does not match CLI ${rootPackage.version}.`);
  }
  if (!manifest.version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("Plugin manifest must have a valid semantic version.");
  }
  const distPlugins = path.join(project, "dist", "plugins");
  const stageParent = await mkdtemp(path.join(os.tmpdir(), "safeinstall-plugin-build-"));
  const stage = path.join(stageParent, "safeinstall");
  const buildOut = path.join(stageParent, "engine-dist");
  const packageDir = path.join(stage, "runtime");
  const nodeModules = path.join(packageDir, "node_modules");
  const records = new Map();
  const directRoots = new Map();
  const placements = [];
  try {
    await mkdir(distPlugins, { recursive: true });
    await assertContainedLinks(source, source);
    await cp(source, stage, { recursive: true, dereference: true, errorOnExist: true });
    await cp(path.join(project, "LICENSE"), path.join(stage, "LICENSE"));
    await mkdir(packageDir, { recursive: true });
    await execFileAsync(process.execPath, [path.join(project, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(project, "tsconfig.build.json"), "--outDir", buildOut], { cwd: project });
    await cp(buildOut, path.join(packageDir, "dist"), { recursive: true, dereference: true, errorOnExist: true });
    await cp(path.join(project, "LICENSE"), path.join(packageDir, "LICENSE"));
    async function discover(name, sourcePath, depth = 0) {
      const resolved = await realpath(sourcePath);
      if (records.has(resolved)) return records.get(resolved);
      if (depth > 64) throw new Error(`Dependency graph exceeds depth limit 64 at ${name}.`);
      const relative = path.relative(project, resolved);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Dependency ${name} resolves outside the project dependency tree: ${resolved}`);
      const pkg = JSON.parse(await readFile(path.join(resolved, "package.json"), "utf8"));
      if (pkg.name !== name || !pkg.version) throw new Error(`Resolved dependency metadata mismatch for ${name} at ${resolved}.`);
      await assertNoNestedDependencies(resolved);
      await assertContainedLinks(resolved, resolved);
      const record = { name, version: pkg.version, license: pkg.license ?? "UNKNOWN", source: resolved, sourceRelative: relative, edges: new Map() };
      records.set(resolved, record);
      const specs = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
      const optionalPeers = new Set(Object.entries(pkg.peerDependenciesMeta ?? {}).filter(([, meta]) => meta.optional).map(([dep]) => dep));
      for (const dep of Object.keys(specs)) {
        try {
          const depPath = await resolvePackageRoot(dep, resolved);
          record.edges.set(dep, await discover(dep, depPath, depth + 1));
        }
        catch (error) {
          if (pkg.dependencies?.[dep] || (pkg.peerDependencies?.[dep] && !optionalPeers.has(dep))) throw new Error(`Required dependency ${dep}@${specs[dep]} missing from ${name}@${pkg.version}: ${error.message}`);
        }
      }
      return record;
    }
    async function linkPackage(name, record) {
      const link = path.join(nodeModules, packageNamePath(name));
      await mkdir(path.dirname(link), { recursive: true });
      await cp(record.source, link, { recursive: true, dereference: true, errorOnExist: true, filter: (source) => packageCopyFilter(record.source, source) });
      placements.push({ name, version: record.version, license: record.license, path: path.relative(stage, link).split(path.sep).join("/") });
    }
    for (const name of Object.keys(rootPackage.dependencies ?? {})) {
      let dependencyRoot;
      try { dependencyRoot = await resolvePackageRoot(name, project); }
      catch (error) { throw new Error(`Required root dependency ${name} missing: ${error.message}`); }
      directRoots.set(name, await discover(name, dependencyRoot));
    }
    for (const name of ["@modelcontextprotocol/sdk", "sigstore"]) {
      let dependencyRoot;
      try { dependencyRoot = await resolvePackageRoot(name, project); }
      catch (error) { throw new Error(`Plugin-required peer ${name} missing: ${error.message}`); }
      directRoots.set(name, await discover(name, dependencyRoot));
    }

    const primary = new Map([...records.values()].map((record) => [record.name, record]));
    for (const [name, record] of directRoots) primary.set(name, record);
    const rootScope = new Map(primary);
    for (const record of primary.values()) await linkPackage(record.name, record);

    async function place(record, destination, scope, depth = 0) {
      if (depth > 64) throw new Error(`Dependency placement exceeds depth limit 64 at ${record.name}@${record.version}.`);
      const overrides = new Map();
      for (const [name, target] of record.edges) {
        if (scope.get(name)?.source !== target.source) overrides.set(name, target);
      }
      const childScope = new Map(scope);
      for (const [name, target] of overrides) childScope.set(name, target);
      const nested = [];
      for (const [name, target] of overrides) {
        const childPath = path.join(destination, "node_modules", packageNamePath(name));
        await mkdir(path.dirname(childPath), { recursive: true });
        await cp(target.source, childPath, { recursive: true, dereference: true, errorOnExist: true, filter: (source) => packageCopyFilter(target.source, source) });
        placements.push({ name, version: target.version, license: target.license, path: path.relative(stage, childPath).split(path.sep).join("/") });
        nested.push([target, childPath]);
      }
      for (const [target, childPath] of nested) await place(target, childPath, childScope, depth + 1);
    }

    for (const record of primary.values()) {
      await place(record, path.join(nodeModules, packageNamePath(record.name)), rootScope);
    }

    const rootVersions = Object.fromEntries([...primary].map(([name, record]) => [name, record.version]));
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "safeinstall-plugin-runtime", version: rootPackage.version, private: true, type: "commonjs", engines: rootPackage.engines, dependencies: rootVersions }, null, 2)}\n`);
    await writeFile(path.join(packageDir, "inventory.json"), `${JSON.stringify({ cliVersion: rootPackage.version, lockfileSha256: hash(lock), uniquePackageCount: records.size, packages: placements.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
    const marketplace = { name: "safeinstall-local", interface: { displayName: "SafeInstall" }, plugins: [{ name: "safeinstall", source: { source: "local", path: "./safeinstall" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] };
    const marketplaceFile = path.join(stageParent, ".agents", "plugins", "marketplace.json");
    await mkdir(path.dirname(marketplaceFile), { recursive: true });
    await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);
    const tarStage = path.join(stageParent, `safeinstall-plugin-${manifest.version}.tgz`);
    await createArchive(stageParent, tarStage);
    await swapDirectory(stage, path.join(distPlugins, "safeinstall"), distPlugins);
    await swapDirectory(path.join(stageParent, ".agents"), path.join(distPlugins, ".agents"), distPlugins);
    const tarTarget = path.join(project, "dist", path.basename(tarStage));
    const tarBackup = `${tarTarget}.previous-${process.pid}`;
    let oldTar = false;
    try {
      try { await rename(tarTarget, tarBackup); oldTar = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(tarStage, tarTarget);
    } catch (error) {
      if (oldTar) await rename(tarBackup, tarTarget).catch(() => {});
      throw error;
    }
    if (oldTar) await rm(tarBackup, { force: true });
    return { directory: path.join(distPlugins, "safeinstall"), archive: tarTarget, packageCount: records.size, cliVersion: rootPackage.version };
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildPlugin().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`SafeInstall plugin build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
