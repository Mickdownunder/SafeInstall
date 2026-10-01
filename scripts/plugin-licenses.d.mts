export interface LicenseRecord {
  name: string;
  version: string;
  license: string;
  source: string;
}

export function createThirdPartyNotices(
  records: Iterable<LicenseRecord>,
  options?: { assetsDirectory?: string }
): Promise<string>;
