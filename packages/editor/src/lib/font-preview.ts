import { type FontFamily, nearestWeight } from "./font-catalog";

/**
 * Lightweight woff2 FontFaces for picker-row previews. Browser-only on
 * purpose: Skia typefaces (raw TTF bytes) are expensive and only get
 * registered when a font is actually applied (font-store.ts).
 */

type PreviewState = "loading" | "loaded" | "failed";

const states = new Map<string, PreviewState>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic counter; changes whenever any preview finishes loading. */
export function previewsSnapshot(): number {
  return version;
}

export function isPreviewReady(name: string): boolean {
  return states.get(name) === "loaded";
}

/** Kick off (once) the woff2 FontFace for a family's preview weight. */
export function ensurePreview(family: FontFamily): void {
  if (states.has(family.name)) {
    return;
  }
  states.set(family.name, "loading");

  const weight = nearestWeight(family, 400);
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${family.id}@latest/latin-${weight}-normal.woff2`;
  const face = new FontFace(family.name, `url(${url})`, {
    weight: String(weight),
  });

  face
    .load()
    .then(() => {
      document.fonts.add(face);
      states.set(family.name, "loaded");
      bump();
    })
    .catch(() => {
      // Row simply keeps the UI font; nothing to surface.
      states.set(family.name, "failed");
    });
}
