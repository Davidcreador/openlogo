import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelActiveCanvasSessions,
  registerCanvasSessionCanceler,
} from "./canvas-sessions";
import { shouldBlockWorkspaceShortcuts } from "./keyboard-shortcuts";
import { resolveMarqueeSelection } from "./selection-ops";

describe("interaction safety helpers", () => {
  afterEach(() => {
    registerCanvasSessionCanceler(() => undefined)();
  });

  it("registers one canvas canceler and unregisters it by identity", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerCanvasSessionCanceler(first);
    const unregisterSecond = registerCanvasSessionCanceler(second);
    unregisterFirst();
    cancelActiveCanvasSessions();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    unregisterSecond();
    cancelActiveCanvasSessions();
    expect(second).toHaveBeenCalledOnce();
  });

  it.each([
    ["document library", { documentLibraryOpen: true }],
    ["transform dialog", { transformDialogOpen: true }],
    ["export dialog", { exportDialogOpen: true }],
  ])("blocks workspace shortcuts behind the %s", (_label, override) => {
    expect(
      shouldBlockWorkspaceShortcuts(
        {
          documentLibraryOpen: false,
          transformDialogOpen: false,
          exportDialogOpen: false,
          ...override,
        },
        false,
      ),
    ).toBe(true);
  });

  it("also blocks shortcuts while the document library is busy", () => {
    expect(
      shouldBlockWorkspaceShortcuts(
        {
          documentLibraryOpen: false,
          transformDialogOpen: false,
          exportDialogOpen: false,
        },
        true,
      ),
    ).toBe(true);
  });

  it("adds shift-marquee hits without duplicates and otherwise replaces", () => {
    expect(resolveMarqueeSelection(["b", "c"], ["a", "b"], true)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(resolveMarqueeSelection(["b", "c"], ["a"], false)).toEqual([
      "b",
      "c",
    ]);
  });
});
