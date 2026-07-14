import type { CanvasKit, Typeface, TypefaceFontProvider } from "canvaskit-wasm";

export type FontSlant = "normal" | "italic";

/**
 * Pair-kerning lookup for one registered face: (left char, right char) →
 * adjustment as a fraction of the em (multiply by font size for px).
 * Extracted editor-side from the same TTF bytes via opentype.js (kern
 * table + GPOS pair adjustment) — the renderer stays dependency-free.
 */
export type KerningFn = (left: string, right: string) => number;

/**
 * Font registry backing the Paragraph API. Skia cannot see system fonts,
 * so every family used by text nodes must be registered from raw TTF/OTF
 * bytes (variable fonts supported) before it renders.
 *
 * Besides the paragraph provider, each registration also keeps a
 * `Typeface` per family+weight+style: the glyph-level APIs (text on a
 * path) need a `Font`, which the provider cannot hand back.
 *
 * Italics are registered under the alias family "<Family> Italic" on the
 * provider — TypefaceFontProvider's style matching is unreliable across
 * multiple faces of one family, and an explicit alias makes paragraph
 * font selection deterministic.
 */
export class FontRegistry {
  readonly provider: TypefaceFontProvider;
  private families = new Map<string, string>();
  private typefaces = new Map<string, Typeface>();
  private kerning = new Map<string, KerningFn>();

  constructor(private readonly canvasKit: CanvasKit) {
    this.provider = canvasKit.TypefaceFontProvider.Make();
  }

  register(
    family: string,
    data: ArrayBuffer,
    weight = 400,
    style: FontSlant = "normal",
  ): void {
    const providerFamily =
      style === "italic" ? FontRegistry.italicAlias(family) : family;
    this.provider.registerFont(data, providerFamily);
    this.families.set(providerFamily.toLowerCase(), providerFamily);

    // Italic-only families (no upright cut anywhere): make the base name
    // resolvable too, so plain lookups don't fall through to an arbitrary
    // fallback family.
    if (style === "italic" && !this.families.has(family.toLowerCase())) {
      this.provider.registerFont(data.slice(0), family);
      this.families.set(family.toLowerCase(), family);
    }

    // Typeface creation may consume the buffer wasm-side; hand it a copy.
    const face = this.canvasKit.Typeface.MakeTypefaceFromData(data.slice(0));
    if (face) {
      const key = FontRegistry.faceKey(family, weight, style);
      this.typefaces.get(key)?.delete();
      this.typefaces.set(key, face);
    }
  }

  static italicAlias(family: string): string {
    return `${family} Italic`;
  }

  private static faceKey(family: string, weight: number, style: FontSlant): string {
    return `${family.toLowerCase()}|${style}|${weight}`;
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
      const family = this.families.get(part.toLowerCase());
      if (family) {
        return family;
      }
    }

    const first = this.families.values().next();
    return first.done ? null : first.value;
  }

  /**
   * Provider family name to feed a ParagraphStyle for family+style:
   * the italic alias when its face is registered, else the base family
   * (upright fallback until the italic bytes arrive).
   */
  resolveProviderFamily(fontFamily: string, style: FontSlant): string | null {
    const family = this.resolveFamily(fontFamily);
    if (!family) {
      return null;
    }
    if (
      style === "italic" &&
      this.families.has(FontRegistry.italicAlias(family).toLowerCase())
    ) {
      return FontRegistry.italicAlias(family);
    }
    return family;
  }

  /** Nearest-weight entry of a keyed map for family+style, with upright fallback. */
  private nearest<T>(
    map: Map<string, T>,
    fontFamily: string,
    weight: number,
    style: FontSlant,
  ): T | null {
    const family = this.resolveFamily(fontFamily);
    if (!family) {
      return null;
    }
    const wanted = family.toLowerCase();
    for (const slant of style === "italic" ? (["italic", "normal"] as const) : (["normal"] as const)) {
      const prefix = `${wanted}|${slant}|`;
      let best: { distance: number; value: T } | null = null;
      for (const [key, value] of map) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const distance = Math.abs(Number(key.slice(prefix.length)) - weight);
        if (!best || distance < best.distance) {
          best = { distance, value };
        }
      }
      if (best) {
        return best.value;
      }
    }
    return null;
  }

  /**
   * Typeface for the family at the nearest registered weight (italic
   * falls back to upright), or null when nothing is registered yet.
   */
  getTypeface(
    fontFamily: string,
    weight: number,
    style: FontSlant = "normal",
  ): Typeface | null {
    return this.nearest(this.typefaces, fontFamily, weight, style);
  }

  /** Attach a kerning lookup for a registered face. */
  setKerning(
    family: string,
    weight: number,
    style: FontSlant,
    fn: KerningFn,
  ): void {
    this.kerning.set(FontRegistry.faceKey(family, weight, style), fn);
  }

  /** Kerning lookup nearest to family+weight+style, or null. */
  getKerning(
    fontFamily: string,
    weight: number,
    style: FontSlant = "normal",
  ): KerningFn | null {
    return this.nearest(this.kerning, fontFamily, weight, style);
  }

  /** Exact-face check, no style/weight fallback (automation/debug). */
  hasFace(family: string, weight: number, style: FontSlant = "normal"): boolean {
    return this.typefaces.has(FontRegistry.faceKey(family, weight, style));
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
    this.kerning.clear();
  }
}
