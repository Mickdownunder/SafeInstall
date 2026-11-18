import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

/**
 * Packs the release tarball with its runtime dependencies bundled.
 *
 * The GitHub Action and the generated trust workflow check the tarball by
 * digest and then install it. Dependencies declared as caret ranges would be
 * resolved from the registry at that point, outside the digest, so a
 * compromised compatible release would run inside the verifier. Bundled
 * dependencies ship inside the tarball and npm does not resolve them, so the
 * digest covers every line of code that runs.
 *
 * The bundle is installed with `npm ci` from a lockfile written from
 * pnpm-lock.yaml: the versions and SHA-512 digests the tests and the release
 * age gate ran against. Anything this script does not understand fails the
 * release instead of falling back to range resolution.
 *
 * Usage: node scripts/pack-release.mjs <destination-dir>
 */

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";
const PLAIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`pack-release: ${message}`);
}

/** `name@version(peer@x)` without the peer suffix, split at the version's `@`. */
function splitSnapshotKey(key) {
  const base = key.replace(/\(.*$/, "");
  const at = base.lastIndexOf("@");
  if (at <= 0) fail(`unreadable lockfile key ${key}`);
  return { name: base.slice(0, at), version: base.slice(at + 1), base };
}

function tarballUrl(name, version) {
  const file = name.startsWith("@") ? name.split("/")[1] : name;
  return `${REGISTRY}/${name}/-/${file}-${version}.tgz`;
}

/** The runtime closure of pnpm-lock.yaml as an npm lockfile (version 3) for `npm ci`. */
export function buildRuntimeLockfile(manifest, lockfile) {
  if (lockfile?.lockfileVersion !== "9.0") {
    fail(`expected pnpm lockfile version 9.0, found ${lockfile?.lockfileVersion}`);
  }
  const declared = manifest.dependencies ?? {};
  const locked = lockfile.importers?.["."]?.dependencies ?? {};
  const declaredNames = Object.keys(declared).sort();
  if (JSON.stringify(declaredNames) !== JSON.stringify(Object.keys(locked).sort())) {
    fail("the runtime dependencies of package.json and pnpm-lock.yaml differ");
  }

  const entries = new Map();
  const queue = declaredNames.map((name) => {
    if (locked[name].specifier !== declared[name]) {
      fail(`pnpm-lock.yaml locks ${name} for ${locked[name].specifier}, package.json asks for ${declared[name]}`);
    }
    return `${name}@${locked[name].version}`;
  });

  while (queue.length > 0) {
    const key = queue.shift();
    const { name, version, base } = splitSnapshotKey(key);
    if (!PLAIN_VERSION.test(version)) fail(`${key} is not a registry version`);
    const existing = entries.get(name);
    if (existing) {
      // One flat tree: two versions of one name would need nesting, which
      // this script refuses to guess.
      if (existing.version !== version) fail(`${name} is locked at ${existing.version} and ${version}`);
      continue;
    }

    const metadata = lockfile.packages?.[base];
    const snapshot = lockfile.snapshots?.[key];
    if (!metadata || !snapshot) fail(`${key} is missing from pnpm-lock.yaml`);
    const integrity = metadata.resolution?.integrity;
    if (Object.keys(metadata.resolution ?? {}).join() !== "integrity" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      fail(`${key} is not a registry package with a SHA-512 integrity`);
    }
    if (Object.keys(snapshot.optionalDependencies ?? {}).length > 0) {
      fail(`${key} has optional dependencies, which this script does not pin`);
    }

    const dependencies = {};
    for (const [dependency, reference] of Object.entries(snapshot.dependencies ?? {})) {
      dependencies[dependency] = splitSnapshotKey(`${dependency}@${reference}`).version;
      queue.push(`${dependency}@${reference}`);
    }

    entries.set(name, {
      version,
      resolved: tarballUrl(name, version),
      integrity,
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      ...(metadata.engines ? { engines: metadata.engines } : {})
    });
  }

  const packages = {
    "": { name: manifest.name, version: manifest.version, dependencies: declared }
  };
  for (const name of [...entries.keys()].sort()) {
    packages[`node_modules/${name}`] = entries.get(name);
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}

/**
 * The manifest that is published: the repository's, with the runtime
 * dependencies bundled. devDependencies are dropped because `npm ci` refuses a
 * lockfile that does not cover them, and a consumer never installs them.
 */
export function releaseManifest(manifest) {
  const { devDependencies: _devDependencies, ...published } = manifest;
  return { ...published, bundleDependencies: Object.keys(manifest.dependencies ?? {}).sort() };
}

/** Every installed package name below node_modules, scoped names included. */
async function installedNames(nodeModules) {
  const names = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(path.join(nodeModules, entry.name))) names.push(`${entry.name}/${scoped}`);
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function main() {
  const destinationArgument = process.argv[2];
  if (!destinationArgument || process.argv.length > 3) {
    fail("expected exactly one destination directory");
  }
  const destination = path.resolve(destinationArgument);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const lockfile = buildRuntimeLockfile(
    manifest,
    parse(await readFile(path.join(projectRoot, "pnpm-lock.yaml"), "utf8"))
  );
  await access(path.join(projectRoot, "dist", "cli.js")).catch(() => fail("dist/cli.js is missing; build first"));

  const staging = await mkdtemp(path.join(os.tmpdir(), "safeinstall-release-"));
  try {
    for (const entry of manifest.files) {
      await cp(path.join(projectRoot, entry), path.join(staging, entry), { recursive: true });
    }
    await writeFile(path.join(staging, "package.json"), `${JSON.stringify(releaseManifest(manifest), null, 2)}\n`);
    await writeFile(path.join(staging, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);

    // npm ci installs exactly the lockfile and checks each tarball's SHA-512.
    await execFileAsync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging });

    const expected = Object.keys(lockfile.packages).filter((key) => key !== "").map((key) => key.slice("node_modules/".length));
    const installed = await installedNames(path.join(staging, "node_modules"));
    if (JSON.stringify(installed) !== JSON.stringify(expected.sort())) {
      fail(`npm ci installed ${installed.join(", ")}, the lockfile pins ${expected.join(", ")}`);
    }
    // npm's cache is keyed by digest: a lockfile entry carrying another
    // package's digest installs that package under the entry's name.
    for (const name of expected) {
      const installedManifest = JSON.parse(
        await readFile(path.join(staging, "node_modules", name, "package.json"), "utf8")
      );
      const pinned = lockfile.packages[`node_modules/${name}`].version;
      if (installedManifest.name !== name || installedManifest.version !== pinned) {
        fail(`node_modules/${name} holds ${installedManifest.name}@${installedManifest.version}, the lockfile pins ${name}@${pinned}`);
      }
    }

    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: staging }
    );
    const [packed] = JSON.parse(stdout);
    const bundled = packed.bundled ?? [];
    if (JSON.stringify([...bundled].sort()) !== JSON.stringify(expected.sort())) {
      fail(`the tarball bundles ${bundled.join(", ")}, expected ${expected.join(", ")}`);
    }
    console.log(`Packed ${packed.filename} with ${bundled.length} bundled runtime dependencies.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
