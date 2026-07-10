import { isIP } from "node:net";
import { normalizeOpenAIResponsesBaseUrl } from "./openai-responses";

export const DESIGN_MATE_SERVICE_VERSION = "0.1.0";

export const DESIGN_MATE_SERVICE_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8_787,
  maxBodyBytes: 3 * 1_024 * 1_024,
  maxJsonDepth: 32,
  rateLimitRequestsPerMinute: 30,
  requestTimeoutMs: 90_000,
  upstreamTimeoutMs: 60_000,
  providerBaseUrl: "https://api.openai.com/v1",
  providerImageDetail: "auto" as const,
} as const);

export type DesignMateProviderConfig = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly imageDetail: "low" | "auto";
};

export type DesignMateServiceConfig = {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes: number;
  readonly maxJsonDepth: number;
  readonly rateLimitRequestsPerMinute: number;
  readonly requestTimeoutMs: number;
  readonly upstreamTimeoutMs: number;
  readonly serviceToken?: string;
  readonly provider?: DesignMateProviderConfig;
};

export type DesignMateServiceEnvironment = Readonly<
  Record<string, string | undefined>
>;

type ValidateConfigOptions = {
  readonly allowEphemeralPort: boolean;
  readonly hasInjectedAuth: boolean;
  readonly requireProvider: boolean;
};

function readEnvironmentValue(
  environment: DesignMateServiceEnvironment,
  names: readonly string[],
): string | undefined {
  let selected: string | undefined;
  for (const name of names) {
    const value = environment[name];
    if (value === undefined) {
      continue;
    }
    if (selected !== undefined && selected !== value) {
      throw new TypeError("Conflicting Design Mate service settings.");
    }
    selected = value;
  }
  return selected;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return parsed;
}

function validateHost(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f/:?#@\[\]]/.test(value)
  ) {
    if (typeof value === "string" && isIP(value) !== 0) {
      return value.toLowerCase();
    }
    throw new TypeError("The service host is invalid.");
  }
  if (
    isIP(value) === 0 &&
    value.toLowerCase() !== "localhost" &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      value,
    )
  ) {
    throw new TypeError("The service host is invalid.");
  }
  return value.toLowerCase();
}

export function isLoopbackHost(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:127.") ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

export function isLoopbackRemoteAddress(
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  const withoutZone = value.split("%", 1)[0]?.toLowerCase() ?? "";
  return (
    withoutZone === "::1" ||
    withoutZone.startsWith("::ffff:127.") ||
    (isIP(withoutZone) === 4 && withoutZone.startsWith("127."))
  );
}

function normalizeOrigin(value: string): string {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    value === "*" ||
    value === "null"
  ) {
    throw new TypeError("A configured allowed origin is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("A configured allowed origin is invalid.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.origin !== value
  ) {
    throw new TypeError("A configured allowed origin is invalid.");
  }
  return parsed.origin;
}

function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    return Object.freeze([]);
  }
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0) || parts.length > 64) {
    throw new TypeError("The configured allowed origins are invalid.");
  }
  const normalized = parts.map(normalizeOrigin);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("The configured allowed origins are invalid.");
  }
  return Object.freeze(normalized);
}

function validateServiceToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("The configured service token is invalid.");
  }
  return value;
}

function validateProviderText(
  value: unknown,
  label: "API key" | "model",
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`A valid provider ${label} is required.`);
  }
  return value;
}

function validateIntegerConfig(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function validateDesignMateServiceConfig(
  config: DesignMateServiceConfig,
  options: Partial<ValidateConfigOptions> = {},
): DesignMateServiceConfig {
  const allowEphemeralPort = options.allowEphemeralPort ?? true;
  const hasInjectedAuth = options.hasInjectedAuth ?? false;
  const requireProvider = options.requireProvider ?? false;
  const host = validateHost(config.host);
  const port = validateIntegerConfig(
    config.port,
    allowEphemeralPort ? 0 : 1,
    65_535,
    "The service port",
  );
  if (
    !Array.isArray(config.allowedOrigins) ||
    config.allowedOrigins.length > 64
  ) {
    throw new TypeError("The configured allowed origins are invalid.");
  }
  const allowedOrigins = config.allowedOrigins.map((origin) =>
    normalizeOrigin(origin),
  );
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new TypeError("The configured allowed origins are invalid.");
  }
  const maxBodyBytes = validateIntegerConfig(
    config.maxBodyBytes,
    1_024,
    16 * 1_024 * 1_024,
    "The request body limit",
  );
  const maxJsonDepth = validateIntegerConfig(
    config.maxJsonDepth,
    4,
    128,
    "The JSON depth limit",
  );
  const rateLimitRequestsPerMinute = validateIntegerConfig(
    config.rateLimitRequestsPerMinute,
    1,
    10_000,
    "The rate limit",
  );
  const requestTimeoutMs = validateIntegerConfig(
    config.requestTimeoutMs,
    1,
    10 * 60_000,
    "The request timeout",
  );
  const upstreamTimeoutMs = validateIntegerConfig(
    config.upstreamTimeoutMs,
    1,
    10 * 60_000,
    "The upstream timeout",
  );
  const serviceToken =
    config.serviceToken === undefined
      ? undefined
      : validateServiceToken(config.serviceToken);

  if (
    serviceToken === undefined &&
    !isLoopbackHost(host) &&
    !hasInjectedAuth
  ) {
    throw new TypeError(
      "A service token or injected request auth is required for a non-loopback bind.",
    );
  }

  let provider: DesignMateProviderConfig | undefined;
  if (config.provider !== undefined) {
    const imageDetail = config.provider.imageDetail;
    if (imageDetail !== "low" && imageDetail !== "auto") {
      throw new TypeError("The provider image detail is invalid.");
    }
    provider = Object.freeze({
      apiKey: validateProviderText(
        config.provider.apiKey,
        "API key",
        8_192,
      ),
      baseUrl: normalizeOpenAIResponsesBaseUrl(config.provider.baseUrl),
      model: validateProviderText(config.provider.model, "model", 256),
      imageDetail,
    });
  } else if (requireProvider) {
    throw new TypeError("Provider configuration is required.");
  }

  return Object.freeze({
    host,
    port,
    allowedOrigins: Object.freeze(allowedOrigins),
    maxBodyBytes,
    maxJsonDepth,
    rateLimitRequestsPerMinute,
    requestTimeoutMs,
    upstreamTimeoutMs,
    ...(serviceToken === undefined ? {} : { serviceToken }),
    ...(provider === undefined ? {} : { provider }),
  });
}

