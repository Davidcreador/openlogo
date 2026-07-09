import type { CanvasKit, Typeface, TypefaceFontProvider } from "canvaskit-wasm";

/**
 * Font registry backing the Paragraph API. Skia cannot see system fonts,
 * so every family used by text nodes must be registered from raw TTF/OTF
 * bytes (variable fonts supported) before it renders.
 *
 * Besides the paragraph provider, each registration also keeps a
 * `Typeface` per family+weight: the glyph-level APIs (text on a path)
 * need a `Font`, which the provider cannot hand back.
 */
export class FontRegistry {
  readonly provider: TypefaceFontProvider;
  private families = new Set<string>();
  private typefaces = new Map<string, Typeface>();

  constructor(private readonly canvasKit: CanvasKit) {
    this.provider = canvasKit.TypefaceFontProvider.Make();
  }

  register(family: string, data: ArrayBuffer, weight = 400): void {
    this.provider.registerFont(data, family);
    this.families.add(family.toLowerCase());

    // Typeface creation may consume the buffer wasm-side; hand it a copy.
    const face = this.canvasKit.Typeface.MakeTypefaceFromData(data.slice(0));
    if (face) {
      const key = `${family.toLowerCase()}|${weight}`;
      this.typefaces.get(key)?.delete();
      this.typefaces.set(key, face);
    }
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

  /**
   * Typeface for the family at the nearest registered weight, or null
   * when the family (or any fallback) has no typeface yet.
   */
  getTypeface(fontFamily: string, weight: number): Typeface | null {
    const family = this.resolveFamily(fontFamily);
    if (!family) {
      return null;
    }

    const wanted = family.toLowerCase();
    let best: { distance: number; face: Typeface } | null = null;
    for (const [key, face] of this.typefaces) {
      const separator = key.lastIndexOf("|");
      if (key.slice(0, separator) !== wanted) {
        continue;
      }
      const distance = Math.abs(Number(key.slice(separator + 1)) - weight);
      if (!best || distance < best.distance) {
        best = { distance, face };
      }
    }
    return best?.face ?? null;
  }

  get isEmpty(): boolean {
    return this.families.size === 0;
  }

  /** Free the wasm-side provider and every typeface registered on it. */
  dispose(): void {
    this.provider.delete();
    for (const face of this.typefaces.values()) {
      face.delete();
    }
    this.typefaces.clear();
    this.families.clear();
  }
}
