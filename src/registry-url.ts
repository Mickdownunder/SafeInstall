const INVALID_REGISTRY_URL = "Config error: registryUrl must be a valid http or https URL.";
const UNSUPPORTED_REGISTRY_PROTOCOL = "Config error: registryUrl must use http or https.";
const SENSITIVE_REGISTRY_URL =
  "Config error: registryUrl must not contain credentials, query parameters, or fragments. " +
  "Configure private-registry authentication through an environment-backed .npmrc file.";

function parseRegistryUrl(input: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error(INVALID_REGISTRY_URL);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(UNSUPPORTED_REGISTRY_PROTOCOL);
  }

  return parsedUrl;
}

function hasSensitiveComponents(parsedUrl: URL): boolean {
  return (
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  );
}

/**
 * Parse a registry URL and reject components that could carry credentials.
 * Callers at output or execution sinks use this as defense in depth when a
 * SafeInstallConfig was constructed without going through loadConfig().
 */
export function requireCredentialFreeRegistryUrl(input: string): URL {
  const parsedUrl = parseRegistryUrl(input);
  if (hasSensitiveComponents(parsedUrl)) {
    throw new Error(SENSITIVE_REGISTRY_URL);
  }
  return parsedUrl;
}

/** Remove every URL component that can carry registry authority material. */
export function redactRegistryUrl(input: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = parseRegistryUrl(input);
  } catch {
    return "[redacted invalid registry URL]";
  }

  if (!hasSensitiveComponents(parsedUrl)) {
    return input;
  }

  parsedUrl.username = "";
  parsedUrl.password = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString();
}

const REGISTRY_URL_FLAGS = ["--registry", "--allow-registry"] as const;

/** Reject credential-bearing package-manager registry arguments before spawn. */
export function requireCredentialFreeRegistryUrlArguments(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--registry" && args[index + 1] !== undefined) {
      requireCredentialFreeRegistryUrl(args[index + 1]!);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--registry=")) {
      requireCredentialFreeRegistryUrl(argument.slice("--registry=".length));
    }
  }
}

/** Redact spaced and equals spellings of every supported registry URL flag. */
export function redactRegistryUrlArguments(args: readonly string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    const argument = redacted[index];
    for (const flag of REGISTRY_URL_FLAGS) {
      if (argument === flag && redacted[index + 1] !== undefined) {
        redacted[index + 1] = redactRegistryUrl(redacted[index + 1]!);
        index += 1;
        break;
      }
      if (argument?.startsWith(`${flag}=`)) {
        redacted[index] = `${flag}=${redactRegistryUrl(argument.slice(flag.length + 1))}`;
        break;
      }
    }
  }
  return redacted;
}
