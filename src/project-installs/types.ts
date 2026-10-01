import type { RequestedPackage } from "../types";

export interface ProjectInstallTargetsResult {
  targets: {
    requested: RequestedPackage;
    manifestSpec: string;
    lockfilePath?: string;
    integrity?: string | undefined;
    tarballUrl?: string | undefined;
  }[];
  issues: string[];
  lockfilePath?: string;
}
