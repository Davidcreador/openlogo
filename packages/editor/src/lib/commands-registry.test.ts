import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  formatShortcut,
  fuzzyScore,
  isCommandAvailable,
  type CommandAvailability,
} from "./commands-registry";

const unavailable: CommandAvailability = {
  selectionCount: 0,
  selectedGroupCount: 0,
  canUndo: false,
  canRedo: false,
  canPaste: false,
  canBoolean: false,
  viewportReady: false,
};

describe("command registry", () => {
  it("matches direct and non-contiguous fuzzy queries", () => {
    const shapeBuilder = COMMANDS.find((command) => command.id === "tool.shape-builder")!;
    expect(fuzzyScore(shapeBuilder, "shape")).toBe(0);
    expect(fuzzyScore(shapeBuilder, "shbld")).not.toBeNull();
    expect(fuzzyScore(shapeBuilder, "xyz")).toBeNull();
  });

  it("gates commands from current editor state", () => {
    expect(isCommandAvailable("edit.copy", unavailable)).toBe(false);
    expect(isCommandAvailable("edit.paste", unavailable)).toBe(false);
    expect(isCommandAvailable("view.design-mate", unavailable)).toBe(true);
    expect(
      isCommandAvailable("edit.ungroup", {
        ...unavailable,
        selectionCount: 1,
        selectedGroupCount: 1,
      }),
    ).toBe(true);
  });

  it("formats platform shortcut labels", () => {
    expect(formatShortcut("Shift+Mod+Z", true)).toBe("⇧⌘Z");
    expect(formatShortcut("Mod+K", false)).toBe("Ctrl+K");
  });
});
