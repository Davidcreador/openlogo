import { Data, Effect, Schedule } from "effect";
import type { FontRegistry, SceneRenderer } from "@openlogo/renderer";
import { type FontFamily, catalogEntry, nearestWeight } from "./font-catalog";

/**
 * Applying a font: raw TTF bytes from the Fontsource CDN (Skia needs
 * TTF/OTF bytes — it cannot parse woff2 or see system fonts). Bytes are
 * cached so text-to-path reuses the same files. The family list itself
 * lives in font-catalog.ts.
 */

function fontUrl(family: FontFamily, weight: number): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${family.id}@latest/latin-${weight}-normal.ttf`;
}

/** CDN fetch failure for one family@weight, after retries. */
export class FontLoadError extends Data.TaggedError("FontLoadError")<{
  readonly key: string;
  readonly cause: unknown;
}> {}

class FontStore {
  private registry: FontRegistry | null = null;
  private renderer: SceneRenderer | null = null;
  private cache = new Map<string, ArrayBuffer>();
  /**
   * In-flight loads are shared as promises rather than Effect fibers: each
   * `ensure` call is an independent runtime entry, so memoization has to
   * live outside any single fiber.
   */
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

  /** Fetch + register family@weight; transient CDN failures retry with backoff. */
  private load(
    family: FontFamily,
    resolvedWeight: number,
    key: string,
  ): Effect.Effect<ArrayBuffer, FontLoadError> {
    const fetchBytes = Effect.tryPromise({
      try: async () => {
        const response = await fetch(fontUrl(family, resolvedWeight));
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
          this.cache.set(key, bytes);
          // Registry consumes the buffer; hand it a copy. The weight keys
          // the per-weight Typeface used by text-on-a-path glyph layout.
          this.registry?.register(family.name, bytes.slice(0), resolvedWeight);
          this.renderer?.invalidate();
        }),
      ),
      // Also register as a CSS FontFace so DOM surfaces (inline text
      // editor, SVG preview strip) render with the same glyphs.
      // Non-fatal: DOM fallback fonts still work.
      Effect.tap((bytes) =>
        Effect.promise(async () => {
          const face = new FontFace(family.name, bytes.slice(0), {
            weight: String(resolvedWeight),
          });
          await face.load();
          document.fonts.add(face);
        }).pipe(Effect.ignore),
      ),
    );
  }

  /**
   * Effect view: make sure family@weight is fetched and registered with
   * Skia. Succeeds with the raw bytes, or null for unknown families and
   * exhausted retries (the failure is logged, matching the pre-Effect
   * contract that font problems never break editing).
   */
  ensureEffect(
    familyName: string,
    weight: number,
  ): Effect.Effect<ArrayBuffer | null> {
    return Effect.suspend(() => {
      const family = catalogEntry(familyName);
      if (!family) {
        return Effect.succeed(null);
      }

      const resolvedWeight = nearestWeight(family, weight);
      const key = `${family.name}:${resolvedWeight}`;

      const cached = this.cache.get(key);
      if (cached) {
        return Effect.succeed(cached);
      }

      const inFlight = this.pending.get(key);
      if (inFlight) {
        return Effect.promise(() => inFlight);
      }

      const promise = Effect.runPromise(
        this.load(family, resolvedWeight, key).pipe(
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
  ensure(familyName: string, weight: number): Promise<ArrayBuffer | null> {
    return Effect.runPromise(this.ensureEffect(familyName, weight));
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
