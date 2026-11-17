import type { CliReason, CliResult } from "./types";

export const REDACTED_CREDENTIAL = "[REDACTED]";

const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)@/giu;
const QUERY_PARAMETER_PATTERN = /([?&])([^=&#\s]+)=([^&#\s]*)/gu;
const KEY_VALUE_PATTERN = /(^|\s)([^=\s]+)=("[^"]*"|'[^']*'|[^\s]*)/gu;
const OPTION_VALUE_PATTERN = /(^|\s)(--?[^=\s]+)(\s+)("[^"]*"|'[^']*'|[^\s]+)/gu;
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*:\s*)((?:basic|bearer)\s+)?([^\s,;]+)/giu;

function normalizeCredentialName(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    // A malformed percent escape cannot make a credential name safe. Match
    // against the original spelling so the caller still fails closed.
  }
  return decoded.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveCredentialName(value: string): boolean {
  const normalized = normalizeCredentialName(value);
  return (
    normalized === "auth" ||
    normalized === "authorization" ||
    normalized === "code" ||
    normalized === "jwt" ||
    normalized === "key" ||
    normalized === "pwd" ||
    normalized === "passwd" ||
    normalized === "session" ||
    normalized === "sessionid" ||
    normalized === "sig" ||
    normalized.endsWith("auth") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("accesskeyid") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("signature") ||
    normalized.endsWith("credential")
  );
}

function redactSensitiveAssignment(argument: string): string {
  const separator = argument.indexOf("=");
  if (separator <= 0 || !isSensitiveCredentialName(argument.slice(0, separator))) {
    return argument;
  }
  return `${argument.slice(0, separator + 1)}${REDACTED_CREDENTIAL}`;
}

function isSensitiveValueOption(argument: string): boolean {
  return argument.startsWith("-") && !argument.includes("=") && isSensitiveCredentialName(argument);
}

function shouldRedactUrlUserinfo(scheme: string, userinfo: string): boolean {
  return !(
    /^(?:git\+)?ssh:\/\/$/iu.test(scheme) &&
    !userinfo.includes(":") &&
    !/%3a/iu.test(userinfo)
  );
}

/** Redact credentials from text that may be copied into logs or records. */
export function redactSensitiveText(value: string): string {
  const withoutUserinfo = value.replace(
    URL_USERINFO_PATTERN,
    (match, scheme: string, userinfo: string) =>
      shouldRedactUrlUserinfo(scheme, userinfo)
        ? `${scheme}${REDACTED_CREDENTIAL}@`
        : match
  );
  const withoutQuerySecrets = withoutUserinfo.replace(
    QUERY_PARAMETER_PATTERN,
    (match, separator: string, name: string) =>
      isSensitiveCredentialName(name) ? `${separator}${name}=${REDACTED_CREDENTIAL}` : match
  );
  const withoutAssignments = withoutQuerySecrets.replace(
    KEY_VALUE_PATTERN,
    (match, prefix: string, name: string) =>
      isSensitiveCredentialName(name) ? `${prefix}${name}=${REDACTED_CREDENTIAL}` : match
  );
  const withoutOptionValues = withoutAssignments.replace(
    OPTION_VALUE_PATTERN,
    (match, prefix: string, name: string, spacing: string) =>
      isSensitiveCredentialName(name)
        ? `${prefix}${name}${spacing}${REDACTED_CREDENTIAL}`
        : match
  );
  return withoutOptionValues.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ?? ""}${REDACTED_CREDENTIAL}`
  );
}

/** Redact both inline assignments and `--secret value` argument pairs. */
export function redactSensitiveArgs(args: readonly string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_CREDENTIAL;
    }

    const assignmentRedacted = redactSensitiveAssignment(argument);
    redactNext = isSensitiveValueOption(argument);
    return redactSensitiveText(assignmentRedacted);
  });
}

export function containsSensitiveCredentials(value: string): boolean {
  for (const match of value.matchAll(URL_USERINFO_PATTERN)) {
    if (shouldRedactUrlUserinfo(match[1] ?? "", match[2] ?? "")) {
      return true;
    }
  }
  for (const match of value.matchAll(QUERY_PARAMETER_PATTERN)) {
    if (isSensitiveCredentialName(match[2] ?? "")) {
      return true;
    }
  }
  for (const match of value.matchAll(KEY_VALUE_PATTERN)) {
    if (isSensitiveCredentialName(match[2] ?? "")) {
      return true;
    }
  }
  for (const match of value.matchAll(OPTION_VALUE_PATTERN)) {
    if (isSensitiveCredentialName(match[2] ?? "")) {
      return true;
    }
  }
  return [...value.matchAll(AUTHORIZATION_HEADER_PATTERN)].length > 0;
}

export function containsSensitiveArgs(args: readonly string[]): boolean {
  let sensitiveValueFollows = false;
  for (const argument of args) {
    if (sensitiveValueFollows || containsSensitiveCredentials(argument)) {
      return true;
    }
    sensitiveValueFollows = isSensitiveValueOption(argument);
  }
  return false;
}

function redactReason(reason: CliReason): CliReason {
  return {
    ...reason,
    message: redactSensitiveText(reason.message),
    ...(reason.suggestion === undefined
      ? {}
      : { suggestion: redactSensitiveText(reason.suggestion) })
  };
}

/** Return a sanitized copy suitable for every CLI output channel. */
export function redactCliResult(result: CliResult): CliResult {
  return {
    ...result,
    command: redactSensitiveArgs(result.command),
    commandString: redactSensitiveText(result.commandString),
    exitCodeMeaning: redactSensitiveText(result.exitCodeMeaning),
    ...(result.configPath === undefined
      ? {}
      : { configPath: redactSensitiveText(result.configPath) }),
    ...(result.configLabel === undefined
      ? {}
      : { configLabel: redactSensitiveText(result.configLabel) }),
    reasons: result.reasons.map(redactReason),
    summary: redactSensitiveText(result.summary),
    warnings: result.warnings.map(redactSensitiveText),
    infos: result.infos.map(redactSensitiveText),
    affectedPackages: result.affectedPackages.map((affectedPackage) => ({
      ...affectedPackage,
      name: redactSensitiveText(affectedPackage.name),
      requested: redactSensitiveText(affectedPackage.requested),
      ...(affectedPackage.resolvedVersion === undefined
        ? {}
        : { resolvedVersion: redactSensitiveText(affectedPackage.resolvedVersion) }),
      reasons: affectedPackage.reasons.map(redactReason),
      warnings: affectedPackage.warnings.map(redactSensitiveText),
      infos: affectedPackage.infos.map(redactSensitiveText)
    })),
    ...(result.execution === undefined
      ? {}
      : {
          execution: {
            ...result.execution,
            ...(result.execution.stdout === undefined
              ? {}
              : { stdout: redactSensitiveText(result.execution.stdout) }),
            ...(result.execution.stderr === undefined
              ? {}
              : { stderr: redactSensitiveText(result.execution.stderr) })
          }
        })
  };
}
