import type { GuardCommandAnalysis } from "../../src/guard-commands";

export type AnalyzeFn = (command: string) => GuardCommandAnalysis;

export type InvariantId =
  | "I1-throws"
  | "I2-nondeterministic"
  | "I3-fail-open"
  | "I4-rewrite-not-idempotent";

export type BypassClass = "known-case" | "known-redirection" | "new";

export interface Violation {
  invariant: InvariantId;
  command: string;
  detail: string;
  classification: BypassClass;
}

export interface CampaignResult {
  seed: number;
  runs: number;
  /** How many generated commands the reference detector called raw installs. */
  referenceUnsafe: number;
  violations: Violation[];
  newViolations: Violation[];
  knownViolations: Violation[];
}

export function makeRng(seed: number): () => number;
export function pick<T>(rng: () => number, items: readonly T[]): T;
export function generateCommand(rng: () => number): string;
export function referenceDetect(command: string): "unsafe-install" | "routed" | "none";
export function classifyDecision(analysis: GuardCommandAnalysis): "deny" | "ask" | "allow";
export function stripShellRedirections(command: string): string;
export function classifyBypass(analyze: AnalyzeFn, command: string): BypassClass;
export function checkInvariants(analyze: AnalyzeFn, command: string): Violation[];
export function runCampaign(
  analyze: AnalyzeFn,
  options?: { seed?: number; runs?: number }
): CampaignResult;
