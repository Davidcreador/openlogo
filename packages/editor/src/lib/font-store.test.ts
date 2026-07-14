import { afterEach, describe, expect, it, vi } from "vitest";
import { fontStore } from "./font-store";

vi.mock("./opentype-loader", async () => {
  const { Effect } = await import("effect");
  return {
    opentypeModule: Effect.succeed({
      parse: () => ({
        unitsPerEm: 1000,
        charToGlyph: () => ({ index: 0 }),
        getKerningValue: () => 0,
      }),
    }),
  };
});

class TestFontFace {
  load(): Promise<TestFontFace> {
    return Promise.resolve(this);
  }
}

describe("fontStore renderer registration", () => {
  afterEach(() => {
    fontStore.detach();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers cached faces when a replacement renderer attaches", async () => {
    const bytes = new ArrayBuffer(8);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes,
    })));
    vi.stubGlobal("FontFace", TestFontFace);
    vi.stubGlobal("document", { fonts: { add: vi.fn() } });

    await fontStore.ensure("Bebas Neue", 400);

    const registry = {
      register: vi.fn(),
      setKerning: vi.fn(),
    };
    const renderer = {
      invalidate: vi.fn(),
      invalidateFonts: vi.fn(),
    };
    fontStore.attach(registry, renderer);

    expect(registry.register).toHaveBeenCalledWith(
      "Bebas Neue",
      expect.any(ArrayBuffer),
      400,
      "normal",
    );
  });

  it("invalidates font-bound render caches when a face loads", async () => {
    const bytes = new ArrayBuffer(8);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes,
    })));
    vi.stubGlobal("FontFace", TestFontFace);
    vi.stubGlobal("document", { fonts: { add: vi.fn() } });

    const registry = {
      register: vi.fn(),
      setKerning: vi.fn(),
    };
    const renderer = {
      invalidate: vi.fn(),
      invalidateFonts: vi.fn(),
    };
    fontStore.attach(registry, renderer);

    await fontStore.ensure("DM Serif Display", 400, "italic");

    expect(renderer.invalidateFonts).toHaveBeenCalled();
  });
});
