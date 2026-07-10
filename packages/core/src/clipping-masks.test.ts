import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import {
  cloneArtboardForVariant,
  createEllipse,
  createGroup,
  createInitialDocument,
  createRectangle,
  createText,
} from "./factory";
import {
  getActiveArtboard,
  getClippingMaskOwnerId,
  getRenderNodesForArtboard,
  unitBounds,
  visualBounds,
} from "./queries";
import { parseDocument } from "./schema";
import { DOCUMENT_SCHEMA_VERSION, type GroupNode } from "./types";

function fixture() {
  const document = createInitialDocument();
  const artboard = getActiveArtboard(document);
  const content = createRectangle({ x: 0, y: 0, fill: "#ef4444" });
  content.width = 200;
  content.height = 160;
  const mask = createEllipse({ x: 50, y: 30, fill: "#111827" });
  mask.width = 80;
  mask.height = 60;
  document.nodes = { [content.id]: content, [mask.id]: mask };
  artboard.nodeIds = [content.id, mask.id];
  const group = createGroup([content.id, mask.id]);
  group.name = "Clipping group";
  group.clippingMaskId = mask.id;
  return { document, artboard, content, mask, group };
}

describe("clipping-group model", () => {
  it("owns one direct clipping path and undoes grouping exactly", () => {
    const { document, artboard, content, mask, group } = fixture();
    const { document: clipped, inverse } = applyCommand(document, {
      type: "group-nodes",
      containerId: artboard.id,
      group,
      index: 0,
    });

    expect(getActiveArtboard(clipped).nodeIds).toEqual([group.id]);
    expect(getClippingMaskOwnerId(clipped, mask.id)).toBe(group.id);
    expect(getRenderNodesForArtboard(clipped).map((node) => node.id)).toEqual([
      content.id,
    ]);
    expect(unitBounds(clipped, group.id)).toEqual({
      x: 50,
      y: 30,
      width: 80,
      height: 60,
    });

    const { document: restored } = applyCommand(clipped, inverse);
    expect(getActiveArtboard(restored).nodeIds).toEqual([
      content.id,
      mask.id,
    ]);
    expect(restored.nodes[group.id]).toBeUndefined();
  });

  it("intersects rotated visual AABBs for clipping-group bounds", () => {
    const { document, artboard, content, mask, group } = fixture();
    Object.assign(content, {
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 90,
    });
    Object.assign(mask, {
      x: 10,
      y: -30,
      width: 80,
      height: 100,
      rotation: 90,
    });
    const { document: clipped } = applyCommand(document, {
      type: "group-nodes",
      containerId: artboard.id,
      group,
      index: 0,
    });

    const contentBounds = visualBounds(clipped, content.id)!;
    expect(contentBounds.x).toBeCloseTo(30, 6);
    expect(contentBounds.y).toBeCloseTo(-30, 6);
    expect(contentBounds.width).toBeCloseTo(40, 6);
    expect(contentBounds.height).toBeCloseTo(100, 6);
    expect(unitBounds(clipped, content.id)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    });

    const maskBounds = visualBounds(clipped, mask.id)!;
    expect(maskBounds.x).toBeCloseTo(0, 6);
    expect(maskBounds.y).toBeCloseTo(-20, 6);
    expect(maskBounds.width).toBeCloseTo(100, 6);
    expect(maskBounds.height).toBeCloseTo(80, 6);

    const clippedBounds = unitBounds(clipped, group.id)!;
    expect(clippedBounds.x).toBeCloseTo(30, 6);
    expect(clippedBounds.y).toBeCloseTo(-20, 6);
    expect(clippedBounds.width).toBeCloseTo(40, 6);
    expect(clippedBounds.height).toBeCloseTo(80, 6);
  });

  it("rejects malformed ownership commands without changing the document", () => {
    const { document, artboard, content } = fixture();
    const text = createText({ x: 20, y: 20 });
    document.nodes[text.id] = text;
    artboard.nodeIds.push(text.id);
    const invalid = createGroup([content.id, text.id]);
    invalid.clippingMaskId = text.id;

    const { document: next } = applyCommand(document, {
      type: "group-nodes",
      containerId: artboard.id,
      group: invalid,
      index: 0,
    });
    expect(next).toBe(document);
  });

  it("migrates v3 and strips structurally invalid v4 relationships", () => {
    const legacy = createInitialDocument();
    legacy.schemaVersion = 3;
    const migrated = parseDocument(JSON.parse(JSON.stringify(legacy)));
    expect(migrated.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);

    const { document, artboard, content } = fixture();
    const text = createText({ x: 0, y: 0 });
    const invalid = createGroup([content.id, text.id]);
    invalid.clippingMaskId = text.id;
    document.nodes = {
      [content.id]: content,
      [text.id]: text,
      [invalid.id]: invalid,
    };
    artboard.nodeIds = [invalid.id];
    const parsed = parseDocument(JSON.parse(JSON.stringify(document)));
    expect((parsed.nodes[invalid.id] as GroupNode).clippingMaskId).toBeUndefined();
  });

  it("remaps clipping ownership when cloning an artboard variant", () => {
    const { document, artboard, group } = fixture();
    document.nodes[group.id] = group;
    artboard.nodeIds = [group.id];

    const cloned = cloneArtboardForVariant(document, artboard.id, "icon");
    const clonedGroup = cloned.nodes.find(
      (node): node is GroupNode => node.type === "group",
    )!;
    expect(clonedGroup.clippingMaskId).toBeDefined();
    expect(clonedGroup.children).toContain(clonedGroup.clippingMaskId);
    expect(clonedGroup.clippingMaskId).not.toBe(group.clippingMaskId);
  });

  it("clears a deleted mask reference and restores it on undo", () => {
    const { document, artboard, mask, group } = fixture();
    const clipped = applyCommand(document, {
      type: "group-nodes",
      containerId: artboard.id,
      group,
      index: 0,
    }).document;

    const deletion = applyCommand(clipped, {
      type: "delete-nodes",
      nodeIds: [mask.id],
    });
    const survivingGroup = deletion.document.nodes[group.id];
    expect(survivingGroup?.type).toBe("group");
    if (survivingGroup?.type === "group") {
      expect(survivingGroup.children).not.toContain(mask.id);
      expect(survivingGroup.clippingMaskId).toBeUndefined();
    }

    const restored = applyCommand(deletion.document, deletion.inverse).document;
    const restoredGroup = restored.nodes[group.id];
    expect(restoredGroup?.type).toBe("group");
    if (restoredGroup?.type === "group") {
      expect(restoredGroup.children).toContain(mask.id);
      expect(restoredGroup.clippingMaskId).toBe(mask.id);
    }
  });
});
