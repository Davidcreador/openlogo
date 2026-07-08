import type { FontRegistry, SceneRenderer } from "@openlogo/renderer";

/**
 * Curated logo-friendly catalog served as raw TTFs from the Fontsource
 * CDN (Skia needs TTF/OTF bytes — it cannot parse woff2 or see system
 * fonts). Bytes are cached so text-to-path reuses the same files.
 */

export type FontFamily = {
  /** Display + registration name, matches node.fontFamily. */
  name: string;
  /** Fontsource package id. */
  id: string;
  weights: number[];
  category: "sans" | "serif" | "display" | "mono";
};

export const FONT_CATALOG: FontFamily[] = [
  { name: "Inter", id: "inter", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Montserrat", id: "montserrat", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Poppins", id: "poppins", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Work Sans", id: "work-sans", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Raleway", id: "raleway", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Archivo", id: "archivo", weights: [400, 500, 600, 700, 800, 900], category: "sans" },
  { name: "Space Grotesk", id: "space-grotesk", weights: [400, 500, 600, 700], category: "sans" },
  { name: "Oswald", id: "oswald", weights: [400, 500, 600, 700], category: "display" },
  { name: "Bebas Neue", id: "bebas-neue", weights: [400], category: "display" },
  { name: "Playfair Display", id: "playfair-display", weights: [400, 500, 600, 700, 800, 900], category: "serif" },
  { name: "Lora", id: "lora", weights: [400, 500, 600, 700], category: "serif" },
  { name: "DM Serif Display", id: "dm-serif-display", weights: [400], category: "serif" },
  { name: "Space Mono", id: "space-mono", weights: [400, 700], category: "mono" },
];

export function catalogEntry(name: string): FontFamily | undefined {
  const wanted = name.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  return FONT_CATALOG.find(
    (family) => family.name.toLowerCase() === wanted?.toLowerCase(),
  );
}

export function nearestWeight(family: FontFamily, weight: number): number {
  return family.weights.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
}

function fontUrl(family: FontFamily, weight: number): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${family.id}@latest/latin-${weight}-normal.ttf`;
}

class FontStore {
  private registry: FontRegistry | null = null;
  private renderer: SceneRenderer | null = null;
  private cache = new Map<string, ArrayBuffer>();
  private pending = new Map<string, Promise<ArrayBuffer | null>>();

  /** Wired by CanvasStage once the renderer exists. */
  attach(registry: FontRegistry, renderer: SceneRenderer): void {
    this.registry = registry;
    this.renderer = renderer;
  }

  detach(): void {
    this.registry = null;
    this.renderer = null;
  }

  /**
   * Make sure family@weight is fetched and registered with Skia.
   * Resolves with the raw bytes (also used by text-to-path).
   */
  async ensure(familyName: string, weight: number): Promise<ArrayBuffer | null> {
    const family = catalogEntry(familyName);
    if (!family) {
      return null;
    }

    const resolvedWeight = nearestWeight(family, weight);
    const key = `${family.name}:${resolvedWeight}`;

    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async (): Promise<ArrayBuffer | null> => {
      try {
        const response = await fetch(fontUrl(family, resolvedWeight));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        this.cache.set(key, bytes);
        // Registry consumes the buffer; hand it a copy.
        this.registry?.register(family.name, bytes.slice(0));
        this.renderer?.invalidate();

        // Also register as a CSS FontFace so DOM surfaces (inline text
        // editor, SVG preview strip) render with the same glyphs.
        try {
          const face = new FontFace(family.name, bytes.slice(0), {
            weight: String(resolvedWeight),
          });
          await face.load();
          document.fonts.add(face);
        } catch {
          // Non-fatal: DOM fallback fonts still work.
        }

        return bytes;
      } catch (error) {
        console.warn(`Font load failed: ${key}`, error);
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, promise);
    return promise;
  }

  /** Cached bytes for family at (nearest available) weight, if fetched. */
  getBytes(familyName: string, weight: number): ArrayBuffer | null {
    const family = catalogEntry(familyName);
    if (!family) {
      return null;
    }
    return this.cache.get(`${family.name}:${nearestWeight(family, weight)}`) ?? null;
  }
}

export const fontStore = new FontStore();
