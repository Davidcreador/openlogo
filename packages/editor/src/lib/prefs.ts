/**
 * Tiny persisted editor preferences (localStorage). Document data never
 * lands here — only cross-session UI choices and explicit privacy consent.
 * Reads/writes swallow storage failures (private mode, quota) so prefs
 * degrade to in-memory defaults.
 */

import type { ReviewScope } from "@openlogo/core";

const PREFS_KEY = "openlogo:prefs";

export type EditorPrefs = {
  pixelSnap: boolean;
  designMateScope: ReviewScope;
  designMateRemoteEnabled: boolean;
};

const DEFAULTS: EditorPrefs = {
  pixelSnap: false,
  designMateScope: "active-artboard",
  designMateRemoteEnabled: false,
};

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
