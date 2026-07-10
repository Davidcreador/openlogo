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

  it("update-brief replaces and sanitizes the complete brief", () => {
    const doc = createInitialDocument();
    const { document: next, inverse } = applyCommand(doc, {
      type: "update-brief",
      brief: {
        brandName: "  Northstar  ",
        audience: "   ",
        attributes: [" bold ", "bold", "", " dependable "],
        constraints: "  Must work in one color. ",
      },
    });

    expect(next.designBrief).toEqual({
      brandName: "Northstar",
      attributes: ["bold", "dependable"],
      constraints: "Must work in one color.",
    });
    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted).toEqual(doc);
    expect(reverted).not.toHaveProperty("designBrief");
  });

  it("update-brief clears by omission and its inverse restores the exact brief", () => {
    const doc = {
      ...createInitialDocument(),
      designBrief: {
        notes: "Keep this exact note",
        mustKeep: ["Symbol", "Wordmark"],
      },
    };

    const { document: cleared, inverse } = applyCommand(doc, {
      type: "update-brief",
    });
    expect(cleared).not.toHaveProperty("designBrief");

    const { document: restored } = applyCommand(cleared, inverse);
    expect(restored).toEqual(doc);
  });

  it("update-brief no-ops when the sanitized replacement is structurally equal", () => {
    const doc = {
      ...createInitialDocument(),
      designBrief: {
        brandName: "Northstar",
        attributes: ["bold", "dependable"],
      },
    };

    const result = applyCommand(doc, {
      type: "update-brief",
      brief: {
        attributes: [" bold ", "bold", " dependable "],
        brandName: " Northstar ",
      },
    });

    expect(result.document).toBe(doc);
  });

  it("updates and restores a path fill rule", () => {
    const doc = createInitialDocument();
    const path = Object.values(doc.nodes).find((node) => node.type === "path")!;

    const { document: next, inverse } = applyCommand(doc, {
      type: "update-nodes",
      updates: [{ nodeId: path.id, patch: { fillRule: "evenodd" } }],
    });
    expect(next.nodes[path.id]).toMatchObject({ fillRule: "evenodd" });

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.nodes[path.id]).toMatchObject({ fillRule: "nonzero" });
  });

  it("reorder-node inverse restores original order", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const [first] = artboard.nodeIds;

    const { document: next, inverse } = applyCommand(doc, {
      type: "reorder-node",
      containerId: artboard.id,
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

  it("reorder-artboard moves the artboard and inverse restores order", () => {
    const base = createInitialDocument();
    let doc = base;
    for (const name of ["Second", "Third"]) {
      doc = applyCommand(doc, {
        type: "add-artboard",
        artboard: { ...getActiveArtboard(base), id: `artboard_${name}`, name, nodeIds: [] },
        nodes: [],
        activate: false,
      }).document;
    }
    const originalOrder = doc.artboards.map((item) => item.id);

    const { document: next, inverse } = applyCommand(doc, {
      type: "reorder-artboard",
      artboardId: originalOrder[0]!,
      toIndex: 2,
    });

    expect(next.artboards.map((item) => item.id)).toEqual([
      originalOrder[1],
      originalOrder[2],
      originalOrder[0],
    ]);
    // Reordering never touches nodes or the active artboard.
    expect(next.activeArtboardId).toBe(doc.activeArtboardId);
    expect(next.nodes).toBe(doc.nodes);

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.artboards.map((item) => item.id)).toEqual(originalOrder);
  });

  it("reorder-artboard no-ops on an unknown artboard and clamps toIndex", () => {
    const doc = createInitialDocument();
    const { document: unchanged } = applyCommand(doc, {
      type: "reorder-artboard",
      artboardId: "missing",
      toIndex: 3,
    });
    expect(unchanged).toBe(doc);

    const { document: clamped, inverse } = applyCommand(doc, {
      type: "reorder-artboard",
      artboardId: doc.activeArtboardId,
      toIndex: 99,
    });
    expect(clamped.artboards.map((item) => item.id)).toEqual(
      doc.artboards.map((item) => item.id),
    );
    const { document: reverted } = applyCommand(clamped, inverse);
    expect(reverted.artboards.map((item) => item.id)).toEqual(
      doc.artboards.map((item) => item.id),
    );
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

  it("rejects inserts that would create orphans, overwrite ids, or dual parents", () => {
    const doc = createInitialDocument();
    const existing = doc.nodes[getActiveArtboard(doc).nodeIds[0]!]!;

    expect(
      applyCommand(doc, {
        type: "insert-nodes",
        artboardId: "missing-artboard",
        nodes: [createRectangle({ x: 0, y: 0 })],
      }).document,
    ).toBe(doc);
    expect(
      applyCommand(doc, {
        type: "insert-nodes",
        artboardId: doc.activeArtboardId,
        nodes: [{ ...createRectangle({ x: 0, y: 0 }), id: existing.id }],
      }).document,
    ).toBe(doc);

    const duplicate = createRectangle({ x: 0, y: 0 });
    expect(
      applyCommand(doc, {
        type: "insert-nodes",
        artboardId: doc.activeArtboardId,
        nodes: [duplicate, { ...duplicate }],
      }).document,
    ).toBe(doc);
  });

  it("rejects an unknown active artboard without poisoning queries", () => {
    const doc = createInitialDocument();
    const next = applyCommand(doc, {
      type: "set-active-artboard",
      artboardId: "missing-artboard",
    }).document;
    expect(next).toBe(doc);
    expect(getActiveArtboard(next).id).toBe(doc.activeArtboardId);
  });

  it("rejects restore entries whose destination container no longer exists", () => {
    const doc = createInitialDocument();
    const node = createRectangle({ x: 0, y: 0 });
    const next = applyCommand(doc, {
      type: "restore-nodes",
      entries: [{ node, containerId: "missing-container", index: 0 }],
    }).document;
    expect(next).toBe(doc);
    expect(next.nodes[node.id]).toBeUndefined();
  });

  it("clamps unsafe runtime patches and gradient stops", () => {
    const doc = createInitialDocument();
    const nodeId = getActiveArtboard(doc).nodeIds[0]!;
    const next = applyCommand(doc, {
      type: "update-nodes",
      updates: [
        {
          nodeId,
          patch: {
            x: Number.NaN,
            width: 0,
            opacity: 4,
            fill: {
              type: "linear-gradient",
              angle: 0,
              stops: [
                { offset: 2, color: "#fff" },
                { offset: -1, color: "#000" },
              ],
            },
          },
        },
      ],
    }).document;
    expect(next.nodes[nodeId]!.x).toBe(doc.nodes[nodeId]!.x);
    expect(next.nodes[nodeId]!.width).toBe(0.01);
    expect(next.nodes[nodeId]!.opacity).toBe(1);
    const fill = next.nodes[nodeId]!.fill;
    expect(fill.type).toBe("linear-gradient");
    if (fill.type === "linear-gradient") {
      expect(fill.stops.map((stop) => stop.offset)).toEqual([0, 1]);
    }
  });
});
