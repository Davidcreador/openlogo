import {
  createArtboard,
  createGroup,
  createInitialDocument,
  createRectangle,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_CONTEXT_LIMITS,
  buildDesignContext,
  prepareDesignMateReviewRequest,
} from "./index";

describe("selection scope normalization", () => {
  it("falls back to the active artboard when an existing group has no leaves", () => {
    const document = createInitialDocument();
    const emptyGroup = createGroup([]);
    document.nodes = { ...document.nodes, [emptyGroup.id]: emptyGroup };
    document.artboards = document.artboards.map((artboard) =>
      artboard.id === document.activeArtboardId
        ? { ...artboard, nodeIds: [...artboard.nodeIds, emptyGroup.id] }
        : artboard,
    );

    const request = prepareDesignMateReviewRequest(
      document,
      { selectedNodeIds: [emptyGroup.id] },
      { scope: "selection", generation: 0, revision: 0 },
    );

    expect(request.scope).toBe("active-artboard");
    expect(request.context.scope).toBe("active-artboard");
    expect(request.context.metrics.selectedNodeCount).toBe(1);
    expect(request.context.metrics.scopeLeafNodeCount).toBe(
      request.context.metrics.activeArtboardLeafNodeCount,
    );
  });
});

describe("selected-node context", () => {
  it("identifies owning artboards and translates bounds to world space", () => {
    const document = createInitialDocument();
    const activeArtboard = document.artboards[0]!;
    const activeNodeId = activeArtboard.nodeIds[0]!;
    const remoteNode = createRectangle({ x: 18, y: 27, fill: "#123456" });
    remoteNode.id = `node_${"r".repeat(
      DESIGN_CONTEXT_LIMITS.nameLength + 40,
    )}`;
    remoteNode.width = 45;
    remoteNode.height = 35;

    const remoteArtboard = createArtboard("icon", {
      name: "Remote icon",
      x: 1_200,
      y: -320,
      width: 240,
      height: 240,
      background: "#fef3c7",
      nodeIds: [remoteNode.id],
    });
    remoteArtboard.id = `artboard_${"a".repeat(
      DESIGN_CONTEXT_LIMITS.nameLength + 40,
    )}`;
    document.nodes = { ...document.nodes, [remoteNode.id]: remoteNode };
    document.artboards = [...document.artboards, remoteArtboard];

    const context = buildDesignContext(
      document,
      { selectedNodeIds: [activeNodeId, remoteNode.id] },
      { scope: "selection" },
    );
    const activeSummary = context.selectedNodes.find(
      (node) => node.id === activeNodeId,
    );
    const remoteSummary = context.selectedNodes.find(
      (node) => node.id === remoteNode.id,
    );

    expect(activeSummary?.artboard?.id).toBe(activeArtboard.id);
    expect(activeSummary?.artboard?.background).toBe(
      activeArtboard.background,
    );
    expect(remoteSummary).toMatchObject({
      id: remoteNode.id,
      type: "rectangle",
      bounds: { x: 18, y: 27, width: 45, height: 35 },
      worldBounds: { x: 1_218, y: -293, width: 45, height: 35 },
      artboard: {
        id: remoteArtboard.id,
        name: "Remote icon",
        nameTruncated: false,
        purpose: "icon",
        x: 1_200,
        y: -320,
        width: 240,
        height: 240,
        background: "#fef3c7",
      },
    });
    expect(remoteSummary?.id).toBe(remoteNode.id);
    expect(remoteSummary?.artboard?.id).toBe(remoteArtboard.id);
    expect(remoteSummary?.id).toHaveLength(remoteNode.id.length);
    expect(remoteSummary?.artboard?.id).toHaveLength(remoteArtboard.id.length);
  });

  it("reports derived group geometry without placeholder visual properties", () => {
    const document = createInitialDocument();
    const clippingMask = createRectangle({ x: 10, y: 20, fill: "#ffffff" });
    clippingMask.id = `mask_${"m".repeat(
      DESIGN_CONTEXT_LIMITS.nameLength + 50,
    )}`;
    clippingMask.width = 100;
    clippingMask.height = 80;
    const content = createRectangle({ x: 20, y: 30, fill: "#ef4444" });
    content.width = 120;
    content.height = 80;
    const group = createGroup([clippingMask.id, content.id]);
    group.clippingMaskId = clippingMask.id;
    group.rotation = 137;
    group.fill = { type: "solid", color: "#00ff00" };
    group.stroke = { color: "#000000", width: 19, align: "outside" };
    group.opacity = 0.45;
    group.visible = false;
    group.locked = true;

    const artboard = createArtboard("stacked", {
      name: "Clipped group board",
      x: 500,
      y: 700,
      background: "#0f172a",
      nodeIds: [group.id],
    });
    document.activeArtboardId = artboard.id;
    document.artboards = [artboard];
    document.nodes = {
      [group.id]: group,
      [clippingMask.id]: clippingMask,
      [content.id]: content,
    };

    const context = buildDesignContext(
      document,
      { selectedNodeIds: [group.id] },
      { scope: "selection" },
    );
    const summary = context.selectedNodes[0];

    expect(summary?.type).toBe("group");
    if (!summary || summary.type !== "group") {
      throw new Error("Expected a selected group summary.");
    }
    expect(summary).toMatchObject({
      bounds: { x: 20, y: 30, width: 90, height: 70 },
      worldBounds: { x: 520, y: 730, width: 90, height: 70 },
      rotation: null,
      opacity: 0.45,
      visible: false,
      locked: true,
      childCount: 2,
      clippingMaskId: clippingMask.id,
      artboard: {
        id: artboard.id,
        background: "#0f172a",
        x: 500,
        y: 700,
      },
    });
    expect(summary).not.toHaveProperty("fill");
    expect(summary).not.toHaveProperty("stroke");
    expect(summary.clippingMaskId).toBe(clippingMask.id);
  });
});
