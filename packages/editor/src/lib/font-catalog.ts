import { Data, Effect, Schedule } from "effect";

/**
 * Font catalog: the full Fontsource index (~1950 Google families) fetched
 * once and cached in IndexedDB, with the original curated 13 as a built-in
 * fallback so first paint and offline sessions always have fonts.
 *
 * Only the catalog lives here; byte fetching + Skia/FontFace registration
 * stay in font-store.ts (applying a font), and lightweight woff2 previews
 * live in font-preview.ts (picker rows).
 */

export type FontCategory = "sans" | "serif" | "display" | "handwriting" | "mono";

export type FontStyleName = "normal" | "italic";

export type FontFamily = {
  /** Display + registration name, matches node.fontFamily. */
  name: string;
  /** Fontsource package id. */
  id: string;
  weights: number[];
  /** Available cuts; every listed weight exists per style on the CDN. */
  styles: FontStyleName[];
  category: FontCategory;
};

const BOTH: FontStyleName[] = ["normal", "italic"];
const UPRIGHT: FontStyleName[] = ["normal"];

export const BUILTIN_FONTS: FontFamily[] = [
  { name: "Inter", id: "inter", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Montserrat", id: "montserrat", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Poppins", id: "poppins", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Work Sans", id: "work-sans", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Raleway", id: "raleway", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Archivo", id: "archivo", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "sans" },
  { name: "Space Grotesk", id: "space-grotesk", weights: [400, 500, 600, 700], styles: UPRIGHT, category: "sans" },
  { name: "Oswald", id: "oswald", weights: [400, 500, 600, 700], styles: UPRIGHT, category: "display" },
  { name: "Bebas Neue", id: "bebas-neue", weights: [400], styles: UPRIGHT, category: "display" },
  { name: "Playfair Display", id: "playfair-display", weights: [400, 500, 600, 700, 800, 900], styles: BOTH, category: "serif" },
  { name: "Lora", id: "lora", weights: [400, 500, 600, 700], styles: BOTH, category: "serif" },
  { name: "DM Serif Display", id: "dm-serif-display", weights: [400], styles: BOTH, category: "serif" },
  { name: "Space Mono", id: "space-mono", weights: [400, 700], styles: BOTH, category: "mono" },
];

/** Nearest available style: italic falls back to normal and vice versa. */
export function nearestStyle(
  family: FontFamily,
  style: FontStyleName,
): FontStyleName {
  return family.styles.includes(style) ? style : (family.styles[0] ?? "normal");
}

export function nearestWeight(family: FontFamily, weight: number): number {
  return family.weights.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
}

/** Catalog pipeline failure, tagged by which stage broke. */
export class FontCatalogError extends Data.TaggedError("FontCatalogError")<{
  readonly op: "open" | "get" | "put" | "fetch" | "decode";
  readonly cause: unknown;
}> {}

const API_URL = "https://api.fontsource.org/v1/fonts?type=google";
const DB_NAME = "openlogo-fonts";
const STORE_NAME = "catalog";
// v2: entries carry `styles` (italics readmitted). Old caches lack the
// field, so a new key forces one refetch instead of shipping a migration.
const INDEX_KEY = "index-v2";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CachedIndex = {
  fetchedAt: number;
  families: FontFamily[];
};

const CATEGORY_MAP: Record<string, FontCategory> = {
  "sans-serif": "sans",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "mono",
};

/**
 * Slim an API entry down to what the editor needs. Returns null for
 * families the TTF pipeline can't serve: non-Google mirrors, no latin
 * subset (the CDN path is latin-{weight}-{style}.ttf), icon packs.
 * Italic-only families are kept (styles records what exists).
 */
function toFamily(raw: unknown): FontFamily | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const { id, family, subsets, weights, styles, category, type } = entry;
  if (
    typeof id !== "string" ||
    typeof family !== "string" ||
    type !== "google" ||
    !Array.isArray(subsets) ||
    !subsets.includes("latin") ||
    !Array.isArray(styles) ||
    !Array.isArray(weights)
  ) {
    return null;
  }
  const usableStyles = (["normal", "italic"] as const).filter((style) =>
    styles.includes(style),
  );
  if (usableStyles.length === 0) {
    return null;
  }
  const mapped = CATEGORY_MAP[String(category)];
  if (!mapped) {
    return null;
  }
  const usable = weights
    .filter((w): w is number => typeof w === "number" && Number.isFinite(w))
    .sort((a, b) => a - b);
  if (usable.length === 0) {
    return null;
  }
  return {
    name: family,
    id,
    weights: usable,
    styles: usableStyles,
    category: mapped,
  };
}

