import type { DecisionBinding } from "../../src/decision-record";
import type { DecisionRecordDraft } from "../../src/decision-store";

/** A complete, valid record draft; override what the case under test needs. */
export function createDecisionDraft(overrides: {
  lockfilePath: string;
  before: DecisionBinding;
  after: DecisionBinding;
  recordType?: "install" | "check";
  registryUrl?: string;
  decision?: "allow" | "block" | "error";
}): DecisionRecordDraft {
  const registryUrl = overrides.registryUrl ?? "https://registry.npmjs.org";
  return {
    schemaVersion: 1,
    recordType: overrides.recordType ?? "install",
    actor: "agent",
    createdAt: "2026-07-11T12:00:00.000Z",
    cliVersion: "0.12.0",
    request: {
      command: ["npm", "install", "left-pad@1.3.0"],
      packageManager: "npm"
    },
    policy: {
      binding: null,
      effective: {
        minimumReleaseAgeHours: 72,
        allowedSources: ["registry", "workspace", "file", "directory"],
        provenanceMode: "warn",
        typoSquatMode: "warn",
        transitiveMode: "warn",
        continuityMode: "warn",
        registryUrl,
        registryDefault: registryUrl === "https://registry.npmjs.org"
      }
    },
    observations: [
      {
        name: "left-pad",
        requestedSpec: "1.3.0",
        sourceType: "registry",
        resolvedVersion: "1.3.0",
        publishedAt: "2018-04-10T18:56:20.000Z",
        publishTimeSource: "registry-time",
        findings: [],
        notEvaluable: { releaseAge: null, provenance: null }
      }
    ],
    verdict: {
      decision: overrides.decision ?? "allow",
      reasons: [],
      notEvaluableCount: 0
    },
    manifest: { path: "package.json", before: null, after: null },
    lockfile: {
      path: overrides.lockfilePath,
      before: overrides.before,
      after: overrides.after
    },
    trust: { lockBinding: null },
    installed: true
  };
}
