import { describe, expect, it } from "vitest";

import {
  buildInstallPlan,
  extractRequestedSpecs,
  normalizeInstallCommand,
  parseManifestDependency
} from "../src/specs";

describe("extractRequestedSpecs", () => {
  it("extracts package specs from install args with flags", () => {
    expect(extractRequestedSpecs(["axios", "-D", "--registry", "https://registry.npmjs.org", "zod"]))
      .toEqual(["axios", "zod"]);
  });

  it("ignores flags passed with equals syntax", () => {
    expect(extractRequestedSpecs(["--filter=app", "--registry=https://registry.npmjs.org", "axios"]))
      .toEqual(["axios"]);
  });

  it("handles local file and directory install targets", () => {
    expect(extractRequestedSpecs(["file:../pkg.tgz", "./packages/a"])).toEqual(["file:../pkg.tgz", "./packages/a"]);
  });

  it("treats tokens after -- as package specs so they cannot bypass evaluation", () => {
    expect(extractRequestedSpecs(["axios", "--", "evil-pkg"])).toEqual(["axios", "evil-pkg"]);
    expect(extractRequestedSpecs(["--", "evil-pkg"])).toEqual(["evil-pkg"]);
  });
});

describe("buildInstallPlan", () => {
  it("builds a plan for explicit pnpm add installs", () => {
    const plan = buildInstallPlan(["pnpm", "add", "axios@1.14.0", "-D"]);

    expect(plan.manager).toBe("pnpm");
    expect(plan.command).toBe("add");
    expect(plan.managerArgs).toEqual([]);
    expect(plan.packages).toHaveLength(1);
    expect(plan.packages[0]).toMatchObject({
      name: "axios",
      sourceType: "registry",
      requested: "1.14.0",
      registrySpecKind: "version"
    });
  });

  it("marks a bare install as project install", () => {
    const plan = buildInstallPlan(["npm", "install"]);
    expect(plan.projectInstall).toBe(true);
    expect(plan.packages).toHaveLength(0);
  });

  it("classifies git specs as git sources", () => {
    const plan = buildInstallPlan(["pnpm", "add", "github:axios/axios"]);
    expect(plan.packages[0]).toMatchObject({
      sourceType: "git"
    });
  });

  it("supports bun add with tarball and registry specs", () => {
    const plan = buildInstallPlan(["bun", "add", "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz", "zod"]);
    expect(plan.packages).toHaveLength(2);
    expect(plan.packages[0]).toMatchObject({
      sourceType: "tarball"
    });
    expect(plan.packages[1]).toMatchObject({
      sourceType: "registry"
    });
  });

  it("supports manager flags before the install subcommand", () => {
    const plan = buildInstallPlan(["pnpm", "-C", "packages/app", "install"]);

    expect(plan.manager).toBe("pnpm");
    expect(plan.command).toBe("install");
    expect(plan.managerArgs).toEqual(["-C", "packages/app"]);
    expect(plan.forwardedArgs).toEqual([]);
    expect(plan.projectInstall).toBe(true);
  });

  it("canonicalizes install aliases like npm i and bun a", () => {
    expect(buildInstallPlan(["npm", "i", "axios"]).command).toBe("install");
    expect(buildInstallPlan(["npm", "add", "axios"]).command).toBe("install");
    expect(buildInstallPlan(["pnpm", "i"]).command).toBe("install");
    expect(buildInstallPlan(["bun", "i"]).command).toBe("install");
    expect(buildInstallPlan(["bun", "a", "zod"]).command).toBe("add");
  });

  it("still rejects non-install commands", () => {
    expect(() => buildInstallPlan(["npm", "test"])).toThrow("Unsupported command");
    expect(() => buildInstallPlan(["pnpm", "dlx", "create-app"])).toThrow("Unsupported command");
  });
});

describe("normalizeInstallCommand", () => {
  it("maps npm install aliases to install", () => {
    for (const alias of ["install", "i", "add", "in", "isntall"]) {
      expect(normalizeInstallCommand("npm", alias)).toBe("install");
    }
  });

  it("maps npm ci aliases to ci", () => {
    expect(normalizeInstallCommand("npm", "ci")).toBe("ci");
    expect(normalizeInstallCommand("npm", "clean-install")).toBe("ci");
  });

  it("keeps pnpm add distinct from install", () => {
    expect(normalizeInstallCommand("pnpm", "add")).toBe("add");
    expect(normalizeInstallCommand("pnpm", "i")).toBe("install");
    expect(normalizeInstallCommand("pnpm", "dlx")).toBeUndefined();
  });

  it("returns undefined for non-install commands", () => {
    expect(normalizeInstallCommand("npm", "test")).toBeUndefined();
    expect(normalizeInstallCommand("npm", "run")).toBeUndefined();
    expect(normalizeInstallCommand("bun", "x")).toBeUndefined();
  });
});

describe("parseManifestDependency", () => {
  it("classifies workspace specs", () => {
    expect(parseManifestDependency("pkg-a", "workspace:*")).toMatchObject({
      name: "pkg-a",
      sourceType: "workspace"
    });
  });
});
