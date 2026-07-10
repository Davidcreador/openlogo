import {
  type LogoDocument,
  type PathGeometry,
  createEllipse,
  createGroup,
  createInitialDocument,
  createRectangle,
  createText,
  pathNodeLocalGeometry,
  pathGeometryToSvg,
  rotatePoint,
} from "@openlogo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentToSvg } from "./export";
import { documentStore } from "../state/document";

const mocks = vi.hoisted(() => ({
  compoundNodes: vi.fn(),
  getCanvasKit: vi.fn(),
}));

vi.mock("@openlogo/renderer", () => ({
  compoundNodes: mocks.compoundNodes,
}));

vi.mock("./canvaskit", () => ({
  getCanvasKit: mocks.getCanvasKit,
}));

import {
  canMakeCompoundPath,
  canReleaseCompoundPath,
  makeCompoundPath,
  releaseCompoundPath,
} from "./compound-path";

const geometry: PathGeometry = {
  subpaths: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    },
    {
      closed: true,
      points: [
        { x: 25, y: 25 },
        { x: 75, y: 25 },
        { x: 75, y: 75 },
        { x: 25, y: 75 },
      ],
    },
  ],
};

function fixture(): {
  document: LogoDocument;
  firstId: string;
  secondId: string;
  textId: string;
} {
  const document = createInitialDocument();
  const artboard = document.artboards[0]!;
  const first = createRectangle({ x: 0, y: 0, fill: "#ef4444" });
  first.name = "Back shape";
  const second = createEllipse({ x: 20, y: 20, fill: "#3b82f6" });
  const text = createText({ x: 0, y: 0, content: "Attached" });
  artboard.nodeIds = [first.id, second.id, text.id];
  document.nodes = {
    [first.id]: first,
    [second.id]: second,
    [text.id]: text,
  };
  return {
    document,
    firstId: first.id,
    secondId: second.id,
    textId: text.id,
  };
}

