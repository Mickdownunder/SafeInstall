const INVALID_REGISTRY_URL = "Config error: registryUrl must be a valid http or https URL.";
const UNSUPPORTED_REGISTRY_PROTOCOL = "Config error: registryUrl must use http or https.";
const SENSITIVE_REGISTRY_URL =
  "Config error: registryUrl must not contain credentials, query parameters, or fragments. " +
  "Configure private-registry authentication through an environment-backed .npmrc file.";

/**
 * Parse a registry URL and reject components that could carry credentials
 * (userinfo, query, fragment). Node's fetch refuses credentialed URLs anyway,
 * so such a registry never worked for SafeInstall's own metadata requests; this
 * turns the failure into a clear error that does not echo the URL. Used at
 * config load and again at the persistence and spawn sinks as defense in depth
 * for configs built without loadConfig().
 */
export function requireCredentialFreeRegistryUrl(input: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error(INVALID_REGISTRY_URL);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(UNSUPPORTED_REGISTRY_PROTOCOL);
  }

  if (
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new Error(SENSITIVE_REGISTRY_URL);
  }
  return parsedUrl;
}
