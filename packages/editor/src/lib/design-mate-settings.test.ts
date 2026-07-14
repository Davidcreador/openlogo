import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_DEFAULT_BASE_URL,
  validateDesignMateProviderSettings,
} from "./design-mate-settings";

describe("validateDesignMateProviderSettings", () => {
  it("accepts a key and model, defaulting the base URL", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "sk-test-123",
      model: "gpt-4o-mini",
      baseUrl: "",
    });
    expect(result).toEqual({
      settings: {
        apiKey: "sk-test-123",
        model: "gpt-4o-mini",
        baseUrl: DESIGN_MATE_DEFAULT_BASE_URL,
      },
    });
  });

  it("trims surrounding whitespace before validating", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "  sk-test-123  ",
      model: " gpt-4o-mini ",
      baseUrl: ` ${DESIGN_MATE_DEFAULT_BASE_URL} `,
    });
    expect("settings" in result && result.settings.apiKey).toBe("sk-test-123");
  });

  it("rejects a missing API key", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "",
      model: "gpt-4o-mini",
      baseUrl: "",
    });
    expect(result).toEqual({ error: "Enter the provider API key." });
  });

  it("rejects a missing model", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "sk-test-123",
      model: "",
      baseUrl: "",
    });
    expect(result).toEqual({ error: "Enter the model name." });
  });

  it("rejects a non-HTTPS base URL", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "sk-test-123",
      model: "gpt-4o-mini",
      baseUrl: "ftp://example.com/v1",
    });
    expect("error" in result).toBe(true);
  });

  it("rejects control characters in the key", () => {
    const result = validateDesignMateProviderSettings({
      apiKey: "sk-bad\u0000key",
      model: "gpt-4o-mini",
      baseUrl: "",
    });
    expect("error" in result).toBe(true);
  });
});
