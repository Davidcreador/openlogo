import { describe, expect, it } from "vitest";
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

function injectedConfig(
  overrides: Partial<DesignMateServiceConfig> = {},
): DesignMateServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    maxBodyBytes: DESIGN_MATE_SERVICE_DEFAULTS.maxBodyBytes,
    maxJsonDepth: DESIGN_MATE_SERVICE_DEFAULTS.maxJsonDepth,
    rateLimitRequestsPerMinute: 10,
    requestTimeoutMs: 5_000,
    upstreamTimeoutMs: 2_000,
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

    const config = loadDesignMateServiceConfig(PROVIDER_ENV);
    expect(config.provider).toMatchObject({
      model: "test-required-model",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8_787);
  });

  it("rejects unauthenticated public binds but accepts injected test config", () => {
    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
        DESIGN_MATE_SERVICE_HOST: "0.0.0.0",
      }),
    ).toThrow(/service token or injected request auth/i);

    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
        DESIGN_MATE_SERVICE_HOST: "0.0.0.0",
        DESIGN_MATE_SERVICE_TOKEN: "service-token",
      }),
    ).not.toThrow();

    expect(
      validateDesignMateServiceConfig(injectedConfig()),
    ).toMatchObject({ port: 0, host: "127.0.0.1" });
  });

  it.each([
    ["DESIGN_MATE_SERVICE_PORT", "0"],
    ["DESIGN_MATE_SERVICE_PORT", "65536"],
    ["DESIGN_MATE_SERVICE_MAX_BODY_BYTES", "100"],
    ["DESIGN_MATE_SERVICE_MAX_JSON_DEPTH", "3"],
    ["DESIGN_MATE_SERVICE_RATE_LIMIT_REQUESTS_PER_MINUTE", "0"],
    ["DESIGN_MATE_SERVICE_REQUEST_TIMEOUT_MS", "-1"],
    ["DESIGN_MATE_SERVICE_UPSTREAM_TIMEOUT_MS", "Infinity"],
  ] as const)("rejects invalid numeric setting %s", (name, value) => {
    expect(() =>
      loadDesignMateServiceConfig({
        ...PROVIDER_ENV,
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
        ...PROVIDER_ENV,
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
        ...PROVIDER_ENV,
        DESIGN_MATE_PROVIDER_BASE_URL: baseUrl,
      }),
    ).toThrow(/base URL/i);
  });
});
