import { normalizeOpenAIResponsesBaseUrl } from "@openlogo/design-mate";

/**
 * In-app Design Mate provider settings. Stored in this browser only
 * (localStorage) so the agent works without env vars or a relay service.
 */
export type DesignMateProviderSettings = {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
};

const DESIGN_MATE_SETTINGS_STORAGE_KEY = "openlogo:design-mate-provider";

export const DESIGN_MATE_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DESIGN_MATE_DEFAULT_MODEL = "gpt-4.1-mini";

const listeners = new Set<() => void>();
let cached: DesignMateProviderSettings | null | undefined;

function providerText(value: unknown, maximumLength: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

/** Returns the validated settings or an error message per field. */
export function validateDesignMateProviderSettings(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
}): { settings: DesignMateProviderSettings } | { error: string } {
  const apiKey = providerText(input.apiKey.trim(), 8_192);
  if (!apiKey) {
    return { error: "Enter the provider API key." };
  }
  const model = providerText(input.model.trim(), 256);
  if (!model) {
    return { error: "Enter the model name." };
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeOpenAIResponsesBaseUrl(
      input.baseUrl.trim() || DESIGN_MATE_DEFAULT_BASE_URL,
    );
  } catch {
    return { error: "The base URL must be an HTTPS OpenAI-compatible endpoint." };
  }
  return { settings: { apiKey, model, baseUrl } };
}

function parseStored(raw: string): DesignMateProviderSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const result = validateDesignMateProviderSettings({
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    model: typeof record.model === "string" ? record.model : "",
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
  });
  return "settings" in result ? result.settings : null;
}

export function loadDesignMateProviderSettings(): DesignMateProviderSettings | null {
  if (cached !== undefined) {
    return cached;
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DESIGN_MATE_SETTINGS_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode); treat as unconfigured.
  }
  cached = raw === null ? null : parseStored(raw);
  return cached;
}

export function saveDesignMateProviderSettings(
  settings: DesignMateProviderSettings,
): void {
  try {
    window.localStorage.setItem(
      DESIGN_MATE_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  cached = settings;
  for (const listener of listeners) {
    listener();
  }
}

export function clearDesignMateProviderSettings(): void {
  try {
    window.localStorage.removeItem(DESIGN_MATE_SETTINGS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the in-memory value is what matters.
  }
  cached = null;
  for (const listener of listeners) {
    listener();
  }
}

/** React 18 useSyncExternalStore-compatible subscription. */
export function subscribeDesignMateProviderSettings(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
