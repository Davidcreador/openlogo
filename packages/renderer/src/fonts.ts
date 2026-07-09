import type { CanvasKit, TypefaceFontProvider } from "canvaskit-wasm";

/**
 * Font registry backing the Paragraph API. Skia cannot see system fonts,
 * so every family used by text nodes must be registered from raw TTF/OTF
 * bytes (variable fonts supported) before it renders.
 */
export class FontRegistry {
  readonly provider: TypefaceFontProvider;
  private families = new Set<string>();

  constructor(canvasKit: CanvasKit) {
    this.provider = canvasKit.TypefaceFontProvider.Make();
  }

  register(family: string, data: ArrayBuffer): void {
    this.provider.registerFont(data, family);
    this.families.add(family.toLowerCase());
  }

  /**
   * Resolve a CSS-ish stack ("Inter, ui-sans-serif, sans-serif") to the
   * first registered family, falling back to any registered family.
   */
  resolveFamily(fontFamily: string): string | null {
    const parts = fontFamily
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""));

    for (const part of parts) {
      if (this.families.has(part.toLowerCase())) {
        return part;
      }
    }

    const first = this.families.values().next();
    return first.done ? null : first.value;
  }

  get isEmpty(): boolean {
    return this.families.size === 0;
  }

  /** Free the wasm-side provider and every typeface registered on it. */
  dispose(): void {
    this.provider.delete();
    this.families.clear();
  }
}
