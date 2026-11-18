export interface RuntimeLockfileEntry {
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export interface RuntimeLockfile {
  name: string;
  version: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, RuntimeLockfileEntry | { name: string; version: string; dependencies: Record<string, string> }>;
}

export function buildRuntimeLockfile(manifest: Record<string, unknown>, lockfile: unknown): RuntimeLockfile;

export function releaseManifest(manifest: Record<string, unknown>): Record<string, unknown>;
