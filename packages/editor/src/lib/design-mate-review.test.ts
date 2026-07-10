import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createArtboard,
  createInitialDocument,
  createRectangle,
  type ReviewFinding,
} from "@openlogo/core";
import {
  createDesignMateRequestSignature,
  designMateRequestSignaturesEqual,
  isDesignMateReviewStale,
  resolveDesignMateFocus,
} from "./design-mate-review";

function artboardOnlyFinding(artboardId: string): ReviewFinding {
  return {
    id: "test.artboard",
    severity: "info",
    category: "production",
    kind: "objective",
    title: "Review artboard",
    detail: "Inspect the complete lockup.",
    action: "Show the artboard.",
    artboardId,
    evidence: [{ label: "Artboards", value: 1 }],
    suggestedActions: [{ id: "show-artboard", label: "Show the artboard." }],
  };
}

describe("Design Mate review integration", () => {
  it("marks results stale when document identity, generation, or revision changes", () => {
    const identity = {
      documentId: "doc-a",
      schemaVersion: 5,
      generation: 2,
      revision: 7,
      contentFingerprint: "fingerprint",
    };

    expect(
      isDesignMateReviewStale(identity, {
        documentId: "doc-a",
        generation: 2,
        revision: 7,
      }),
    ).toBe(false);
    expect(
      isDesignMateReviewStale(identity, {
        documentId: "doc-a",
        generation: 2,
        revision: 8,
      }),
    ).toBe(true);
    expect(
      isDesignMateReviewStale(identity, {
        documentId: "doc-b",
        generation: 3,
        revision: 0,
      }),
    ).toBe(true);
  });

  it("invalidates only request context that can change review output", () => {
    const selectionA = createDesignMateRequestSignature("selection", {
      selectedNodeIds: ["node-b", "node-a"],
      keyObjectId: "node-a",
    });
    const selectionAReordered = createDesignMateRequestSignature("selection", {
      selectedNodeIds: ["node-a", "node-b"],
      keyObjectId: "node-a",
    });
    const selectionB = createDesignMateRequestSignature("selection", {
      selectedNodeIds: ["node-c"],
    });

    expect(
      designMateRequestSignaturesEqual(selectionA, selectionAReordered),
    ).toBe(true);
    expect(designMateRequestSignaturesEqual(selectionA, selectionB)).toBe(
      false,
    );
    expect(
      designMateRequestSignaturesEqual(
        createDesignMateRequestSignature("active-artboard", {
          selectedNodeIds: ["node-a"],
        }),
        createDesignMateRequestSignature("active-artboard", {
          selectedNodeIds: ["node-b"],
        }),
      ),
    ).toBe(true);
    expect(
      designMateRequestSignaturesEqual(
        createDesignMateRequestSignature("active-artboard", {
          selectedNodeIds: [],
        }),
        createDesignMateRequestSignature("document", {
          selectedNodeIds: [],
        }),
      ),
    ).toBe(false);
  });

  it("prefers valid node references and falls back to an artboard target", () => {
    const document = createInitialDocument();
    const artboard = document.artboards[0]!;
    const nodeId = artboard.nodeIds[0]!;
    const nodeFinding = {
      ...artboardOnlyFinding(artboard.id),
      nodeIds: [nodeId],
    };

    const nodeTarget = resolveDesignMateFocus(document, {
      ...nodeFinding,
      nodeIds: ["missing", nodeId],
    });
    expect(nodeTarget).toMatchObject({
      type: "nodes",
      nodeIds: [nodeId],
    });

    expect(
      resolveDesignMateFocus(document, artboardOnlyFinding(artboard.id)),
    ).toEqual({
      type: "artboard",
      artboardId: artboard.id,
      bounds: {
        x: artboard.x,
        y: artboard.y,
        width: artboard.width,
        height: artboard.height,
      },
    });
  });

  it("converts secondary-artboard node bounds to world coordinates", () => {
    const initial = createInitialDocument();
    const node = createRectangle({ x: 24, y: 32 });
    const artboard = createArtboard("icon", {
      x: 900,
      y: 120,
      nodeIds: [node.id],
    });
    const document = applyCommand(initial, {
      type: "add-artboard",
      artboard,
      nodes: [node],
      activate: false,
    }).document;

    expect(
      resolveDesignMateFocus(document, {
        ...artboardOnlyFinding(artboard.id),
        nodeIds: [node.id],
      }),
    ).toMatchObject({
      type: "nodes",
      nodeIds: [node.id],
      artboardId: artboard.id,
      bounds: {
        x: artboard.x + node.x,
        y: artboard.y + node.y,
        width: node.width,
        height: node.height,
      },
    });
  });
});
