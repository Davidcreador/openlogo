import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPrefs, savePrefs } from "./prefs";

function installStorage(initial?: string) {
  let value = initial ?? null;
  vi.stubGlobal("localStorage", {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor preferences", () => {
  it("defaults remote Design Mate to local-only and validates stored scope", () => {
    installStorage(
      JSON.stringify({
        pixelSnap: true,
        designMateScope: "unsafe-scope",
        designMateRemoteEnabled: "yes",
      }),
    );
    expect(loadPrefs()).toEqual({
      theme: "dark",
      pixelSnap: true,
      designMateScope: "active-artboard",
      designMateRemoteEnabled: false,
    });
  });

  it("round-trips explicit remote consent and the preferred review scope", () => {
    installStorage();
    savePrefs({
      theme: "dark",
      pixelSnap: false,
      designMateScope: "document",
      designMateRemoteEnabled: true,
    });
    expect(loadPrefs()).toEqual({
      theme: "dark",
      pixelSnap: false,
      designMateScope: "document",
      designMateRemoteEnabled: true,
    });
  });

  it("defaults the theme to dark, including for unknown stored values", () => {
    installStorage();
    expect(loadPrefs().theme).toBe("dark");
    installStorage(JSON.stringify({ theme: "solarized" }));
    expect(loadPrefs().theme).toBe("dark");
  });

  it("round-trips an explicit light theme choice", () => {
    installStorage();
    savePrefs({ ...loadPrefs(), theme: "light" });
    expect(loadPrefs().theme).toBe("light");
  });
});
