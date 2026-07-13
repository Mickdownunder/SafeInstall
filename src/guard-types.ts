import type { PackageManagerName } from "./types";

export interface GuardInstallMatch {
  manager: PackageManagerName;
  /** Canonical install subcommand: install, add, or ci. */
  command: string;
  /** The original segment text, e.g. "npm i axios". */
  segmentText: string;
}

export interface GuardUnanalyzableSegment {
  segmentText: string;
  reason: string;
}

/** A package-runner invocation that may download and execute registry code. */
export interface GuardRunnerMatch {
  tool: string;
  packageHint?: string | undefined;
  /** False means the runner prefers a locally installed binary. */
  fetchesRemote: boolean;
  segmentText: string;
}

export interface GuardCommandAnalysis {
  installs: GuardInstallMatch[];
  runners: GuardRunnerMatch[];
  unanalyzable: GuardUnanalyzableSegment[];
  usesSafeInstall: boolean;
  /** Best-effort paths written or removed by the intercepted shell command. */
  writeTargets: string[];
  /** Complete safe replacement, only when every install segment is analyzable. */
  rewrittenCommand?: string | undefined;
}
