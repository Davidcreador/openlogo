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
      pixelSnap: true,
      designMateScope: "active-artboard",
      designMateRemoteEnabled: false,
    });
  });

  it("round-trips explicit remote consent and the preferred review scope", () => {
    installStorage();
    savePrefs({
      pixelSnap: false,
      designMateScope: "document",
      designMateRemoteEnabled: true,
    });
    expect(loadPrefs()).toEqual({
      pixelSnap: false,
      designMateScope: "document",
      designMateRemoteEnabled: true,
    });
  });
});
