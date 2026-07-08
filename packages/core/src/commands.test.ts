import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEllipse, createInitialDocument, createRectangle } from "./factory";
import { getActiveArtboard, getNodesForArtboard } from "./queries";

describe("applyCommand", () => {
  it("insert-nodes adds nodes and inverse removes them", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const rect = createRectangle({ x: 10, y: 10 });

    const { document: next, inverse } = applyCommand(doc, {
      type: "insert-nodes",
      artboardId: artboard.id,
      nodes: [rect],
    });

    expect(next.nodes[rect.id]).toBeDefined();
    expect(getActiveArtboard(next).nodeIds).toContain(rect.id);

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.nodes[rect.id]).toBeUndefined();
    expect(getActiveArtboard(reverted).nodeIds).not.toContain(rect.id);
  });

  it("delete-nodes inverse restores nodes at original z-index", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const middleId = artboard.nodeIds[1]!;

    const { document: next, inverse } = applyCommand(doc, {
      type: "delete-nodes",
      nodeIds: [middleId],
    });

    expect(next.nodes[middleId]).toBeUndefined();

    const { document: restored } = applyCommand(next, inverse);
    expect(restored.nodes[middleId]).toBeDefined();
    expect(getActiveArtboard(restored).nodeIds).toEqual(artboard.nodeIds);
  });

  it("update-nodes inverse restores only patched fields", () => {
    const doc = createInitialDocument();
    const nodeId = getActiveArtboard(doc).nodeIds[0]!;
    const original = doc.nodes[nodeId]!;

    const { document: next, inverse } = applyCommand(doc, {
      type: "update-nodes",
      updates: [{ nodeId, patch: { x: 999, opacity: 0.5 } }],
    });

    expect(next.nodes[nodeId]!.x).toBe(999);
    expect(next.nodes[nodeId]!.opacity).toBe(0.5);

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.nodes[nodeId]!.x).toBe(original.x);
    expect(reverted.nodes[nodeId]!.opacity).toBe(original.opacity);
  });

  it("reorder-node inverse restores original order", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const [first] = artboard.nodeIds;

    const { document: next, inverse } = applyCommand(doc, {
      type: "reorder-node",
      artboardId: artboard.id,
      nodeId: first!,
      toIndex: 2,
    });

    expect(getActiveArtboard(next).nodeIds[2]).toBe(first);

    const { document: reverted } = applyCommand(next, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(artboard.nodeIds);
  });

  it("add-artboard activates it and inverse removes it with its nodes", () => {
    const doc = createInitialDocument();
    const ellipse = createEllipse({ x: 0, y: 0 });
    const artboard = {
      ...getActiveArtboard(doc),
      id: "artboard_test",
      nodeIds: [ellipse.id],
    };

    const { document: next, inverse } = applyCommand(doc, {
      type: "add-artboard",
      artboard,
      nodes: [ellipse],
    });

    expect(next.activeArtboardId).toBe("artboard_test");
    expect(next.nodes[ellipse.id]).toBeDefined();

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.artboards).toHaveLength(1);
    expect(reverted.nodes[ellipse.id]).toBeUndefined();
  });

  it("remove-artboard refuses to delete the last artboard", () => {
    const doc = createInitialDocument();
    const { document: next } = applyCommand(doc, {
      type: "remove-artboard",
      artboardId: doc.activeArtboardId,
    });

    expect(next.artboards).toHaveLength(1);
  });

  it("batch applies in order and inverse undoes everything atomically", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const rect = createRectangle({ x: 10, y: 10 });
    const victimId = artboard.nodeIds[0]!;

    const { document: next, inverse } = applyCommand(doc, {
      type: "batch",
      label: "replace",
      commands: [
        { type: "delete-nodes", nodeIds: [victimId] },
        { type: "insert-nodes", artboardId: artboard.id, nodes: [rect] },
      ],
    });

    expect(next.nodes[victimId]).toBeUndefined();
    expect(next.nodes[rect.id]).toBeDefined();

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.nodes[victimId]).toBeDefined();
    expect(reverted.nodes[rect.id]).toBeUndefined();
    expect(getActiveArtboard(reverted).nodeIds).toEqual(artboard.nodeIds);
  });

  it("getNodesForArtboard respects z-order", () => {
    const doc = createInitialDocument();
    const nodes = getNodesForArtboard(doc);
    expect(nodes.map((node) => node.id)).toEqual(
      getActiveArtboard(doc).nodeIds,
    );
  });
});