beforeEach(() => {
  mocks.compoundNodes.mockReset();
  mocks.getCanvasKit.mockReset();
  mocks.getCanvasKit.mockResolvedValue({});
  mocks.compoundNodes.mockReturnValue({
    d: pathGeometryToSvg(geometry),
    fillRule: "evenodd",
    geometry,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
});

describe("makeCompoundPath", () => {
  it("exports every path with an explicit fill rule", () => {
    const document = createInitialDocument();
    expect(documentToSvg(document)).toContain('fill-rule="nonzero"');
    const path = Object.values(document.nodes).find(
      (node) => node.type === "path",
    );
    expect(path).toBeDefined();
    if (path?.type === "path") {
      path.fillRule = "evenodd";
      expect(documentToSvg(document)).toContain('fill-rule="evenodd"');
    }
  });

  it("atomically replaces sibling shapes with one editable even-odd path", async () => {
    const { document, firstId, secondId, textId } = fixture();
    documentStore.reset(document);

    expect(canMakeCompoundPath([firstId, secondId])).toBe(true);
    const compoundId = await makeCompoundPath([firstId, secondId]);

    expect(compoundId).toBeTruthy();
    const compound = documentStore.document.nodes[compoundId!];
    expect(compound).toMatchObject({
      type: "path",
      name: "Compound path",
      fillRule: "evenodd",
      fill: { type: "solid", color: "#ef4444" },
      geometry,
    });
    expect(documentStore.document.nodes[firstId]).toBeUndefined();
    expect(documentStore.document.nodes[secondId]).toBeUndefined();
    expect(documentStore.document.nodes[textId]).toBeDefined();
    expect(documentStore.document.artboards[0]!.nodeIds).toEqual([
      compoundId,
      textId,
    ]);
    expect(documentToSvg(documentStore.document)).toContain(
      'fill-rule="evenodd"',
    );

    documentStore.undo();
    expect(documentStore.document.nodes[compoundId!]).toBeUndefined();
    expect(documentStore.document.nodes[firstId]).toBeDefined();
    expect(documentStore.document.nodes[secondId]).toBeDefined();
    expect(documentStore.document.nodes[textId]).toBeDefined();
  });

  it("preserves every operand when conversion fails", async () => {
    const { document, firstId, secondId } = fixture();
    documentStore.reset(document);
    mocks.compoundNodes.mockReturnValue(null);
    const before = documentStore.document;

    await expect(makeCompoundPath([firstId, secondId])).resolves.toBeNull();
    expect(documentStore.document).toBe(before);
    expect(documentStore.document.nodes[firstId]).toBeDefined();
    expect(documentStore.document.nodes[secondId]).toBeDefined();
  });

  it("rejects text, locked nodes, and ambiguous text-path attachments", () => {
    const { document, firstId, secondId, textId } = fixture();
    documentStore.reset(document);
    expect(canMakeCompoundPath([firstId, textId])).toBe(false);

    const text = document.nodes[textId]!;
    if (text.type === "text") {
      text.onPath = { pathId: firstId, startOffset: 7, flip: false };
    }
    documentStore.reset(document);
    expect(canMakeCompoundPath([firstId, secondId])).toBe(false);

    if (text.type === "text") {
      delete text.onPath;
    }
    const second = document.nodes[secondId]!;
    second.locked = true;
    documentStore.reset(document);
    expect(canMakeCompoundPath([firstId, secondId])).toBe(false);
  });

  it("rejects operands from different containers", () => {
    const { document, firstId, secondId, textId } = fixture();
    const group = createGroup([secondId]);
    document.nodes[group.id] = group;
    document.artboards[0]!.nodeIds = [firstId, group.id, textId];
    documentStore.reset(document);

    expect(canMakeCompoundPath([firstId, secondId])).toBe(false);
  });

  it("rejects operands inside a locked ancestor group", () => {
    const { document, firstId, secondId } = fixture();
    const group = createGroup([firstId, secondId]);
    group.locked = true;
    document.nodes[group.id] = group;
    document.artboards[0]!.nodeIds = [group.id];
    documentStore.reset(document);

    expect(canMakeCompoundPath([firstId, secondId])).toBe(false);
  });
});

describe("releaseCompoundPath", () => {
  it("splits contours into independent siblings and undoes atomically", () => {
    const document = createInitialDocument();
    const artboard = document.artboards[0]!;
    const compound = Object.values(document.nodes).find(
      (node) => node.type === "path",
    );
    expect(compound?.type).toBe("path");
    if (compound?.type !== "path") {
      return;
    }
    compound.name = "Badge";
    compound.geometry = geometry;
    compound.d = pathGeometryToSvg(geometry);
    compound.intrinsicWidth = 100;
    compound.intrinsicHeight = 100;
    compound.width = 200;
    compound.height = 100;
    compound.rotation = 30;
    compound.fillRule = "evenodd";
    compound.opacity = 0.61;
    compound.fill = { type: "solid", color: "#14b8a6" };
    compound.stroke = { color: "#1f2937", width: 3, align: "center" };
    compound.blendMode = "multiply";
    compound.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 4,
        dy: 5,
        blur: 8,
        color: "#000000",
        opacity: 0.35,
      },
    ];
    compound.geometry.subpaths[0]!.points[0]!.handleOut = { x: 12, y: -18 };
    compound.geometry.subpaths[0]!.points[1]!.handleIn = { x: 88, y: -18 };
    compound.d = pathGeometryToSvg(compound.geometry);
    artboard.nodeIds = [compound.id];
    document.nodes = { [compound.id]: compound };
    const pivot = {
      x: compound.x + compound.width / 2,
      y: compound.y + compound.height / 2,
    };
    const expectedPoints = pathNodeLocalGeometry(compound)!.subpaths.map(
      (subpath) =>
        subpath.points.map((point) => ({
          ...rotatePoint(point, pivot, 30),
          ...(point.handleIn
            ? { handleIn: rotatePoint(point.handleIn, pivot, 30) }
            : {}),
          ...(point.handleOut
            ? { handleOut: rotatePoint(point.handleOut, pivot, 30) }
            : {}),
        })),
    );
    documentStore.reset(document);

    expect(canReleaseCompoundPath([compound.id])).toBe(true);
    const ids = releaseCompoundPath([compound.id]);

    expect(ids).toHaveLength(2);
    expect(documentStore.document.nodes[compound.id]).toBeUndefined();
    expect(documentStore.document.artboards[0]!.nodeIds).toEqual(ids);
    for (const [index, id] of ids!.entries()) {
      const released = documentStore.document.nodes[id!];
      expect(released).toMatchObject({
        type: "path",
        name: `Badge ${index + 1}`,
        rotation: 30,
        fillRule: "evenodd",
        opacity: 0.61,
        fill: { type: "solid", color: "#14b8a6" },
        stroke: { color: "#1f2937", width: 3, align: "center" },
        blendMode: "multiply",
        effects: compound.effects,
      });
      if (released?.type === "path") {
        expect(released.width / released.intrinsicWidth).toBeCloseTo(2);
        expect(released.height / released.intrinsicHeight).toBeCloseTo(1);
        const releasedPivot = {
          x: released.x + released.width / 2,
          y: released.y + released.height / 2,
        };
        const points = pathNodeLocalGeometry(released)!.subpaths[0]!.points.map(
          (point) => ({
            ...rotatePoint(point, releasedPivot, released.rotation),
            ...(point.handleIn
              ? {
                  handleIn: rotatePoint(
                    point.handleIn,
                    releasedPivot,
                    released.rotation,
                  ),
                }
              : {}),
            ...(point.handleOut
              ? {
                  handleOut: rotatePoint(
                    point.handleOut,
                    releasedPivot,
                    released.rotation,
                  ),
                }
              : {}),
          }),
        );
        for (const [pointIndex, point] of points.entries()) {
          const expected = expectedPoints[index]![pointIndex]!;
          expect(point.x).toBeCloseTo(expected.x);
          expect(point.y).toBeCloseTo(expected.y);
          if (expected.handleIn) {
            expect(point.handleIn?.x).toBeCloseTo(expected.handleIn.x);
            expect(point.handleIn?.y).toBeCloseTo(expected.handleIn.y);
          }
          if (expected.handleOut) {
            expect(point.handleOut?.x).toBeCloseTo(expected.handleOut.x);
            expect(point.handleOut?.y).toBeCloseTo(expected.handleOut.y);
          }
        }
      }
    }

    documentStore.undo();
    expect(documentStore.document.nodes[compound.id]).toMatchObject({
      rotation: 30,
      geometry,
    });
    expect(documentStore.document.artboards[0]!.nodeIds).toEqual([
      compound.id,
    ]);
  });

  it("rejects single contours, locked paths, and text-path attachments", () => {
    const { document, textId } = fixture();
    const path = Object.values(createInitialDocument().nodes).find(
      (node) => node.type === "path",
    );
    expect(path?.type).toBe("path");
    if (path?.type !== "path") {
      return;
    }
    path.geometry = geometry;
    path.d = pathGeometryToSvg(geometry);
    const text = document.nodes[textId];
    if (text?.type === "text") {
      text.onPath = { pathId: path.id, startOffset: 0, flip: false };
    }
    document.artboards[0]!.nodeIds = [path.id, textId];
    document.nodes = { [path.id]: path, [textId]: text! };
    documentStore.reset(document);
    expect(canReleaseCompoundPath([path.id])).toBe(false);

    if (text?.type === "text") {
      delete text.onPath;
    }
    path.locked = true;
    documentStore.reset(document);
    expect(canReleaseCompoundPath([path.id])).toBe(false);

    path.locked = false;
    const first = document.nodes[path.id];
    if (first?.type === "path" && first.geometry) {
      first.geometry = { subpaths: [first.geometry.subpaths[0]!] };
      first.d = pathGeometryToSvg(first.geometry);
    }
    documentStore.reset(document);
    expect(canReleaseCompoundPath([path.id])).toBe(false);
    expect(releaseCompoundPath([path.id, textId])).toBeNull();
  });

  it("replaces the source at its exact position inside a group", () => {
    const document = createInitialDocument();
    const compound = Object.values(document.nodes).find(
      (node) => node.type === "path",
    );
    expect(compound?.type).toBe("path");
    if (compound?.type !== "path") {
      return;
    }
    compound.geometry = structuredClone(geometry);
    compound.d = pathGeometryToSvg(compound.geometry);
    compound.intrinsicWidth = 100;
    compound.intrinsicHeight = 100;
    const before = createRectangle({ x: -20, y: 0 });
    const after = createEllipse({ x: 140, y: 0 });
    const group = createGroup([before.id, compound.id, after.id]);
    document.artboards[0]!.nodeIds = [group.id];
    document.nodes = {
      [before.id]: before,
      [compound.id]: compound,
      [after.id]: after,
      [group.id]: group,
    };
    documentStore.reset(document);

    const ids = releaseCompoundPath([compound.id]);

    expect(ids).toHaveLength(2);
    const releasedGroup = documentStore.document.nodes[group.id];
    expect(
      releasedGroup?.type === "group" ? releasedGroup.children : null,
    ).toEqual([before.id, ...ids!, after.id]);

    documentStore.undo();
    const restoredGroup = documentStore.document.nodes[group.id];
    expect(
      restoredGroup?.type === "group" ? restoredGroup.children : null,
    ).toEqual([before.id, compound.id, after.id]);
  });

  it("fails closed without mutation for locked ancestors or invalid contours", () => {
    const document = createInitialDocument();
    const compound = Object.values(document.nodes).find(
      (node) => node.type === "path",
    );
    expect(compound?.type).toBe("path");
    if (compound?.type !== "path") {
      return;
    }
    compound.geometry = structuredClone(geometry);
    compound.d = pathGeometryToSvg(compound.geometry);
    const group = createGroup([compound.id]);
    group.locked = true;
    document.artboards[0]!.nodeIds = [group.id];
    document.nodes = { [compound.id]: compound, [group.id]: group };
    documentStore.reset(document);
    const lockedDocument = documentStore.document;

    expect(canReleaseCompoundPath([compound.id])).toBe(false);
    expect(releaseCompoundPath([compound.id])).toBeNull();
    expect(documentStore.document).toBe(lockedDocument);

    group.locked = false;
    compound.geometry.subpaths[1] = { closed: true, points: [] };
    compound.d = pathGeometryToSvg(compound.geometry);
    documentStore.reset(document);
    const invalidDocument = documentStore.document;

    expect(canReleaseCompoundPath([compound.id])).toBe(false);
    expect(releaseCompoundPath([compound.id])).toBeNull();
    expect(documentStore.document).toBe(invalidDocument);
  });
});
