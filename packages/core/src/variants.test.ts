import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createArtboard, createInitialDocument } from "./factory";
import { ARTBOARD_GAP } from "./queries";
import { buildAddVariantCommand } from "./variants";

describe("buildAddVariantCommand", () => {
  it("clones beside the source and activates by default without mutating input", () => {
    const document = createInitialDocument();
    const source = document.artboards[0]!;
    const before = structuredClone(document);

    const command = buildAddVariantCommand(document, source.id, "icon");

    expect(command.type).toBe("add-artboard");
    expect(command.activate).toBe(true);
    expect(command.artboard).toMatchObject({
      purpose: "icon",
      x: source.x + source.width + ARTBOARD_GAP,
      y: source.y,
    });
    expect(command.artboard.nodeIds).not.toEqual(source.nodeIds);
    expect(command.nodes).toHaveLength(source.nodeIds.length);
    expect(document).toEqual(before);

    const applied = applyCommand(document, command).document;
    expect(applied.activeArtboardId).toBe(command.artboard.id);
  });

  it("supports an inactive preview and clears blocking artboards", () => {
    const initial = createInitialDocument();
    const source = initial.artboards[0]!;
    const blocker = createArtboard("horizontal", {
      x: source.x + source.width + ARTBOARD_GAP,
      y: source.y,
      width: source.width,
      height: source.height,
    });
    const document = applyCommand(initial, {
      type: "add-artboard",
      artboard: blocker,
      nodes: [],
      activate: false,
    }).document;
    const before = structuredClone(document);

    const command = buildAddVariantCommand(document, source.id, "wordmark", {
      activate: false,
    });

    expect(command.activate).toBe(false);
    expect(command.artboard).toMatchObject({
      x: blocker.x + blocker.width + ARTBOARD_GAP,
      y: source.y,
    });
    const applied = applyCommand(document, command).document;
    expect(applied.activeArtboardId).toBe(document.activeArtboardId);
    expect(document).toEqual(before);
  });
});
