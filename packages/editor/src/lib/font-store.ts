import { Data, Effect, Schedule } from "effect";
import type {
  FontRegistry,
  KerningFn,
  SceneRenderer,
} from "@openlogo/renderer";
import {
  type FontFamily,
  type FontStyleName,
  catalogEntry,
  nearestStyle,
  nearestWeight,
} from "./font-catalog";
import { kerningLookup } from "./opentype-kerning";
import { opentypeModule } from "./opentype-loader";

/**
 * Applying a font: raw TTF bytes from the Fontsource CDN (Skia needs
 * TTF/OTF bytes — it cannot parse woff2 or see system fonts). Bytes are
 * cached so text-to-path reuses the same files. The family list itself
 * lives in font-catalog.ts.
 */

function fontUrl(family: FontFamily, weight: number, style: FontStyleName): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${family.id}@latest/latin-${weight}-${style}.ttf`;
}

/** CDN fetch failure for one family@weight/style, after retries. */
export class FontLoadError extends Data.TaggedError("FontLoadError")<{
  readonly key: string;
  readonly cause: unknown;
}> {}

class FontStore {
  private registry: Pick<FontRegistry, "register" | "setKerning"> | null = null;
  private renderer: Pick<
    SceneRenderer,
    "invalidate" | "invalidateFonts"
  > | null = null;
  private cache = new Map<
    string,
    {
      family: FontFamily;
      weight: number;
      style: FontStyleName;
      bytes: ArrayBuffer;
      kerning?: KerningFn;
    }
  >();
  /**
   * In-flight loads are shared as promises rather than Effect fibers: each
   * `ensure` call is an independent runtime entry, so memoization has to
   * live outside any single fiber.
   */
  private pending = new Map<string, Promise<ArrayBuffer | null>>();

  /** Wired by CanvasStage once the renderer exists. */
  attach(
    registry: Pick<FontRegistry, "register" | "setKerning">,
    renderer: Pick<SceneRenderer, "invalidate" | "invalidateFonts">,
  ): void {
    this.registry = registry;
    this.renderer = renderer;
    for (const face of this.cache.values()) {
      registry.register(
        face.family.name,
        face.bytes.slice(0),
        face.weight,
        face.style,
      );
      if (face.kerning) {
        registry.setKerning(
          face.family.name,
          face.weight,
          face.style,
          face.kerning,
        );
      }
    }
    renderer.invalidateFonts();
  }

  detach(): void {
    this.registry = null;
    this.renderer = null;
  }

  /** Fetch + register family@weight/style; transient CDN failures retry with backoff. */
  private load(
    family: FontFamily,
    resolvedWeight: number,
    style: FontStyleName,
    key: string,
  ): Effect.Effect<ArrayBuffer, FontLoadError> {
    const fetchBytes = Effect.tryPromise({
      try: async () => {
        const response = await fetch(fontUrl(family, resolvedWeight, style));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      },
      catch: (cause) => new FontLoadError({ key, cause }),
    });

    return fetchBytes.pipe(
      Effect.retry({ schedule: Schedule.exponential("300 millis"), times: 2 }),
      Effect.tap((bytes) =>
        Effect.sync(() => {
          this.cache.set(key, {
            family,
            weight: resolvedWeight,
            style,
            bytes,
          });
          // Registry consumes the buffer; hand it a copy. weight+style key
          // the per-face Typeface used by text-on-a-path glyph layout.
          this.registry?.register(family.name, bytes.slice(0), resolvedWeight, style);
          this.renderer?.invalidateFonts();
        }),
      ),
      // Metrics kerning: extract the face's kern/GPOS pair values with
      // opentype.js and hand the renderer a lookup, so text-on-a-path
      // kerns like the paragraph engine does. Coverage: the legacy
      // `kern` table plus GPOS pair adjustment (lookup type 2) — what
      // opentype.js getKerningValue reads; contextual/chained
      // positioning is not applied. Non-fatal: layout just stays plain.
      Effect.tap((bytes) =>
        this.extractKerning(family, resolvedWeight, style, key, bytes),
      ),
      // Also register as a CSS FontFace so DOM surfaces (inline text
      // editor, SVG preview strip) render with the same glyphs.
      // Non-fatal: DOM fallback fonts still work.
      Effect.tap((bytes) =>
        Effect.promise(async () => {
          const face = new FontFace(family.name, bytes.slice(0), {
            weight: String(resolvedWeight),
            style,
          });
          await face.load();
          document.fonts.add(face);
        }).pipe(Effect.ignore),
      ),
    );
  }

  private extractKerning(
    family: FontFamily,
    weight: number,
    style: FontStyleName,
    key: string,
    bytes: ArrayBuffer,
  ): Effect.Effect<void> {
    return opentypeModule.pipe(
      Effect.flatMap((ot) =>
        Effect.sync(() => {
          const font = ot.parse(bytes.slice(0));
          const kerning = kerningLookup(font);
          const cached = this.cache.get(key);
          if (cached) {
            cached.kerning = kerning;
          }
          this.registry?.setKerning(family.name, weight, style, kerning);
          this.renderer?.invalidate();
        }),
      ),
      Effect.ignore,
    );
  }

  /**
   * Effect view: make sure family@weight/style is fetched and registered
   * with Skia. Succeeds with the raw bytes, or null for unknown families
   * and exhausted retries (the failure is logged, matching the pre-Effect
   * contract that font problems never break editing).
   */
  ensureEffect(
    familyName: string,
    weight: number,
    style: FontStyleName = "normal",
  ): Effect.Effect<ArrayBuffer | null> {
    return Effect.suspend(() => {
      const family = catalogEntry(familyName);
      if (!family) {
        return Effect.succeed(null);
      }

      const resolvedWeight = nearestWeight(family, weight);
      const resolvedStyle = nearestStyle(family, style);
      const key = `${family.name}:${resolvedWeight}:${resolvedStyle}`;

      const cached = this.cache.get(key);
      if (cached) {
        return Effect.succeed(cached.bytes);
      }

      const inFlight = this.pending.get(key);
      if (inFlight) {
        return Effect.promise(() => inFlight);
      }

      const promise = Effect.runPromise(
        this.load(family, resolvedWeight, resolvedStyle, key).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn(`Font load failed: ${key}`, error.cause);
              return null;
            }),
          ),
        ),
      ).finally(() => this.pending.delete(key));

      this.pending.set(key, promise);
      return Effect.promise(() => promise);
    });
  }

  /** Promise view for fire-and-forget call sites in components. */
  ensure(
    familyName: string,
    weight: number,
    style: FontStyleName = "normal",
  ): Promise<ArrayBuffer | null> {
    return Effect.runPromise(this.ensureEffect(familyName, weight, style));
  }

  /** Cached bytes for family at (nearest available) weight/style, if fetched. */
  getBytes(
    familyName: string,
    weight: number,
    style: FontStyleName = "normal",
  ): ArrayBuffer | null {
    const family = catalogEntry(familyName);
    if (!family) {
      return null;
    }
    const key = `${family.name}:${nearestWeight(family, weight)}:${nearestStyle(family, style)}`;
    return this.cache.get(key)?.bytes ?? null;
  }
}

export const fontStore = new FontStore();
