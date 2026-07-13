import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Attack Lab — the eval SYSTEM (RFC-001 stage 4, issue #41).
 *
 * A machine-readable catalogue of attacks against SafeInstall, each pinned to
 * the layer expected to stop it and to a regression test in the normal suite.
 * The lab is eval-system-first by design: this module loads and validates the
 * case manifests and computes the eval verdict for each; the runner
 * (attack-lab/run.mjs) and the regression suite (tests/attack-lab.test.ts)
 * both consume it, so "the catalogue" and "the tests" can never drift.
 *
 * Disclosure discipline (issue #41): a case that is NOT defended and is NOT a
 * documented design limit is an unpatched bypass — its exploit detail must not
 * be published before a release + advisory. The `disclosure` field gates that;
 * `evalCase` flags a public, undefended, non-limit case as a discipline error
 * so such a case cannot be committed as "public" by accident.
 */

export const ATTACK_LAB_SCHEMA_VERSION = 1;

/** The SafeInstall layer a case expects to be caught by (or to be a limit of). */
export type AttackLayer =
  | "guard-parser"
  | "trust-surface"
  | "human-gate"
  | "release-age"
  | "provenance"
  | "decision-record"
  | "workflow-anchor";

/**
 * How well the CURRENT shipped code handles the case:
 * - "defended": the control stops it.
 * - "documented-limit": the control does NOT stop it, and this is a stated,
 *   honest boundary (e.g. K2 consistent-rewrite, approval-fatigue). Not a bug.
 * - "unpatched": the control does NOT stop it and it is a real gap awaiting a
 *   fix — exploit detail stays embargoed until release + advisory.
 */
export type DefenseStatus = "defended" | "documented-limit" | "unpatched";

export type DisclosureStatus = "public" | "advisory-pending" | "internal";

export interface AttackCase {
  schemaVersion: number;
  id: string;
  title: string;
  layer: AttackLayer;
  attacker: {
    prerequisites: string[];
    goal: string;
  };
  startingState: string;
  /** Version range where this was exploitable, or "n/a — defended by design". */
  vulnerableVersion: string;
  defense: DefenseStatus;
  /** Machine-readable expected result (a verdict word or a finding code). */
  expectedVerdict: string;
  /** Test id/name in the normal suite that pins this case. */
  regressionTest: string;
  disclosure: DisclosureStatus;
  /** Decision-record finding code this maps to, when applicable. */
  decisionRecord?: string | undefined;
  provenance: string;
}

export type EvalStatus = "ok" | "regression" | "known-gap" | "discipline-error";

export interface CaseEval {
  id: string;
  layer: AttackLayer;
  defense: DefenseStatus;
  disclosure: DisclosureStatus;
  status: EvalStatus;
  detail: string;
}

const LAYERS = new Set<AttackLayer>([
  "guard-parser",
  "trust-surface",
  "human-gate",
  "release-age",
  "provenance",
  "decision-record",
  "workflow-anchor"
]);
const DEFENSES = new Set<DefenseStatus>(["defended", "documented-limit", "unpatched"]);
const DISCLOSURES = new Set<DisclosureStatus>(["public", "advisory-pending", "internal"]);

function fail(id: string, message: string): never {
  throw new Error(`Attack case ${id || "<unknown>"}: ${message}`);
}

function expectStringArray(value: unknown, id: string, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(id, `${label} must be an array of strings`);
  }
  return value as string[];
}

/** Validate one parsed manifest into a typed case, failing closed. */
export function validateAttackCase(value: unknown, expectedId?: string): AttackCase {
  if (typeof value !== "object" || value === null) {
    fail(expectedId ?? "", "not a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : fail(expectedId ?? "", "id must be a string");
  if (expectedId && id !== expectedId) {
    fail(id, `id does not match its filename (${expectedId})`);
  }
  if (raw.schemaVersion !== ATTACK_LAB_SCHEMA_VERSION) {
    fail(id, `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; failing closed`);
  }
  if (typeof raw.layer !== "string" || !LAYERS.has(raw.layer as AttackLayer)) {
    fail(id, `layer must be one of ${[...LAYERS].join(", ")}`);
  }
  if (typeof raw.defense !== "string" || !DEFENSES.has(raw.defense as DefenseStatus)) {
    fail(id, `defense must be one of ${[...DEFENSES].join(", ")}`);
  }
  if (typeof raw.disclosure !== "string" || !DISCLOSURES.has(raw.disclosure as DisclosureStatus)) {
    fail(id, `disclosure must be one of ${[...DISCLOSURES].join(", ")}`);
  }
  const attacker = raw.attacker as Record<string, unknown> | undefined;
  if (typeof attacker !== "object" || attacker === null) {
    fail(id, "attacker must be an object");
  }
  for (const field of ["title", "startingState", "vulnerableVersion", "expectedVerdict", "regressionTest", "provenance"] as const) {
    if (typeof raw[field] !== "string" || (raw[field] as string).length === 0) {
      fail(id, `${field} must be a non-empty string`);
    }
  }
  if (raw.decisionRecord !== undefined && typeof raw.decisionRecord !== "string") {
    fail(id, "decisionRecord must be a string when present");
  }

  return {
    schemaVersion: ATTACK_LAB_SCHEMA_VERSION,
    id,
    title: raw.title as string,
    layer: raw.layer as AttackLayer,
    attacker: {
      prerequisites: expectStringArray(attacker.prerequisites, id, "attacker.prerequisites"),
      goal: typeof attacker.goal === "string" ? attacker.goal : fail(id, "attacker.goal must be a string")
    },
    startingState: raw.startingState as string,
    vulnerableVersion: raw.vulnerableVersion as string,
    defense: raw.defense as DefenseStatus,
    expectedVerdict: raw.expectedVerdict as string,
    regressionTest: raw.regressionTest as string,
    disclosure: raw.disclosure as DisclosureStatus,
    decisionRecord: raw.decisionRecord as string | undefined,
    provenance: raw.provenance as string
  };
}

/**
 * The eval verdict for a case, from its declared fields alone (the manifest is
 * the source of truth; the regression test named by `regressionTest` is what
 * proves the `defense` claim in executable form):
 * - defended → ok
 * - documented-limit → known-gap (we never claimed to stop it)
 * - unpatched → regression (a real gap must not sit silently green)
 * - a public case that is undefended and not a documented limit →
 *   discipline-error (exploit detail should not be public pre-advisory)
 */
export function evalCase(attackCase: AttackCase): CaseEval {
  const base = {
    id: attackCase.id,
    layer: attackCase.layer,
    defense: attackCase.defense,
    disclosure: attackCase.disclosure
  };

  if (attackCase.defense === "unpatched" && attackCase.disclosure === "public") {
    return {
      ...base,
      status: "discipline-error",
      detail:
        "unpatched bypass marked public — exploit detail must not be published before a release + advisory (issue #41)."
    };
  }
  if (attackCase.defense === "defended") {
    return { ...base, status: "ok", detail: `defended; pinned by ${attackCase.regressionTest}.` };
  }
  if (attackCase.defense === "documented-limit") {
    return {
      ...base,
      status: "known-gap",
      detail: `documented limit (${attackCase.vulnerableVersion}); boundary named, not a regression.`
    };
  }
  return {
    ...base,
    status: "regression",
    detail: "unpatched gap — fix before release; exploit detail stays embargoed."
  };
}

export interface AttackLabReport {
  cases: CaseEval[];
  counts: Record<EvalStatus, number>;
  /** True when nothing needs action: no regressions and no discipline errors. */
  clean: boolean;
}

export function summarize(evals: CaseEval[]): AttackLabReport {
  const counts: Record<EvalStatus, number> = {
    ok: 0,
    regression: 0,
    "known-gap": 0,
    "discipline-error": 0
  };
  for (const evaluation of evals) {
    counts[evaluation.status] += 1;
  }
  return {
    cases: evals,
    counts,
    clean: counts.regression === 0 && counts["discipline-error"] === 0
  };
}

/** Load, validate, and sort every case manifest in a directory (id order). */
export async function loadAttackCases(casesDir: string): Promise<AttackCase[]> {
  const names = (await readdir(casesDir)).filter((name) => name.endsWith(".json")).sort();
  const cases: AttackCase[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const expectedId = name.replace(/\.json$/, "");
    const parsed = JSON.parse(await readFile(path.join(casesDir, name), "utf8"));
    const attackCase = validateAttackCase(parsed, expectedId);
    if (seen.has(attackCase.id)) {
      fail(attackCase.id, "duplicate id across manifests");
    }
    seen.add(attackCase.id);
    cases.push(attackCase);
  }
  return cases;
}
