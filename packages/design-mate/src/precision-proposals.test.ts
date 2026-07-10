import {
  applyCommand,
  createArtboard,
  createEllipse,
  createGroup,
  createInitialDocument,
  unitBounds,
  visualBounds,
} from "@openlogo/core";
import type {
  LogoDocument,
  PathNode,
  TextNode,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_PROPOSAL_LIMITS,
  isValidDesignMateProposal,
  prepareDesignMateProposal,
  type DesignMateAction,
  type DesignMateProposal,
  type PrepareDesignMateProposalResult,
  type PreparedDesignMateProposal,
} from "./index";

function textNode(document: LogoDocument): TextNode {
  return Object.values(document.nodes).find(
    (node): node is TextNode => node.type === "text",
  )!;
}

function pathNode(document: LogoDocument): PathNode {
  return Object.values(document.nodes).find(
    (node): node is PathNode => node.type === "path",
  )!;
}

function proposal(actions: readonly DesignMateAction[]): DesignMateProposal {
  return {
    id: "precision-proposal",
    label: "Apply precision edits",
    rationale: "Exercises the bounded precision action surface.",
    risk: "medium",
    actions,
  };
}

function prepared(result: PrepareDesignMateProposalResult): PreparedDesignMateProposal {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.prepared;
}

function expectFailure(
  result: PrepareDesignMateProposalResult,
  code?: "invalid-proposal" | "precondition-failed" | "no-op" | "preparation-failed",
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected precision proposal preparation to fail.");
  }
  if (code) {
    expect(result.error.code).toBe(code);
  }
}

describe("precision action validation", () => {
  it("accepts every bounded precision action", () => {
    const actions: DesignMateAction[] = [
      { type: "translate-nodes", nodeIds: ["a"], dx: 4, dy: -2 },
      { type: "scale-nodes", nodeIds: ["a"], scaleX: 1.1, scaleY: 0.9 },
      { type: "rotate-nodes", nodeIds: ["a"], degrees: 15 },
      {
        type: "align-nodes",
        nodeIds: ["a", "b"],
        edge: "centerX",
        reference: "key-object",
        keyObjectId: "a",
      },
      {
        type: "distribute-nodes",
        nodeIds: ["a", "b", "c"],
        axis: "horizontal",
      },
      { type: "set-font-family", nodeId: "a", fontFamily: "Inter" },
      { type: "set-font-size", nodeId: "a", fontSize: 64 },
      { type: "set-font-weight", nodeId: "a", fontWeight: 600 },
      { type: "set-opacity", nodeId: "a", opacity: 0.75 },
      { type: "set-stroke-color", nodeId: "a", color: "#abc" },
      { type: "set-stroke-width", nodeId: "a", width: 3.5 },
    ];
    expect(isValidDesignMateProposal(proposal(actions))).toBe(true);
  });

  it("rejects malformed references and out-of-range numeric values", () => {
    const invalidActions: unknown[] = [
      { type: "translate-nodes", nodeIds: ["a", "a"], dx: 1, dy: 1 },
      { type: "translate-nodes", nodeIds: ["a"], dx: Number.NaN, dy: 1 },
      { type: "scale-nodes", nodeIds: ["a"], scaleX: 0, scaleY: 1 },
      { type: "rotate-nodes", nodeIds: ["a"], degrees: 181 },
      {
        type: "align-nodes",
        nodeIds: ["a", "b"],
        edge: "left",
        reference: "key-object",
        keyObjectId: "missing",
      },
      {
        type: "align-nodes",
        nodeIds: ["a"],
        edge: "left",
        reference: "selection",
        keyObjectId: null,
      },
      {
        type: "distribute-nodes",
        nodeIds: ["a", "b"],
        axis: "horizontal",
      },
      { type: "set-font-family", nodeId: "a", fontFamily: "   " },
      { type: "set-font-size", nodeId: "a", fontSize: 0.5 },
      { type: "set-font-weight", nodeId: "a", fontWeight: 550.5 },
      { type: "set-opacity", nodeId: "a", opacity: 1.01 },
      {
        type: "set-stroke-width",
        nodeId: "a",
        width: DESIGN_MATE_PROPOSAL_LIMITS.maximumStrokeWidth + 1,
      },
    ];
    for (const action of invalidActions) {
      expect(
        isValidDesignMateProposal({
          ...proposal([]),
          actions: [action],
        }),
      ).toBe(false);
    }
  });
});

