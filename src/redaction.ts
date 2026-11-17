import type { CliReason, CliResult } from "./types";

export const REDACTED_CREDENTIAL = "[REDACTED]";

// Detection is structural. Only three shapes count as credentials:
//   1. userinfo in the authority of a URL with a known scheme,
//   2. a small set of exactly named parameters in a URL query string,
//   3. npm-style credential flags (`--//host/:_authToken=...`, `--otp=...`).
// Anything else (version ranges, package names, free text, `key=value`) is
// never a credential for this module.
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/giu;
const URL_AUTHORITY_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/iu;
const FLAG_ASSIGNMENT_PATTERN = /(^|[\s'"])(--[^\s=]+)=("[^"]*"|'[^']*'|[^\s'"]*)/gu;
const FLAG_SPLIT_PATTERN = /(^|[\s'"])(--[^\s=]+)(\s+)("[^"]*"|'[^']*'|[^\s'"]+)/gu;

const USERINFO_SCHEMES = new Set(["http", "https", "git+http", "git+https", "git"]);
const SSH_SCHEMES = new Set(["ssh", "git+ssh"]);
const SENSITIVE_QUERY_PARAMETERS = new Set([
  "token",
  "access_token",
  "auth",
  "auth_token",
  "authtoken",
  "api_key",
  "apikey",
  "key",
  "password",
  "passwd",
  "secret",
  "signature",
  "sig",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "private_token",
  "jwt"
]);
const SENSITIVE_FLAG_PATTERN =
  /^--(?:\/\/\S*:(?:_authToken|_auth|_password|username)|_authToken|_auth|_password|password|otp)$/iu;

function decodeName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}

function isSensitiveQueryName(name: string): boolean {
  return SENSITIVE_QUERY_PARAMETERS.has(decodeName(name).toLowerCase());
}

function isSensitiveFlag(flag: string): boolean {
  return SENSITIVE_FLAG_PATTERN.test(flag);
}

function isCredentialUserinfo(scheme: string, userinfo: string): boolean {
  if (userinfo.length === 0) {
    return false;
  }
  const normalized = scheme.replace(/:\/\/$/u, "").toLowerCase();
  if (USERINFO_SCHEMES.has(normalized)) {
    return true;
  }
  if (SSH_SCHEMES.has(normalized)) {
    return userinfo.includes(":") || /%3a/iu.test(userinfo);
  }
  return false;
}

interface Scan {
  text: string;
  found: boolean;
}

function scanUrl(url: string): Scan {
  let found = false;
  let result = url;

  const authority = URL_AUTHORITY_PATTERN.exec(url);
  if (authority) {
    const scheme = authority[1] ?? "";
    const authorityText = authority[2] ?? "";
    const at = authorityText.lastIndexOf("@");
    if (at > 0 && isCredentialUserinfo(scheme, authorityText.slice(0, at))) {
      found = true;
      result = `${scheme}${REDACTED_CREDENTIAL}${url.slice(scheme.length + at)}`;
    }
  }

  const queryStart = result.indexOf("?");
  if (queryStart !== -1) {
    const fragmentStart = result.indexOf("#", queryStart);
    const queryEnd = fragmentStart === -1 ? result.length : fragmentStart;
    const query = result.slice(queryStart + 1, queryEnd);
    const redactedQuery = query
      .split("&")
      .map((pair) => {
        const equals = pair.indexOf("=");
        if (equals <= 0 || !isSensitiveQueryName(pair.slice(0, equals))) {
          return pair;
        }
        found = true;
        return `${pair.slice(0, equals + 1)}${REDACTED_CREDENTIAL}`;
      })
      .join("&");
    result = `${result.slice(0, queryStart + 1)}${redactedQuery}${result.slice(queryEnd)}`;
  }

  return { text: result, found };
}

function scanText(value: string): Scan {
  let found = false;

  let text = value.replace(URL_PATTERN, (url) => {
    const scan = scanUrl(url);
    found ||= scan.found;
    return scan.text;
  });
  text = text.replace(FLAG_ASSIGNMENT_PATTERN, (match, prefix: string, flag: string) => {
    if (!isSensitiveFlag(flag)) {
      return match;
    }
    found = true;
    return `${prefix}${flag}=${REDACTED_CREDENTIAL}`;
  });
  text = text.replace(
    FLAG_SPLIT_PATTERN,
    (match, prefix: string, flag: string, spacing: string) => {
      if (!isSensitiveFlag(flag)) {
        return match;
      }
      found = true;
      return `${prefix}${flag}${spacing}${REDACTED_CREDENTIAL}`;
    }
  );
  return { text, found };
}

/** Redact credentials from text that may be copied into logs or records. */
export function redactSensitiveText(value: string): string {
  return scanText(value).text;
}

/** Redact both inline assignments and `--secret value` argument pairs. */
export function redactSensitiveArgs(args: readonly string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_CREDENTIAL;
    }
    redactNext = isSensitiveFlag(argument);
    return redactSensitiveText(argument);
  });
}

export function containsSensitiveCredentials(value: string): boolean {
  return scanText(value).found;
}

export function containsSensitiveArgs(args: readonly string[]): boolean {
  let sensitiveValueFollows = false;
  for (const argument of args) {
    if (sensitiveValueFollows || containsSensitiveCredentials(argument)) {
      return true;
    }
    sensitiveValueFollows = isSensitiveFlag(argument);
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
