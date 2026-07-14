import { Effect } from "effect";
import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_FONTS, fontCatalog } from "./font-catalog";

describe("fontCatalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares in-flight initialization with concurrent callers", async () => {
    vi.stubGlobal("indexedDB", indexedDB);
    let resolveFetch!: (response: object) => void;
    const fetchPromise = new Promise<object>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => fetchPromise);
    vi.stubGlobal("fetch", fetchMock);

    const first = Effect.runPromise(fontCatalog.init());
    const second = Effect.runPromise(fontCatalog.init());
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    resolveFetch({
      ok: true,
      json: async () =>
        BUILTIN_FONTS.map((family) => ({
          id: family.id,
          family: family.name,
          subsets: ["latin"],
          weights: family.weights,
          styles: family.styles,
          category:
            family.category === "sans"
              ? "sans-serif"
              : family.category === "mono"
                ? "monospace"
                : family.category,
          type: "google",
        })),
    });

    await Promise.all([first, second]);
  });
});
