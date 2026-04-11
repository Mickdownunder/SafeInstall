import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inferProjectInstallTargetsForCheck,
  loadProjectInstallTargetsForManager,
  loadNpmProjectInstallTargets,
  loadPnpmProjectInstallTargets
} from "../src/project-installs";

const tempDirs: string[] = [];

async function createTempProject(files: Record<string, string>): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-"));
  tempDirs.push(tempDir);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = path.join(tempDir, relativePath);
      await writeFile(filePath, content, "utf8");
    })
  );

  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("loadPnpmProjectInstallTargets", () => {
  it("resolves direct registry dependencies to pinned versions from pnpm-lock.yaml", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^1.14.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    });

    const result = await loadPnpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].requested).toMatchObject({
      name: "axios",
      sourceType: "registry",
      requested: "1.14.0",
      registrySpecKind: "version"
    });
  });

  it("blocks stale pnpm lockfiles when manifest and lockfile specifiers differ", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^1.13.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    });

    const result = await loadPnpmProjectInstallTargets(cwd, cwd);
    expect(result.issues[0]).toContain("specifier");
  });

  it("classifies git-based direct dependencies from pnpm lockfiles as git", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            lodash: "github:lodash/lodash#4.17.21"
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: github:lodash/lodash#4.17.21
        version: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538

packages:

  lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538:
    resolution: {tarball: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538}
    version: 4.17.21
`
    });

    const result = await loadPnpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets[0].requested).toMatchObject({
      name: "lodash",
      sourceType: "git"
    });
  });

  it("supports older pnpm lockfiles with root-level specifiers and /name/version package keys", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": `lockfileVersion: 5.4
specifiers:
  axios: ^1.14.0
dependencies:
  axios: 1.14.0
packages:
  /axios/1.14.0:
    resolution:
      tarball: https://registry.npmjs.org/axios/-/axios-1.14.0.tgz
`
    });

    const result = await loadPnpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets[0].requested).toMatchObject({
      name: "axios",
      sourceType: "registry",
      requested: "1.14.0"
    });
  });
});

describe("loadNpmProjectInstallTargets", () => {
  it("resolves direct registry dependencies to pinned versions from package-lock.json", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "package-lock.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {
                axios: "^1.14.0"
              }
            },
            "node_modules/axios": {
              version: "1.14.0",
              resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
              integrity: "sha512-test"
            }
          }
        },
        null,
        2
      )
    });

    const result = await loadNpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets[0].requested).toMatchObject({
      name: "axios",
      sourceType: "registry",
      requested: "1.14.0",
      registrySpecKind: "version"
    });
  });

  it("blocks stale npm lockfiles when a direct dependency is missing", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "package-lock.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {}
            }
          }
        },
        null,
        2
      )
    });

    const result = await loadNpmProjectInstallTargets(cwd, cwd);
    expect(result.issues[0]).toContain("missing");
  });

  it("classifies git-based direct dependencies from package-lock.json as git", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            lodash: "github:lodash/lodash#4.17.21"
          }
        },
        null,
        2
      ),
      "package-lock.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {
                lodash: "github:lodash/lodash#4.17.21"
              }
            },
            "node_modules/lodash": {
              version: "4.17.21",
              resolved: "git+ssh://git@github.com/lodash/lodash.git#f299b52f39486275a9e6483b60a410e06520c538"
            }
          }
        },
        null,
        2
      )
    });

    const result = await loadNpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets[0].requested).toMatchObject({
      name: "lodash",
      sourceType: "git"
    });
  });

  it("treats registry tarballs without integrity as registry installs for older npm lockfiles", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "package-lock.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 2,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {
                axios: "^1.14.0"
              }
            },
            "node_modules/axios": {
              version: "1.14.0",
              resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
            }
          }
        },
        null,
        2
      )
    });

    const result = await loadNpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.targets[0].requested).toMatchObject({
      sourceType: "registry",
      requested: "1.14.0"
    });
  });

  it("accepts npm-shrinkwrap.json as the project lockfile", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "npm-shrinkwrap.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {
                axios: "^1.14.0"
              }
            },
            "node_modules/axios": {
              version: "1.14.0",
              resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
            }
          }
        },
        null,
        2
      )
    });

    const result = await loadNpmProjectInstallTargets(cwd, cwd);

    expect(result.issues).toEqual([]);
    expect(result.lockfilePath).toContain("npm-shrinkwrap.json");
  });
});

describe("inferProjectInstallTargetsForCheck", () => {
  it("blocks project installs when the invoked package manager disagrees with package.json", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          packageManager: "pnpm@10.28.2",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "package-lock.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "demo",
              version: "1.0.0",
              dependencies: {
                axios: "^1.14.0"
              }
            },
            "node_modules/axios": {
              version: "1.14.0",
              resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
              integrity: "sha512-test"
            }
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^1.14.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    });

    const result = await loadProjectInstallTargetsForManager(cwd, cwd, "npm");
    expect(result?.issues[0]).toContain("declares pnpm as packageManager");
  });

  it("blocks ambiguous projects with both npm and pnpm lockfiles and no packageManager", async () => {
    const cwd = await createTempProject({
      "package.json": JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      ),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
      "package-lock.json": JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3 }, null, 2)
    });

    const result = await inferProjectInstallTargetsForCheck(cwd, cwd);
    expect(result?.issues[0]).toContain("both pnpm-lock.yaml and an npm lockfile exist");
  });
});
