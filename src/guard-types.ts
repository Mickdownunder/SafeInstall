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

/** Static shell-resolution context for one recognized write target. */
export interface GuardWriteOperation {
  target: string;
  /** True when the shell can expand or substitute the target before execution. */
  hasExpansion: boolean;
  /** Literal cwd changes to apply in order from the hook event's initial cwd. */
  cwdVariants: string[][];
  /** True when at least one reachable cwd cannot be represented statically. */
  cwdUncertain: boolean;
}

export interface GuardCommandAnalysis {
  installs: GuardInstallMatch[];
  runners: GuardRunnerMatch[];
  /** True only when a local runner lookup is guaranteed to use the event cwd. */
  localRunnerResolutionSafe: boolean;
  unanalyzable: GuardUnanalyzableSegment[];
  usesSafeInstall: boolean;
  /** Best-effort paths written or removed by the intercepted shell command. */
  writeTargets: string[];
  /** Cwd and expansion metadata used to enforce protected writes safely. */
  writeOperations: GuardWriteOperation[];
  /** Complete safe replacement, only when every install segment is analyzable. */
  rewrittenCommand?: string | undefined;
}
