import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createInitialDocument, createText } from "./factory";
import { parseDocument } from "./schema";
import {
  KERN_STEP,
  kernAt,
  kernToPx,
  kernedPairCount,
  pruneKerning,
  withKernAdjusted,
} from "./typography";

describe("manual kerning map", () => {
  it("adjusts, accumulates and prunes zero entries", () => {
    let map = withKernAdjusted(undefined, 2, KERN_STEP);
    expect(map).toEqual({ 2: 20 });
    map = withKernAdjusted(map, 2, KERN_STEP);
    expect(kernAt(map, 2)).toBe(40);
    map = withKernAdjusted(map, 2, -40);
    expect(map).toBeUndefined();
  });

  it("keeps other pairs when one zeroes out", () => {
    let map = withKernAdjusted(undefined, 0, -20);
    map = withKernAdjusted(map, 3, 60);
    map = withKernAdjusted(map, 0, 20);
    expect(map).toEqual({ 3: 60 });
  });

  it("converts 1/1000 em to px by font size", () => {
    expect(kernToPx(20, 50)).toBe(1);
    expect(kernToPx(-100, 44)).toBeCloseTo(-4.4);
  });

  it("prunes entries that fall outside the content after edits", () => {
    const map = { 0: 20, 4: -40, 9: 10 };
    expect(pruneKerning(map, "Brand")).toEqual({ 0: 20 }); // pairs 0..3 valid
    expect(pruneKerning(map, "a")).toBeUndefined();
    expect(pruneKerning(undefined, "abc")).toBeUndefined();
  });
});

describe("text node typography round-trip", () => {
  it("kerning / fontStyle / otFeatures survive parseDocument", () => {
    const document = createInitialDocument();
    const text = createText({ x: 0, y: 0, content: "Wave" });
    const withText = applyCommand(document, {
      type: "insert-nodes",
      artboardId: document.activeArtboardId,
      nodes: [text],
    }).document;
    const patched = applyCommand(withText, {
      type: "update-nodes",
      updates: [
        {
          nodeId: text.id,
          patch: {
            kerning: { 0: -60, 2: 40 },
            fontStyle: "italic",
            otFeatures: { liga: false, clig: false },
          },
        },
      ],
    }).document;

    const parsed = parseDocument(JSON.parse(JSON.stringify(patched)));
    const node = parsed.nodes[text.id]!;
    expect(node.type).toBe("text");
    if (node.type === "text") {
      expect(node.kerning).toEqual({ 0: -60, 2: 40 });
      expect(node.fontStyle).toBe("italic");
      expect(node.otFeatures).toEqual({ liga: false, clig: false });
      expect(kernedPairCount(node)).toBe(2);
    }
  });

  it("kerning patches invert exactly (undefined clears)", () => {
    const document = createInitialDocument();
    const text = createText({ x: 0, y: 0, content: "Wave" });
    const withText = applyCommand(document, {
      type: "insert-nodes",
      artboardId: document.activeArtboardId,
      nodes: [text],
    }).document;

    const kerned = applyCommand(withText, {
      type: "update-nodes",
      updates: [{ nodeId: text.id, patch: { kerning: { 1: 20 } } }],
    });
    const cleared = applyCommand(kerned.document, {
      type: "update-nodes",
      updates: [{ nodeId: text.id, patch: { kerning: undefined } }],
    });
    const clearedNode = cleared.document.nodes[text.id]!;
    expect(
      clearedNode.type === "text" ? clearedNode.kerning : "wrong",
    ).toBeUndefined();

    const restored = applyCommand(cleared.document, cleared.inverse).document;
    const restoredNode = restored.nodes[text.id]!;
    expect(restoredNode.type === "text" ? restoredNode.kerning : null).toEqual({
      1: 20,
    });
  });
});
