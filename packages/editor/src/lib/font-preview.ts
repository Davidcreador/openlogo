import {
  type FontFamily,
  nearestStyle,
  nearestWeight,
} from "./font-catalog";

/**
 * Lightweight woff2 FontFaces for picker-row previews. Browser-only on
 * purpose: Skia typefaces (raw TTF bytes) are expensive and only get
 * registered when a font is actually applied (font-store.ts).
 */

type PreviewState = "loading" | "loaded" | "failed";

const states = new Map<string, PreviewState>();
const pending = new Map<string, Promise<boolean>>();
const defaultKeys = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function faceKey(
  family: FontFamily,
  weight: number,
  style: "normal" | "italic",
): string {
  return `${family.name}:${nearestWeight(family, weight)}:${nearestStyle(family, style)}`;
}

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
  const key = defaultKeys.get(name);
  return key !== undefined && states.get(key) === "loaded";
}

/** Kick off (once) the woff2 FontFace for a family's preview weight. */
export function ensurePreview(family: FontFamily): void {
  const weight = nearestWeight(family, 400);
  const style = nearestStyle(family, "normal");
  defaultKeys.set(family.name, faceKey(family, weight, style));
  void ensurePreviewFace(family, weight, style);
}

export function isPreviewFaceReady(
  family: FontFamily,
  weight: number,
  style: "normal" | "italic" = "normal",
): boolean {
  return states.get(faceKey(family, weight, style)) === "loaded";
}

/** Load one exact, nearest-available WOFF2 face for DOM and inline-SVG previews. */
export function ensurePreviewFace(
  family: FontFamily,
  weight: number,
  style: "normal" | "italic" = "normal",
): Promise<boolean> {
  const resolvedWeight = nearestWeight(family, weight);
  const resolvedStyle = nearestStyle(family, style);
  const key = faceKey(family, resolvedWeight, resolvedStyle);
  const state = states.get(key);
  if (state === "loaded") {
    return Promise.resolve(true);
  }
  if (state === "failed") {
    return Promise.resolve(false);
  }
  const inFlight = pending.get(key);
  if (inFlight) {
    return inFlight;
  }

  states.set(key, "loading");
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${family.id}@latest/latin-${resolvedWeight}-${resolvedStyle}.woff2`;
  const face = new FontFace(family.name, `url(${url})`, {
    weight: String(resolvedWeight),
    style: resolvedStyle,
  });

  const load = face
    .load()
    .then(() => {
      document.fonts.add(face);
      states.set(key, "loaded");
      bump();
      return true;
    })
    .catch(() => {
      states.set(key, "failed");
      bump();
      return false;
    })
    .finally(() => pending.delete(key));
  pending.set(key, load);
  return load;
}
