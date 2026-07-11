import semver from "semver";

/** Version of the running CLI, read from the package manifest at runtime. */
export const PACKAGE_VERSION = String(
  (require("../package.json") as { version?: string }).version ?? "0.0.0"
);

export const CLI_UPDATE_COMMAND = "npm install -g safeinstall-cli@latest";

/**
 * Offline comparison of the running CLI against a project's declared
 * `minimumCliVersion`. Returns the warning text when the running CLI is older,
 * undefined otherwise. Deliberately a warning and never a hard failure: a hard
 * failure would break every agent session after each release until the global
 * CLI is updated — exactly the block-fatigue this field exists to prevent.
 *
 * Both inputs are trusted semver by construction: `minimumCliVersion` is
 * validated at config parse time and `runningVersion` comes from package.json,
 * so `semver.lt` cannot throw here.
 */
export function cliVersionWarning(
  minimumCliVersion: string | undefined,
  runningVersion: string = PACKAGE_VERSION
): string | undefined {
  if (minimumCliVersion === undefined || !semver.lt(runningVersion, minimumCliVersion)) {
    return undefined;
  }
  return (
    `This project's safeinstall.config.json expects safeinstall-cli >= ${minimumCliVersion}, ` +
    `but version ${runningVersion} is running — protections this project relies on may be ` +
    `missing or behave differently. Update with \`${CLI_UPDATE_COMMAND}\`.`
  );
}
