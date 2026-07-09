import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createInitialDocument, createPath, createText } from "./factory";
import {
  pathGeometryLength,
  pathGeometryToSvg,
  reversePathGeometry,
  type PathGeometry,
} from "./path-data";
import { parseDocument } from "./schema";
import type { Effect, LogoDocument, TextNode } from "./types";

/** Document with one artboard holding a path node and a text node. */
function fixture(): {
  document: LogoDocument;
  textId: string;
  pathId: string;
} {
  const base = createInitialDocument();
  const path = createPath({ x: 20, y: 20 });
  const text = createText({ x: 200, y: 200, content: "Curve" });
  const artboard = base.artboards[0]!;
  const document: LogoDocument = {
    ...base,
    nodes: { ...base.nodes, [path.id]: path, [text.id]: text },
    artboards: [
      { ...artboard, nodeIds: [...artboard.nodeIds, path.id, text.id] },
    ],
  };
  return { document, textId: text.id, pathId: path.id };
}

describe("text on a path", () => {
  it("attach and detach via update-nodes are exact inverses", () => {
    const { document, textId, pathId } = fixture();

    const attach = applyCommand(document, {
      type: "update-nodes",
      updates: [
        {
          nodeId: textId,
          patch: { onPath: { pathId, startOffset: 12, flip: false } },
        },
      ],
    });
    const attached = attach.document.nodes[textId] as TextNode;
    expect(attached.onPath).toEqual({ pathId, startOffset: 12, flip: false });

    const undoAttach = applyCommand(attach.document, attach.inverse);
    expect(undoAttach.document.nodes[textId]).toEqual(document.nodes[textId]);

    const detach = applyCommand(attach.document, {
      type: "update-nodes",
      updates: [{ nodeId: textId, patch: { onPath: undefined } }],
    });
    expect((detach.document.nodes[textId] as TextNode).onPath).toBeUndefined();

    const undoDetach = applyCommand(detach.document, detach.inverse);
    expect((undoDetach.document.nodes[textId] as TextNode).onPath).toEqual({
      pathId,
      startOffset: 12,
      flip: false,
    });
  });

  it("offset and flip updates round-trip through undo", () => {
    const { document, textId, pathId } = fixture();
    const attached = applyCommand(document, {
      type: "update-nodes",
      updates: [
        {
          nodeId: textId,
          patch: { onPath: { pathId, startOffset: 0, flip: false } },
        },
      ],
    }).document;

    const moved = applyCommand(attached, {
      type: "update-nodes",
      updates: [
        {
          nodeId: textId,
          patch: { onPath: { pathId, startOffset: 55, flip: true } },
        },
      ],
    });
    expect((moved.document.nodes[textId] as TextNode).onPath).toEqual({
      pathId,
      startOffset: 55,
      flip: true,
    });

    const undone = applyCommand(moved.document, moved.inverse);
    expect((undone.document.nodes[textId] as TextNode).onPath).toEqual({
      pathId,
      startOffset: 0,
      flip: false,
    });
  });

  it("parseDocument accepts onPath and round-trips it", () => {
    const { document, textId, pathId } = fixture();
    const attached = applyCommand(document, {
      type: "update-nodes",
      updates: [
        {
          nodeId: textId,
          patch: { onPath: { pathId, startOffset: 8, flip: true } },
        },
      ],
    }).document;

    const parsed = parseDocument(JSON.parse(JSON.stringify(attached)));
    expect((parsed.nodes[textId] as TextNode).onPath).toEqual({
      pathId,
      startOffset: 8,
      flip: true,
    });
  });

  it("sanitize drops attachments whose path is gone or not a path", () => {
    const { document, textId, pathId } = fixture();
    const attached = applyCommand(document, {
      type: "update-nodes",
      updates: [
        {
          nodeId: textId,
          patch: { onPath: { pathId, startOffset: 0, flip: false } },
        },
      ],
    }).document;

    // Path deleted → attachment stripped on load.
    const withoutPath = applyCommand(attached, {
      type: "delete-nodes",
      nodeIds: [pathId],
    }).document;
    const repaired = parseDocument(JSON.parse(JSON.stringify(withoutPath)));
    expect((repaired.nodes[textId] as TextNode).onPath).toBeUndefined();

    // pathId pointing at a non-path node → also stripped.
    const bogus = JSON.parse(JSON.stringify(attached)) as LogoDocument;
    (bogus.nodes[textId] as TextNode).onPath!.pathId = textId;
    const repaired2 = parseDocument(bogus);
    expect((repaired2.nodes[textId] as TextNode).onPath).toBeUndefined();
  });
});

