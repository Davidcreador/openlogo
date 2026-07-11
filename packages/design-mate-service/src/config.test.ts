import { describe, expect, it } from "vitest";
import { DESIGN_MATE_CHAT_LIMITS } from "@openlogo/design-mate";
import {
  DESIGN_MATE_SERVICE_DEFAULTS,
  loadDesignMateServiceConfig,
  validateDesignMateServiceConfig,
  type DesignMateServiceConfig,
} from "./index";

const PROVIDER_ENV = {
  DESIGN_MATE_PROVIDER_API_KEY: "test-provider-key",
  DESIGN_MATE_PROVIDER_MODEL: "test-required-model",
} as const;
const AUTHENTICATED_PROVIDER_ENV = {
  ...PROVIDER_ENV,
  DESIGN_MATE_SERVICE_TOKEN: "server-injected-token",
} as const;

function injectedConfig(
  overrides: Partial<DesignMateServiceConfig> = {},
): DesignMateServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowAnonymousLoopback: false,
    allowedOrigins: [],
    maxBodyBytes: DESIGN_MATE_SERVICE_DEFAULTS.maxBodyBytes,
    maxJsonDepth: DESIGN_MATE_SERVICE_DEFAULTS.maxJsonDepth,
    rateLimitRequestsPerMinute: 10,
    maxConcurrentRequests:
      DESIGN_MATE_SERVICE_DEFAULTS.maxConcurrentRequests,
    maxConcurrentRequestsPerSubject:
      DESIGN_MATE_SERVICE_DEFAULTS.maxConcurrentRequestsPerSubject,
    requestTimeoutMs: 5_000,
    upstreamTimeoutMs: 2_000,
    upstreamRetryAttempts: 1,
    ...overrides,
  };
}

describe("Design Mate service config", () => {
  it("requires explicit provider credentials and never defaults a model", () => {
    expect(() => loadDesignMateServiceConfig({})).toThrow(
      /provider API key/i,
    );
    expect(() =>
      loadDesignMateServiceConfig({
        DESIGN_MATE_PROVIDER_API_KEY: "key-only",
      }),
    ).toThrow(/provider model/i);

    const config = loadDesignMateServiceConfig(
      AUTHENTICATED_PROVIDER_ENV,
    );
    expect(config.provider).toMatchObject({
      model: "test-required-model",
      baseUrl: "https://api.openai.com/v1",
      maxOutputTokens: 1_200,
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8_787);
    expect(config.allowAnonymousLoopback).toBe(false);
    expect(config.maxBodyBytes).toBe(
      DESIGN_MATE_CHAT_LIMITS.wireSerializedBytes,
    );
  });

  it("requires explicit auth even on loopback and tightly gates anonymous opt-in", () => {
    expect(() => loadDesignMateServiceConfig(PROVIDER_ENV)).toThrow(
      /service token, injected request auth, or explicit anonymous loopback/i,
    );
    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
        DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK: "true",
      }),
    ).not.toThrow();
    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
        DESIGN_MATE_SERVICE_HOST: "0.0.0.0",
        DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK: "true",
      }),
    ).toThrow(/loopback service host/i);

    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
        DESIGN_MATE_SERVICE_HOST: "0.0.0.0",
        DESIGN_MATE_SERVICE_TOKEN: "service-token",
      }),
    ).not.toThrow();

    expect(
      validateDesignMateServiceConfig(injectedConfig(), {
        hasInjectedAuth: true,
      }),
    ).toMatchObject({ port: 0, host: "127.0.0.1" });
    expect(() =>
      validateDesignMateServiceConfig(injectedConfig()),
    ).toThrow(/explicit anonymous loopback/i);
  });

  it.each(["TRUE", "1", "yes", " true", "false "])(
    "rejects non-strict anonymous loopback boolean %s",
    (value) => {
      expect(() =>
        loadDesignMateServiceConfig({
          ...PROVIDER_ENV,
          DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK: value,
        }),
      ).toThrow(/anonymous loopback setting/i);
    },
  );

  it("loads bounded concurrency and provider output-token settings", () => {
    const loaded = loadDesignMateServiceConfig({
      ...AUTHENTICATED_PROVIDER_ENV,
      DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS: "12",
      DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS_PER_SUBJECT: "3",
      DESIGN_MATE_SERVICE_UPSTREAM_RETRY_ATTEMPTS: "2",
      DESIGN_MATE_PROVIDER_MAX_OUTPUT_TOKENS: "2400",
    });
    expect(loaded).toMatchObject({
      maxConcurrentRequests: 12,
      maxConcurrentRequestsPerSubject: 3,
      upstreamRetryAttempts: 2,
      provider: { maxOutputTokens: 2_400 },
    });
  });

  it.each([
    ["DESIGN_MATE_SERVICE_PORT", "0"],
    ["DESIGN_MATE_SERVICE_PORT", "65536"],
    ["DESIGN_MATE_SERVICE_MAX_BODY_BYTES", "100"],
    ["DESIGN_MATE_SERVICE_MAX_JSON_DEPTH", "3"],
    ["DESIGN_MATE_SERVICE_RATE_LIMIT_REQUESTS_PER_MINUTE", "0"],
    ["DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS", "0"],
    [
      "DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS_PER_SUBJECT",
      "1001",
    ],
    ["DESIGN_MATE_SERVICE_REQUEST_TIMEOUT_MS", "-1"],
    ["DESIGN_MATE_SERVICE_UPSTREAM_TIMEOUT_MS", "Infinity"],
    ["DESIGN_MATE_SERVICE_UPSTREAM_RETRY_ATTEMPTS", "3"],
    ["DESIGN_MATE_PROVIDER_MAX_OUTPUT_TOKENS", "15"],
    ["DESIGN_MATE_PROVIDER_MAX_OUTPUT_TOKENS", "16001"],
  ] as const)("rejects invalid numeric setting %s", (name, value) => {
    expect(() =>
      loadDesignMateServiceConfig({
        ...AUTHENTICATED_PROVIDER_ENV,
        [name]: value,
      }),
    ).toThrow();
  });

  it.each([
    "https://allowed.example/path",
    "https://allowed.example/",
    "*",
    "null",
    "file:///tmp/test",
  ])("rejects non-origin allowlist value %s", (origin) => {
    expect(() =>
      loadDesignMateServiceConfig({
        ...AUTHENTICATED_PROVIDER_ENV,
        DESIGN_MATE_SERVICE_ALLOWED_ORIGINS: origin,
      }),
    ).toThrow(/origin/i);
  });

  it.each([
    "not a url",
    "http://provider.example/v1",
    "https://user:pass@provider.example/v1",
    "https://provider.example/v1?secret=value",
  ])("rejects unsafe provider base URL %s", (baseUrl) => {
    expect(() =>
      loadDesignMateServiceConfig({
        ...AUTHENTICATED_PROVIDER_ENV,
        DESIGN_MATE_PROVIDER_BASE_URL: baseUrl,
      }),
    ).toThrow(/base URL/i);
  });
});
