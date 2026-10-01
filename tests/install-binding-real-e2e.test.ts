import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, createTempDir, ensureBuiltCli, mkdirp, runCli, writeDefaultConfig, writeJson } from "./cli-e2e-helpers";

const exec = promisify(execFile);
const name = "binding-fixture";
const portable = (file: string) => file.split(path.sep).join("/");
type Attack = "none" | "tag-race" | "manifest-swap" | "bytes-swap";

async function fixture(attack: Attack, manager: "npm" | "pnpm") {
  const cwd = await createTempDir("safeinstall-artifact-e2e-");
  const marker = path.join(cwd, "script-ran");
  const archives = new Map<string, Buffer>();
  for (const version of ["1.0.0", "9.9.9"]) {
    const dir = path.join(cwd, "archives", version);
    await mkdirp(path.join(dir, "package"));
    await writeJson(path.join(dir, "package", "package.json"), {
      name, version,
      scripts: { postinstall: `node -e "require('node:fs').writeFileSync(process.env.SAFEINSTALL_ATTACK_MARKER, 'executed')"` }
    });
    await writeFile(path.join(dir, "package", "index.js"), `module.exports = "${version}";\n`);
    const archive = path.join(dir, "package.tgz");
    await exec("tar", ["-czf", archive, "-C", dir, "package"]);
    archives.set(version, await readFile(archive));
  }
  let checked = false;
  let tarballGets = 0;
  let metadataGets = 0;
  const integrity = (version: string) => `sha512-${createHash("sha512").update(archives.get(version)!).digest("base64")}`;
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const manifest = (version: string, swap = false) => ({
      name, version, scripts: {},
      dist: { tarball: `${base}/${name}/-/${name}-${version}.tgz`, integrity: integrity(swap ? "9.9.9" : version) }
    });
    if (url.includes("/-/")) {
      const version = url.endsWith("-9.9.9.tgz") ? "9.9.9" : "1.0.0";
      res.writeHead(200, { "content-type": "application/octet-stream", "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT" });
      if (req.method === "HEAD") res.end();
      else { tarballGets++; res.end(archives.get(attack === "bytes-swap" ? "9.9.9" : version)); }
      return;
    }
    if (url === `/${name}`) {
      metadataGets++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name,
        "dist-tags": { latest: checked && attack === "tag-race" ? "9.9.9" : "1.0.0" },
        versions: { "1.0.0": manifest("1.0.0", checked && attack === "manifest-swap"), "9.9.9": manifest("9.9.9") },
        time: { "1.0.0": "2018-01-01T00:00:00Z", "9.9.9": "2018-01-01T00:00:00Z" } }));
      return;
    }
    if (url === `/${name}/1.0.0` || url === `/${name}/9.9.9`) {
      const version = url.split("/").at(-1)!;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest(version)));
      checked = true;
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeJson(path.join(cwd, "package.json"), { name: "binding-consumer", version: "1.0.0", private: true,
    ...(manager === "pnpm" ? { packageManager: "pnpm@10.17.0" } : {}) });
  await writeDefaultConfig(cwd, { registryUrl: registry });
  await writeFile(path.join(cwd, "empty.npmrc"), "");
  await writeFile(path.join(cwd, "global.npmrc"), "");
  const env = { ...process.env, SAFEINSTALL_ATTACK_MARKER: marker,
    npm_config_cache: path.join(cwd, "npm-cache"), npm_config_userconfig: path.join(cwd, "empty.npmrc"),
    npm_config_globalconfig: path.join(cwd, "global.npmrc"), npm_config_fetch_retries: "0" };
  return { cwd, marker, registry, env, integrity: integrity("1.0.0"),
    get tarballGets() { return tarballGets; }, get metadataGets() { return metadataGets; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function exists(file: string) {
  try { await access(file); return true; } catch { return false; }
}

beforeAll(ensureBuiltCli);
afterAll(cleanupTempDirs);

describe("artifact binding with real package managers and real archives", () => {
  for (const manager of ["npm", "pnpm"] as const) {
    const install = (f: Awaited<ReturnType<typeof fixture>>, spec = `${name}@latest`, extra: string[] = []) =>
      runCli(["--json", manager, manager === "npm" ? "install" : "add", spec,
        ...(manager === "pnpm" ? ["--store-dir", portable(path.join(f.cwd, "store"))] : ["--no-audit", "--no-fund"]), ...extra],
      { cwd: f.cwd, env: f.env });

    it(`${manager}: installs approved bytes and never executes a concealed lifecycle script`, async () => {
      const f = await fixture("none", manager);
      try {
        const result = await install(f);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const installed = JSON.parse(await readFile(path.join(f.cwd, "node_modules", name, "package.json"), "utf8"));
        expect(installed.version).toBe("1.0.0");
        expect(await exists(f.marker)).toBe(false);
        expect(f.tarballGets).toBeGreaterThan(0);
        const project = await runCli(["--json", manager, "install",
          ...(manager === "pnpm" ? ["--store-dir", portable(path.join(f.cwd, "store")), "--frozen-lockfile"] : ["--no-audit", "--no-fund"])], { cwd: f.cwd, env: f.env });
        expect(project.code, project.stdout + project.stderr).toBe(0);
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);

    it(`${manager}: a moving latest tag cannot substitute version 9.9.9`, async () => {
      const f = await fixture("tag-race", manager);
      try {
        const result = await install(f);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(JSON.parse(await readFile(path.join(f.cwd, "node_modules", name, "package.json"), "utf8")).version).toBe("1.0.0");
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);

    it(`${manager}: shared workspace lockfiles are installed and tampered bindings are rejected`, async () => {
      const f = await fixture("none", manager);
      try {
        const app = path.join(f.cwd, "packages", "app");
        await mkdirp(app);
        await writeJson(path.join(app, "package.json"), { name: "workspace-app", version: "1.0.0",
          dependencies: { [name]: "1.0.0" } });
        const manifest = JSON.parse(await readFile(path.join(f.cwd, "package.json"), "utf8"));
        manifest.workspaces = ["packages/*"];
        await writeJson(path.join(f.cwd, "package.json"), manifest);
        await writeFile(path.join(f.cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        const result = manager === "npm" ? await install(f, `${name}@1.0.0`) :
          await install(f, `${name}@1.0.0`, ["-C", portable(app)]);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const project = await runCli(["--json", manager, "install", ...(manager === "pnpm" ?
          ["--store-dir", portable(path.join(f.cwd, "store")), "--frozen-lockfile"] : ["--no-audit", "--no-fund"])], { cwd: app, env: f.env });
        expect(project.code, project.stdout + project.stderr).toBe(0);
        if (manager === "npm") {
          const lockPath = path.join(f.cwd, "package-lock.json");
          const lock = JSON.parse(await readFile(lockPath, "utf8"));
          lock.packages[`packages/app/node_modules/${name}`] = { ...lock.packages[`node_modules/${name}`],
            integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}` };
          await writeJson(lockPath, lock);
        } else {
          const lockPath = path.join(f.cwd, "pnpm-lock.yaml");
          await writeFile(lockPath, (await readFile(lockPath, "utf8")).replace(f.integrity,
            `sha512-${Buffer.alloc(64, 9).toString("base64")}`));
        }
        const tampered = await runCli(["--json", manager, "install"], { cwd: app, env: f.env });
        expect(tampered.code, tampered.stdout + tampered.stderr).toBe(2);
        expect(JSON.parse(tampered.stdout).execution.ranPackageManager).toBe(false);
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);

    it(`${manager}: a same-version manifest swap is blocked before unpacking`, async () => {
      const f = await fixture("manifest-swap", manager);
      try {
        const result = await install(f);
        expect(result.code, result.stdout + result.stderr).toBe(2);
        expect(JSON.parse(result.stdout).reasons[0].code).toBe("artifact-binding-failed");
        expect(await exists(path.join(f.cwd, "node_modules", name))).toBe(false);
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);

    it(`${manager}: archive bytes differing from the approved digest cannot install`, async () => {
      const f = await fixture("bytes-swap", manager);
      try {
        const result = await install(f);
        expect(result.code, result.stdout + result.stderr).not.toBe(0);
        expect(result.stdout + result.stderr).toMatch(/integrity|EINTEGRITY/i);
        expect(await exists(path.join(f.cwd, "node_modules", name, "package.json"))).toBe(false);
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);

    it(`${manager}: a conflicting registry and script override are refused without invoking installation`, async () => {
      const f = await fixture("none", manager);
      try {
        for (const extra of [["--registry=http://127.0.0.1:1"], ["--ignore-scripts=false"], ["--global"]]) {
          const result = await install(f, name, extra);
          expect(result.code, result.stdout + result.stderr).toBe(2);
          expect(JSON.parse(result.stdout).execution.ranPackageManager).toBe(false);
        }
        expect(f.tarballGets).toBe(0);
        expect(await exists(f.marker)).toBe(false);
      } finally { await f.close(); }
    }, 30000);
  }

  it("blocks Bun without claiming an unimplemented integrity guarantee", async () => {
    const f = await fixture("none", "npm");
    try {
      const result = await runCli(["--json", "bun", "add", `${name}@1.0.0`], { cwd: f.cwd, env: f.env });
      expect(result.code, result.stdout + result.stderr).toBe(2);
      expect(JSON.parse(result.stdout).reasons[0].code).toBe("artifact-binding-unsupported");
      expect(JSON.parse(result.stdout).execution.ranPackageManager).toBe(false);
    } finally { await f.close(); }
  });
});
