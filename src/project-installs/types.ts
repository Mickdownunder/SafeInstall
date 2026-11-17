import type { RequestedPackage } from "../types";

export interface ProjectInstallTargetsResult {
  targets: {
    requested: RequestedPackage;
    manifestSpec: string;
    /** Exact key for this direct package in the lockfile package map. */
    lockfileKey?: string | undefined;
    lockfilePath?: string;
    integrity?: string | undefined;
    tarballUrl?: string | undefined;
  }[];
  issues: string[];
  lockfilePath?: string;
}