describe("reversePathGeometry", () => {
  const geometry: PathGeometry = {
    subpaths: [
      {
        closed: false,
        points: [
          { x: 0, y: 0, handleOut: { x: 10, y: -20 } },
          { x: 50, y: 0, handleIn: { x: 40, y: -20 }, handleOut: { x: 60, y: 20 } },
          { x: 100, y: 0, handleIn: { x: 90, y: 20 } },
        ],
      },
    ],
  };

  it("reverses point order and swaps handles", () => {
    const reversed = reversePathGeometry(geometry);
    const points = reversed.subpaths[0]!.points;
    expect(points.map((p) => p.x)).toEqual([100, 50, 0]);
    expect(points[0]!.handleOut).toEqual({ x: 90, y: 20 });
    expect(points[0]!.handleIn).toBeUndefined();
    expect(points[1]!.handleIn).toEqual({ x: 60, y: 20 });
    expect(points[1]!.handleOut).toEqual({ x: 40, y: -20 });
    expect(points[2]!.handleIn).toEqual({ x: 10, y: -20 });
  });

  it("is an involution and preserves length", () => {
    const twice = reversePathGeometry(reversePathGeometry(geometry));
    expect(twice).toEqual(geometry);
    expect(pathGeometryLength(reversePathGeometry(geometry))).toBeCloseTo(
      pathGeometryLength(geometry),
      6,
    );
  });

  it("emits valid SVG for the reversed path", () => {
    const d = pathGeometryToSvg(reversePathGeometry(geometry));
    expect(d.startsWith("M 100 0")).toBe(true);
    expect(d).toContain("C");
  });
});

describe("pathGeometryLength", () => {
  it("is exact for straight segments and scales", () => {
    const line: PathGeometry = {
      subpaths: [
        { closed: false, points: [{ x: 0, y: 0 }, { x: 30, y: 40 }] },
      ],
    };
    expect(pathGeometryLength(line)).toBeCloseTo(50, 6);
    expect(pathGeometryLength(line, 2, 2)).toBeCloseTo(100, 6);
  });

  it("approximates a circle's circumference from bezier arcs", () => {
    // Unit circle from 4 cubic arcs (kappa approximation), radius 50.
    const k = 0.5522847498 * 50;
    const circle: PathGeometry = {
      subpaths: [
        {
          closed: true,
          points: [
            { x: 50, y: 0, handleIn: { x: 50 - k, y: 0 }, handleOut: { x: 50 + k, y: 0 } },
            { x: 100, y: 50, handleIn: { x: 100, y: 50 - k }, handleOut: { x: 100, y: 50 + k } },
            { x: 50, y: 100, handleIn: { x: 50 + k, y: 100 }, handleOut: { x: 50 - k, y: 100 } },
            { x: 0, y: 50, handleIn: { x: 0, y: 50 + k }, handleOut: { x: 0, y: 50 - k } },
          ],
        },
      ],
    };
    const expected = 2 * Math.PI * 50;
    expect(Math.abs(pathGeometryLength(circle) - expected)).toBeLessThan(1);
  });
});

describe("effects", () => {
  const stack: Effect[] = [
    {
      type: "drop-shadow",
      enabled: true,
      dx: 4,
      dy: 6,
      blur: 8,
      color: "#000000",
      opacity: 0.4,
    },
    { type: "outline", enabled: true, width: 3, color: "#4f6bf6", opacity: 1 },
    { type: "bevel", enabled: false, size: 2, soften: 3, intensity: 0.6 },
    { type: "glow", enabled: true, blur: 10, color: "#f59e0b", opacity: 0.8 },
  ];

  it("set and clear via update-nodes are exact inverses", () => {
    const { document, textId } = fixture();

    const set = applyCommand(document, {
      type: "update-nodes",
      updates: [{ nodeId: textId, patch: { effects: stack } }],
    });
    expect(set.document.nodes[textId]!.effects).toEqual(stack);

    const undoSet = applyCommand(set.document, set.inverse);
    expect(undoSet.document.nodes[textId]!.effects).toBeUndefined();

    const clear = applyCommand(set.document, {
      type: "update-nodes",
      updates: [{ nodeId: textId, patch: { effects: undefined } }],
    });
    expect(clear.document.nodes[textId]!.effects).toBeUndefined();

    const undoClear = applyCommand(clear.document, clear.inverse);
    expect(undoClear.document.nodes[textId]!.effects).toEqual(stack);
  });

  it("parseDocument accepts an effect stack on any node type", () => {
    const { document, textId, pathId } = fixture();
    const withFx = applyCommand(document, {
      type: "update-nodes",
      updates: [
        { nodeId: textId, patch: { effects: stack } },
        { nodeId: pathId, patch: { effects: [stack[0]!] } },
      ],
    }).document;

    const parsed = parseDocument(JSON.parse(JSON.stringify(withFx)));
    expect(parsed.nodes[textId]!.effects).toEqual(stack);
    expect(parsed.nodes[pathId]!.effects).toEqual([stack[0]]);
  });

  it("rejects malformed effect entries", () => {
    const { document, textId } = fixture();
    const bad = JSON.parse(JSON.stringify(document)) as LogoDocument;
    (bad.nodes[textId] as { effects?: unknown }).effects = [
      { type: "drop-shadow", enabled: true }, // missing params
    ];
    expect(() => parseDocument(bad)).toThrow();
  });
});