describe("precision proposal compilation", () => {
  it("compiles typography, opacity, and existing-stroke edits atomically", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const path = pathNode(document);
    path.stroke = {
      color: "#123456",
      width: 2,
      align: "center",
      paint: { type: "solid", color: "#123456" },
    };
    const before = structuredClone(document);

    const result = prepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "set-font-family",
            nodeId: text.id,
            fontFamily: "Montserrat",
          },
          { type: "set-font-size", nodeId: text.id, fontSize: 64 },
          { type: "set-font-weight", nodeId: text.id, fontWeight: 600 },
          { type: "set-opacity", nodeId: path.id, opacity: 0.75 },
          { type: "set-stroke-color", nodeId: path.id, color: "#ABC" },
          { type: "set-stroke-width", nodeId: path.id, width: 4 },
        ]),
        { generation: 2, revision: 5 },
      ),
    );

    expect(document).toEqual(before);
    expect(result.command.commands).toHaveLength(6);
    expect(result.previewDocument.nodes[text.id]).toMatchObject({
      fontFamily: "Montserrat",
      fontSize: 64,
      fontWeight: 600,
    });
    expect(result.previewDocument.nodes[path.id]).toMatchObject({
      opacity: 0.75,
      stroke: {
        color: "#aabbcc",
        width: 4,
        paint: { type: "solid", color: "#aabbcc" },
      },
    });
    expect(result.impact.changedNodeIds).toEqual([text.id, path.id]);
    expect(applyCommand(document, result.command).document).toEqual(
      result.previewDocument,
    );
  });

  it("compiles move, scale, rotate, align, and distribution as leaf updates", () => {
    const document = createInitialDocument();
    const [accentId, markId, textId] = document.artboards[0]!.nodeIds;
    const before = structuredClone(document);

    const result = prepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "align-nodes",
            nodeIds: [accentId!, markId!],
            edge: "top",
            reference: "selection",
            keyObjectId: null,
          },
          {
            type: "distribute-nodes",
            nodeIds: [accentId!, markId!, textId!],
            axis: "horizontal",
          },
          {
            type: "translate-nodes",
            nodeIds: [accentId!, markId!, textId!],
            dx: 10,
            dy: 5,
          },
          {
            type: "scale-nodes",
            nodeIds: [accentId!, markId!],
            scaleX: 1.1,
            scaleY: 1.1,
          },
          {
            type: "rotate-nodes",
            nodeIds: [markId!],
            degrees: 15,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    expect(document).toEqual(before);
    expect(result.command.commands).toHaveLength(5);
    expect(new Set(result.impact.changedNodeIds)).toEqual(
      new Set([accentId, markId, textId]),
    );
    expect(result.previewDocument.nodes[markId!]!.rotation).toBe(15);
    expect(applyCommand(document, result.command).document).toEqual(
      result.previewDocument,
    );
  });

  it("aligns a single unit to its owning artboard", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const artboard = document.artboards[0]!;
    const result = prepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "align-nodes",
            nodeIds: [text.id],
            edge: "centerX",
            reference: "artboard",
            keyObjectId: null,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
    const bounds = unitBounds(result.previewDocument, text.id)!;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(artboard.width / 2);
  });

  it("aligns rotated leaves by their visual bounds", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const artboard = document.artboards[0]!;
    text.rotation = 45;
    const result = prepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "align-nodes",
            nodeIds: [text.id],
            edge: "right",
            reference: "artboard",
            keyObjectId: null,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
    const bounds = visualBounds(result.previewDocument, text.id)!;
    expect(bounds.x + bounds.width).toBeCloseTo(artboard.width);
  });

  it("scales text exactly and rejects non-uniform rotated transforms", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    text.fontSize = 10;
    const result = prepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "scale-nodes",
            nodeIds: [text.id],
            scaleX: 1,
            scaleY: 0.5,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
    expect(result.previewDocument.nodes[text.id]).toMatchObject({
      fontSize: 5,
      height: text.height * 0.5,
    });

    const rotated = createInitialDocument();
    const path = pathNode(rotated);
    path.rotation = 90;
    expectFailure(
      prepareDesignMateProposal(
        rotated,
        proposal([
          {
            type: "scale-nodes",
            nodeIds: [path.id],
            scaleX: 2,
            scaleY: 1,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );
  });

  it("rejects no-op, cross-artboard, overlapping, and text-path geometry", () => {
    const base = createInitialDocument();
    const [accentId, markId] = base.artboards[0]!.nodeIds;
    expectFailure(
      prepareDesignMateProposal(
        base,
        proposal([
          {
            type: "translate-nodes",
            nodeIds: [accentId!],
            dx: 0,
            dy: 0,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "no-op",
    );

    const crossArtboard = structuredClone(base);
    const otherNode = createEllipse({ x: 20, y: 20 });
    const otherArtboard = createArtboard("icon", {
      name: "Other",
      x: 900,
      nodeIds: [otherNode.id],
    });
    crossArtboard.nodes[otherNode.id] = otherNode;
    crossArtboard.artboards.push(otherArtboard);
    expectFailure(
      prepareDesignMateProposal(
        crossArtboard,
        proposal([
          {
            type: "translate-nodes",
            nodeIds: [accentId!, otherNode.id],
            dx: 5,
            dy: 0,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );

    const overlapping = structuredClone(base);
    const group = createGroup([accentId!]);
    overlapping.nodes[group.id] = group;
    overlapping.artboards[0]!.nodeIds = [
      group.id,
      ...overlapping.artboards[0]!.nodeIds.filter((id) => id !== accentId),
    ];
    expectFailure(
      prepareDesignMateProposal(
        overlapping,
        proposal([
          {
            type: "rotate-nodes",
            nodeIds: [group.id, accentId!],
            degrees: 10,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );

    const textPath = structuredClone(base);
    const text = textNode(textPath);
    text.onPath = { pathId: markId!, startOffset: 0, flip: false };
    expectFailure(
      prepareDesignMateProposal(
        textPath,
        proposal([
          {
            type: "scale-nodes",
            nodeIds: [text.id],
            scaleX: 1.2,
            scaleY: 1.2,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );
  });

  it("binds chat geometry and key-object alignment to the captured selection", () => {
    const document = createInitialDocument();
    const [accentId, markId] = document.artboards[0]!.nodeIds;
    expectFailure(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "translate-nodes",
            nodeIds: [markId!],
            dx: 5,
            dy: 0,
          },
        ]),
        {
          generation: 0,
          revision: 0,
          geometrySelection: {
            selectedNodeIds: [accentId!],
          },
        },
      ),
      "precondition-failed",
    );

    expectFailure(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "align-nodes",
            nodeIds: [accentId!, markId!],
            edge: "left",
            reference: "key-object",
            keyObjectId: markId!,
          },
        ]),
        {
          generation: 0,
          revision: 0,
          geometrySelection: {
            selectedNodeIds: [accentId!, markId!],
            keyObjectId: accentId!,
          },
        },
      ),
      "precondition-failed",
    );
  });

  it("rejects hidden or locked descendants and unsafe output geometry", () => {
    const restricted = createInitialDocument();
    const accentId = restricted.artboards[0]!.nodeIds[0]!;
    restricted.nodes[accentId]!.locked = true;
    expectFailure(
      prepareDesignMateProposal(
        restricted,
        proposal([
          {
            type: "translate-nodes",
            nodeIds: [accentId],
            dx: 1,
            dy: 1,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );

    const unsafe = createInitialDocument();
    const unsafeId = unsafe.artboards[0]!.nodeIds[0]!;
    unsafe.nodes[unsafeId]!.width =
      DESIGN_MATE_PROPOSAL_LIMITS.maximumGeometryMagnitude;
    expectFailure(
      prepareDesignMateProposal(
        unsafe,
        proposal([
          {
            type: "scale-nodes",
            nodeIds: [unsafeId],
            scaleX: 2,
            scaleY: 1,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );
  });

  it("rejects absent and gradient strokes without mutating the document", () => {
    const document = createInitialDocument();
    const path = pathNode(document);
    const before = structuredClone(document);
    expectFailure(
      prepareDesignMateProposal(
        document,
        proposal([
          { type: "set-stroke-width", nodeId: path.id, width: 4 },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );
    expect(document).toEqual(before);

    path.stroke = {
      color: "#000000",
      width: 2,
      align: "center",
      paint: {
        type: "linear-gradient",
        angle: 0,
        stops: [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#ffffff" },
        ],
      },
    };
    const gradientBefore = structuredClone(document);
    expectFailure(
      prepareDesignMateProposal(
        document,
        proposal([
          { type: "set-stroke-color", nodeId: path.id, color: "#ffffff" },
        ]),
        { generation: 0, revision: 0 },
      ),
      "precondition-failed",
    );
    expect(document).toEqual(gradientBefore);
  });
});
