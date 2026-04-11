import type { RequestedPackage } from "../types";

export interface ProjectInstallTargetsResult {
  targets: {
    requested: RequestedPackage;
    manifestSpec: string;
    lockfilePath?: string;
  }[];
  issues: string[];
  lockfilePath?: string;
}
