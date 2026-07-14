import type { CanvasKit, Typeface, TypefaceFontProvider } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import { FontRegistry } from "./fonts";

describe("FontRegistry", () => {
  it("returns the canonical registered family for quoted case-insensitive input", () => {
    const provider = {
      registerFont: vi.fn(),
      delete: vi.fn(),
    } as unknown as TypefaceFontProvider;
    const typeface = { delete: vi.fn() } as unknown as Typeface;
    const canvasKit = {
      TypefaceFontProvider: { Make: () => provider },
      Typeface: { MakeTypefaceFromData: () => typeface },
    } as unknown as CanvasKit;
    const registry = new FontRegistry(canvasKit);

    registry.register("Work Sans", new ArrayBuffer(8));

    expect(registry.resolveFamily('"work sans", sans-serif')).toBe("Work Sans");
    registry.dispose();
  });
});
