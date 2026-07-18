/**
 * Tiny persisted editor preferences (localStorage). Document data never
 * lands here — only cross-session UI choices and explicit privacy consent.
 * Reads/writes swallow storage failures (private mode, quota) so prefs
 * degrade to in-memory defaults.
 */

import type { ReviewScope } from "@openlogo/core";

const PREFS_KEY = "openlogo:prefs";

export type ThemeName = "dark" | "light";

export type PreviewSurface = "artboard" | "light" | "dark" | "transparent";

export type EditorPrefs = {
  /** UI theme. Dark is the product default; light only when chosen. */
  theme: ThemeName;
  pixelSnap: boolean;
  designMateScope: ReviewScope;
  designMateRemoteEnabled: boolean;
  /**
   * Size-check dock. null = auto (open once the active artboard has
   * content, collapsed on an empty canvas); a user toggle sticks.
   */
  previewStripOpen: boolean | null;
  previewStripSurface: PreviewSurface;
};

const DEFAULTS: EditorPrefs = {
  theme: "dark",
  pixelSnap: false,
  designMateScope: "active-artboard",
  designMateRemoteEnabled: false,
  previewStripOpen: null,
  previewStripSurface: "artboard",
};

function isPreviewSurface(value: unknown): value is PreviewSurface {
  return (
    value === "artboard" ||
    value === "light" ||
    value === "dark" ||
    value === "transparent"
  );
}

function isReviewScope(value: unknown): value is ReviewScope {
  return (
    value === "selection" ||
    value === "active-artboard" ||
    value === "document"
  );
}

export function loadPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      return { ...DEFAULTS };
    }
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    return {
      // index.html's pre-paint script applies the same "light-only-if-stored"
      // rule; keep the two in sync or the theme will flash on load.
      theme: parsed.theme === "light" ? "light" : DEFAULTS.theme,
      pixelSnap:
        typeof parsed.pixelSnap === "boolean"
          ? parsed.pixelSnap
          : DEFAULTS.pixelSnap,
      designMateScope: isReviewScope(parsed.designMateScope)
        ? parsed.designMateScope
        : DEFAULTS.designMateScope,
      designMateRemoteEnabled:
        typeof parsed.designMateRemoteEnabled === "boolean"
          ? parsed.designMateRemoteEnabled
          : DEFAULTS.designMateRemoteEnabled,
      previewStripOpen:
        typeof parsed.previewStripOpen === "boolean"
          ? parsed.previewStripOpen
          : DEFAULTS.previewStripOpen,
      previewStripSurface: isPreviewSurface(parsed.previewStripSurface)
        ? parsed.previewStripSurface
        : DEFAULTS.previewStripSurface,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: EditorPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — the toggle still works for this session.
  }
}