export function loadDesignMateServiceConfig(
  environment: DesignMateServiceEnvironment,
): DesignMateServiceConfig {
  const host =
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_HOST",
      "DESIGN_MATE_HOST",
    ]) ?? DESIGN_MATE_SERVICE_DEFAULTS.host;
  const port = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_PORT",
      "DESIGN_MATE_PORT",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.port,
    1,
    65_535,
    "The service port",
  );
  const allowedOrigins = parseAllowedOrigins(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_ALLOWED_ORIGINS",
      "DESIGN_MATE_ALLOWED_ORIGINS",
    ]),
  );
  const maxBodyBytes = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_MAX_BODY_BYTES",
      "DESIGN_MATE_MAX_BODY_BYTES",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.maxBodyBytes,
    1_024,
    16 * 1_024 * 1_024,
    "The request body limit",
  );
  const maxJsonDepth = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_MAX_JSON_DEPTH",
      "DESIGN_MATE_MAX_JSON_DEPTH",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.maxJsonDepth,
    4,
    128,
    "The JSON depth limit",
  );
  const rateLimitRequestsPerMinute = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_RATE_LIMIT_REQUESTS_PER_MINUTE",
      "DESIGN_MATE_RATE_LIMIT_REQUESTS_PER_MINUTE",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.rateLimitRequestsPerMinute,
    1,
    10_000,
    "The rate limit",
  );
  const requestTimeoutMs = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_REQUEST_TIMEOUT_MS",
      "DESIGN_MATE_REQUEST_TIMEOUT_MS",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.requestTimeoutMs,
    1,
    10 * 60_000,
    "The request timeout",
  );
  const upstreamTimeoutMs = parseInteger(
    readEnvironmentValue(environment, [
      "DESIGN_MATE_SERVICE_UPSTREAM_TIMEOUT_MS",
      "DESIGN_MATE_UPSTREAM_TIMEOUT_MS",
    ]),
    DESIGN_MATE_SERVICE_DEFAULTS.upstreamTimeoutMs,
    1,
    10 * 60_000,
    "The upstream timeout",
  );
  const serviceTokenValue = readEnvironmentValue(environment, [
    "DESIGN_MATE_SERVICE_TOKEN",
  ]);
  const serviceToken =
    serviceTokenValue === undefined
      ? undefined
      : validateServiceToken(serviceTokenValue);

  const apiKey = validateProviderText(
    readEnvironmentValue(environment, ["DESIGN_MATE_PROVIDER_API_KEY"]),
    "API key",
    8_192,
  );
  const model = validateProviderText(
    readEnvironmentValue(environment, ["DESIGN_MATE_PROVIDER_MODEL"]),
    "model",
    256,
  );
  const baseUrl = normalizeOpenAIResponsesBaseUrl(
    readEnvironmentValue(environment, ["DESIGN_MATE_PROVIDER_BASE_URL"]) ??
      DESIGN_MATE_SERVICE_DEFAULTS.providerBaseUrl,
  );
  const imageDetail =
    readEnvironmentValue(environment, [
      "DESIGN_MATE_PROVIDER_IMAGE_DETAIL",
    ]) ?? DESIGN_MATE_SERVICE_DEFAULTS.providerImageDetail;
  if (imageDetail !== "low" && imageDetail !== "auto") {
    throw new TypeError("The provider image detail is invalid.");
  }

  return validateDesignMateServiceConfig(
    {
      host,
      port,
      allowedOrigins,
      maxBodyBytes,
      maxJsonDepth,
      rateLimitRequestsPerMinute,
      requestTimeoutMs,
      upstreamTimeoutMs,
      ...(serviceToken === undefined ? {} : { serviceToken }),
      provider: {
        apiKey,
        baseUrl,
        model,
        imageDetail,
      },
    },
    {
      allowEphemeralPort: false,
      hasInjectedAuth: false,
      requireProvider: true,
    },
  );
}
