#!/usr/bin/env node
"use strict";

/**
 * SafeInstall attack replay.
 *
 * Feeds the recorded attack-time state of a real supply-chain incident into
 * SafeInstall's actual policy engine (the shipped, compiled code in dist/)
 * and reports which checks would have blocked the install and under which
 * configuration. The malicious package versions have long been removed from
 * npm, so a live install is impossible — these fixtures reconstruct the
 * package metadata as it existed during the attack window.
 *
 * The verdicts are produced by the real engine, not hardcoded. Run:
 *   pnpm replay            # list available attacks
 *   pnpm replay mastra     # replay a specific attack
 */

const fs = require("node:fs");
const path = require("node:path");

let policy;
let transitive;
let config;
try {
  policy = require("../../dist/policy.js");
  transitive = require("../../dist/transitive.js");
  config = require("../../dist/config.js");
} catch (error) {
  console.error("Could not load SafeInstall from dist/. Run `pnpm build` first.");
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

const bold = (s) => `[1m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const rule = () => console.log(dim("-".repeat(72)));

const attacksDir = path.join(__dirname, "attacks");

function listAttacks() {
  return fs
    .readdirSync(attacksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function replay(attackName) {
  const dir = path.join(attacksDir, attackName);
  const attack = JSON.parse(fs.readFileSync(path.join(dir, "attack.json"), "utf8"));
  const now = new Date(attack.now);

  console.log("");
  console.log(bold(`${attack.name} (${attack.date})`));
  console.log(dim(attack.summary));
  console.log("");
  console.log(dim("Running SafeInstall's real policy engine against the attack-time state..."));
  console.log("");

  const findings = [];

  // --- Direct dependency: evaluated against the default config ---
  const defaultConfig = config.createDefaultConfig();
  const requested = {
    name: attack.directInstall.name,
    raw: `${attack.directInstall.name}@${attack.directInstall.version}`,
    requested: attack.directInstall.version,
    sourceType: attack.directInstall.sourceType,
    registrySpecKind: "version"
  };
  const directEvaluation = policy.evaluatePackage({
    config: defaultConfig,
    requested,
    now,
    resolvedRegistryPackage: {
      requested,
      resolvedVersion: attack.directInstall.version,
      publishedAt: new Date(attack.directInstall.publishedAt),
      lifecycleScripts: attack.directInstall.lifecycleScripts
    }
  });
  for (const reason of directEvaluation.blockedReasons) {
    findings.push({ reason, requires: "default config" });
  }

  // --- Transitive tree: requires opt-in transitive mode ---
  const transitiveConfig = config.createDefaultConfig();
  transitiveConfig.transitive = { mode: "block", checks: ["install-script", "untrusted-source"] };
  const transitiveEvaluation = await transitive.evaluateTransitiveDependencies({
    lockfilePath: path.join(dir, attack.lockfile),
    directNames: new Set([attack.directInstall.name]),
    config: transitiveConfig
  });
  for (const reason of transitiveEvaluation.blockedReasons) {
    findings.push({ reason, requires: 'transitive.mode = "block" (opt-in)' });
  }

  if (findings.length === 0) {
    console.log(red("✗ NOT BLOCKED — SafeInstall would not have caught this attack."));
  } else {
    for (const { reason, requires } of findings) {
      console.log(green(`✓ BLOCKED — ${reason.code}`));
      console.log(`  ${reason.message.replace(/^Blocked:\s*/, "")}`);
      console.log(dim(`  requires: ${requires}`));
      console.log("");
    }
    const defaultCatch = findings.find((f) => f.requires === "default config");
    rule();
    console.log(
      bold("Verdict: ") +
        (defaultCatch
          ? green("SafeInstall blocks this attack with default settings.")
          : "SafeInstall blocks this attack (requires opt-in checks).")
    );
  }

  rule();
  console.log(dim("Sources:"));
  for (const source of attack.sources) {
    console.log(dim(`  ${source}`));
  }
  if (attack.note) {
    console.log("");
    console.log(dim(attack.note));
  }
  console.log("");
}

async function main() {
  const attackName = process.argv[2];
  const available = listAttacks();

  if (!attackName) {
    console.log(bold("SafeInstall attack replay"));
    console.log("");
    console.log("Available attacks:");
    for (const name of available) {
      console.log(`  pnpm replay ${name}`);
    }
    console.log("");
    return;
  }

  if (!available.includes(attackName)) {
    console.error(`Unknown attack "${attackName}". Available: ${available.join(", ")}`);
    process.exit(1);
  }

  await replay(attackName);
}

void main();