/** The built-ins must survive whatever the API says (they seed documents). */
function withBuiltins(families: FontFamily[]): FontFamily[] {
  const seen = new Set(families.map((f) => f.name.toLowerCase()));
  const missing = BUILTIN_FONTS.filter((f) => !seen.has(f.name.toLowerCase()));
  return missing.length === 0
    ? families
    : [...families, ...missing].sort((a, b) => a.name.localeCompare(b.name));
}

const openDatabase = Effect.async<IDBDatabase, FontCatalogError>((resume) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resume(Effect.succeed(request.result));
  request.onerror = () =>
    resume(Effect.fail(new FontCatalogError({ op: "open", cause: request.error })));
});

const withDatabase = <A, E>(
  use: (db: IDBDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, E | FontCatalogError> =>
  Effect.acquireUseRelease(openDatabase, use, (db) =>
    Effect.sync(() => db.close()),
  );

const readCache: Effect.Effect<CachedIndex | null, FontCatalogError> =
  withDatabase((db) =>
    Effect.async<CachedIndex | null, FontCatalogError>((resume) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(INDEX_KEY);
      request.onsuccess = () => {
        const value = request.result as CachedIndex | undefined;
        const valid =
          value &&
          typeof value.fetchedAt === "number" &&
          Array.isArray(value.families) &&
          value.families.length > 0;
        resume(Effect.succeed(valid ? value : null));
      };
      request.onerror = () =>
        resume(Effect.fail(new FontCatalogError({ op: "get", cause: request.error })));
    }),
  );

const writeCache = (index: CachedIndex): Effect.Effect<void, FontCatalogError> =>
  withDatabase((db) =>
    Effect.async<void, FontCatalogError>((resume) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(index, INDEX_KEY);
      tx.oncomplete = () => resume(Effect.void);
      tx.onerror = () =>
        resume(Effect.fail(new FontCatalogError({ op: "put", cause: tx.error })));
    }),
  );

const fetchIndex: Effect.Effect<FontFamily[], FontCatalogError> = Effect.tryPromise({
  try: async () => {
    const response = await fetch(API_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  },
  catch: (cause) => new FontCatalogError({ op: "fetch", cause }),
}).pipe(
  Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 2 }),
  Effect.flatMap((data) => {
    if (!Array.isArray(data)) {
      return Effect.fail(
        new FontCatalogError({ op: "decode", cause: "index is not an array" }),
      );
    }
    const families = data
      .map(toFamily)
      .filter((f): f is FontFamily => f !== null);
    // A near-empty result means the API changed shape, not a small catalog.
    return families.length >= BUILTIN_FONTS.length
      ? Effect.succeed(families)
      : Effect.fail(
          new FontCatalogError({ op: "decode", cause: "no usable families" }),
        );
  }),
);

/**
 * Reactive holder for the current family list. Starts with the built-in 13
 * so the picker and catalogEntry work before (or without) the network.
 */
class FontCatalogStore {
  private families: FontFamily[] = BUILTIN_FONTS;
  private byName = new Map<string, FontFamily>(
    BUILTIN_FONTS.map((f) => [f.name.toLowerCase(), f]),
  );
  private listeners = new Set<() => void>();
  private initStarted = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FontFamily[] => this.families;

  /** Lookup by node.fontFamily ("Lobster" or `"Lobster", cursive`). */
  entry(name: string): FontFamily | undefined {
    const wanted = name.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
    return wanted ? this.byName.get(wanted.toLowerCase()) : undefined;
  }

  private replace(families: FontFamily[]): void {
    this.families = families;
    this.byName = new Map(families.map((f) => [f.name.toLowerCase(), f]));
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Load the full index: fresh cache → use it; otherwise fetch + cache;
   * fetch failure falls back to a stale cache, then to the built-ins.
   * Never fails — font availability must not break editing.
   */
  init(): Effect.Effect<void> {
    if (this.initStarted) {
      return Effect.void;
    }
    this.initStarted = true;

    const store = this;
    return Effect.gen(function* () {
      const cached = yield* readCache.pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
        store.replace(withBuiltins(cached.families));
        return;
      }

      const fetched = yield* fetchIndex.pipe(
        Effect.map((families) => families as FontFamily[] | null),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn("Font catalog fetch failed; using fallback list.", error);
            return null;
          }),
        ),
      );

      if (fetched) {
        store.replace(withBuiltins(fetched));
        yield* writeCache({ fetchedAt: Date.now(), families: fetched }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => console.warn("Font catalog cache write failed", error)),
          ),
        );
      } else if (cached) {
        store.replace(withBuiltins(cached.families)); // stale beats builtin-only
      }
    });
  }
}

export const fontCatalog = new FontCatalogStore();

export function catalogEntry(name: string): FontFamily | undefined {
  return fontCatalog.entry(name);
}
