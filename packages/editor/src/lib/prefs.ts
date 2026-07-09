/**
 * Tiny persisted editor preferences (localStorage). Document data never
 * lands here — only cross-session UI choices like the pixel-snap toggle.
 * Reads/writes swallow storage failures (private mode, quota) so prefs
 * degrade to in-memory defaults.
 */

const PREFS_KEY = "openlogo:prefs";

export type EditorPrefs = {
  pixelSnap: boolean;
};

const DEFAULTS: EditorPrefs = {
  pixelSnap: false,
};

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
