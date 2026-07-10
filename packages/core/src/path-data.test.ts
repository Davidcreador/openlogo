import { describe, expect, it } from "vitest";
import {
  PATH_INTRINSIC_SIZE,
  createInitialDocument,
  createPath,
} from "./factory";
import {
  type PathGeometry,
  commandsToGeometry,
  findSegmentNear,
  insertAnchor,
  pathCommandsToGeometry,
  pathGeometryBounds,
  pathGeometryToSvg,
  removeAnchor,
  scalePathGeometry,
  translatePathGeometry,
} from "./path-data";

const triangle: PathGeometry = {
  subpaths: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 80 },
      ],
    },
  ],
};

describe("pathGeometryToSvg", () => {
  it("emits lines for handle-less points and closes the subpath", () => {
    const d = pathGeometryToSvg(triangle);
    expect(d).toBe("M 0 0 L 100 0 L 50 80 L 0 0 Z");
  });

  it("emits cubic segments when handles exist", () => {
    const curve: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 30, y: -20 } },
            { x: 100, y: 0, handleIn: { x: 70, y: -20 } },
          ],
        },
      ],
    };

    expect(pathGeometryToSvg(curve)).toBe("M 0 0 C 30 -20 70 -20 100 0");
  });

  it("uses the anchor as control point when only one handle exists", () => {
    const half: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 25, y: 25 } },
            { x: 100, y: 0 },
          ],
        },
      ],
    };

    expect(pathGeometryToSvg(half)).toBe("M 0 0 C 25 25 100 0 100 0");
  });
});

describe("pathGeometryBounds", () => {
  it("covers anchors", () => {
    expect(pathGeometryBounds(triangle)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    });
  });

  it("includes handles in the hull", () => {
    const curve: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: -20, y: -30 } },
            { x: 100, y: 0 },
          ],
        },
      ],
    };

    expect(pathGeometryBounds(curve)).toEqual({
      x: -20,
      y: -30,
      width: 120,
      height: 30,
    });
  });

  it("returns null for empty geometry", () => {
    expect(pathGeometryBounds({ subpaths: [] })).toBeNull();
  });
});

describe("findSegmentNear", () => {
  it("finds the closest point on a straight segment", () => {
    const hit = findSegmentNear(triangle, { x: 50, y: 5 }, 10);

    expect(hit).not.toBeNull();
    expect(hit!.subpath).toBe(0);
    expect(hit!.index).toBe(0); // segment (0,0) → (100,0)
    expect(hit!.point.y).toBeCloseTo(0, 5);
    expect(hit!.point.x).toBeCloseTo(50, 1);
  });

  it("considers the closing segment of a closed subpath", () => {
    // Closing segment runs (50,80) → (0,0); midpoint ≈ (25,40).
    const hit = findSegmentNear(triangle, { x: 25, y: 40 }, 5);

    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(2);
  });

  it("returns null outside tolerance", () => {
    expect(findSegmentNear(triangle, { x: 50, y: 200 }, 10)).toBeNull();
  });
});

describe("insertAnchor", () => {
  it("inserts a corner point on a straight segment", () => {
    const result = insertAnchor(triangle, 0, 0, 0.5);

    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
    const point = result!.geometry.subpaths[0]!.points[1]!;
    expect(point).toEqual({ x: 50, y: 0 });
    expect(result!.geometry.subpaths[0]!.points).toHaveLength(4);
  });

  it("splits a cubic with de Casteljau preserving shape endpoints", () => {
    const curve: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 0, y: 100 } },
            { x: 100, y: 0, handleIn: { x: 100, y: 100 } },
          ],
        },
      ],
    };

    const result = insertAnchor(curve, 0, 0, 0.5);
    const points = result!.geometry.subpaths[0]!.points;

    expect(points).toHaveLength(3);
    const mid = points[1]!;
    // Symmetric curve: midpoint x = 50, y = 75 (cubic at t=0.5).
    expect(mid.x).toBeCloseTo(50, 5);
    expect(mid.y).toBeCloseTo(75, 5);
    expect(mid.handleIn).toBeDefined();
    expect(mid.handleOut).toBeDefined();
    // Original endpoints keep their positions.
    expect(points[0]!.x).toBe(0);
    expect(points[2]!.x).toBe(100);
  });

  it("splitting at t and rendering yields identical curve endpoints", () => {
    const curve: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 30, y: 60 } },
            { x: 100, y: 0, handleIn: { x: 70, y: 60 } },
          ],
        },
      ],
    };
    const before = findSegmentNear(curve, { x: 50, y: 45 }, 10)!;
    const result = insertAnchor(curve, 0, 0, before.t)!;
    const inserted = result.geometry.subpaths[0]!.points[1]!;

    expect(inserted.x).toBeCloseTo(before.point.x, 5);
    expect(inserted.y).toBeCloseTo(before.point.y, 5);
  });

  it("clamps out-of-range and non-finite segment parameters", () => {
    expect(
      insertAnchor(triangle, 0, 0, -10)!.geometry.subpaths[0]!.points[1],
    ).toMatchObject({ x: 0, y: 0 });
    expect(
      insertAnchor(triangle, 0, 0, 10)!.geometry.subpaths[0]!.points[1],
    ).toMatchObject({ x: 100, y: 0 });
    const fallback =
      insertAnchor(triangle, 0, 0, Number.NaN)!.geometry.subpaths[0]!.points[1]!;
    expect(fallback).toMatchObject({ x: 50, y: 0 });
  });
});

describe("removeAnchor", () => {
  it("removes a point and keeps the subpath", () => {
    const result = removeAnchor(triangle, 0, 1);

    expect(result).not.toBeNull();
    expect(result!.subpaths[0]!.points).toHaveLength(2);
  });

  it("drops the subpath when fewer than 2 points remain and returns null when empty", () => {
    const line: PathGeometry = {
      subpaths: [
        { closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      ],
    };

    expect(removeAnchor(line, 0, 0)).toBeNull();
  });
});

describe("commandsToGeometry", () => {
  it("builds subpaths from M/L/Z", () => {
    const geometry = commandsToGeometry([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 5, y: 8 },
      { type: "Z" },
    ]);

    expect(geometry.subpaths).toHaveLength(1);
    expect(geometry.subpaths[0]!.closed).toBe(true);
    expect(geometry.subpaths[0]!.points).toHaveLength(3);
  });

  it("maps cubics onto handles", () => {
    const geometry = commandsToGeometry([
      { type: "M", x: 0, y: 0 },
      { type: "C", x1: 10, y1: 20, x2: 30, y2: 20, x: 40, y: 0 },
    ]);

    const [a, b] = geometry.subpaths[0]!.points;
    expect(a!.handleOut).toEqual({ x: 10, y: 20 });
    expect(b!.handleIn).toEqual({ x: 30, y: 20 });
  });

  it("elevates quadratics to cubics exactly", () => {
    const geometry = commandsToGeometry([
      { type: "M", x: 0, y: 0 },
      { type: "Q", x1: 30, y1: 60, x: 60, y: 0 },
    ]);

    const [a, b] = geometry.subpaths[0]!.points;
    expect(a!.handleOut).toEqual({ x: 20, y: 40 });
    expect(b!.handleIn).toEqual({ x: 40, y: 40 });
  });

  it("deduplicates the repeated closing point of font contours", () => {
    const geometry = commandsToGeometry([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 5, y: 8 },
      { type: "L", x: 0, y: 0 },
      { type: "Z" },
    ]);

    expect(geometry.subpaths[0]!.points).toHaveLength(3);
    expect(geometry.subpaths[0]!.closed).toBe(true);
  });

  it("handles multiple contours (glyph counters)", () => {
    const geometry = commandsToGeometry([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 20, y: 0 },
      { type: "L", x: 10, y: 20 },
      { type: "Z" },
      { type: "M", x: 8, y: 4 },
      { type: "L", x: 12, y: 4 },
      { type: "L", x: 10, y: 8 },
      { type: "Z" },
    ]);

    expect(geometry.subpaths).toHaveLength(2);
  });
});

describe("pathCommandsToGeometry", () => {
  it("parses typed CanvasKit commands and preserves open and closed subpaths", () => {
    const geometry = pathCommandsToGeometry(
      new Float32Array([
        0, 0, 0, 1, 10, 0, 1, 10, 10, 5,
        0, 20, 20, 1, 30, 20,
      ]),
    );

    expect(geometry).toEqual({
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
        {
          closed: false,
          points: [
            { x: 20, y: 20 },
            { x: 30, y: 20 },
          ],
        },
      ],
    });
  });

  it("elevates quadratic commands to exact cubic handles", () => {
    const geometry = pathCommandsToGeometry([
      0, 0, 0,
      2, 30, 60, 60, 0,
    ]);
    const [start, end] = geometry!.subpaths[0]!.points;

    expect(start!.handleOut).toEqual({ x: 20, y: 40 });
    expect(end).toEqual({
      x: 60,
      y: 0,
      handleIn: { x: 40, y: 40 },
    });
  });

  it("approximates conics using their rational weight", () => {
    const geometry = pathCommandsToGeometry([
      0, 0, 0,
      3, 9, 9, 18, 0, 0.5,
    ]);
    const [start, end] = geometry!.subpaths[0]!.points;

    expect(start!.handleOut!.x).toBeCloseTo(4, 12);
    expect(start!.handleOut!.y).toBeCloseTo(4, 12);
    expect(end!.handleIn!.x).toBeCloseTo(14, 12);
    expect(end!.handleIn!.y).toBeCloseTo(4, 12);
  });

  it("treats a unit-weight conic as the exact quadratic elevation", () => {
    const geometry = pathCommandsToGeometry([
      0, 0, 0,
      3, 30, 60, 60, 0, 1,
    ]);
    const [start, end] = geometry!.subpaths[0]!.points;

    expect(start!.handleOut).toEqual({ x: 20, y: 40 });
    expect(end!.handleIn).toEqual({ x: 40, y: 40 });
  });

  it("maps cubic controls directly onto endpoint handles", () => {
    const geometry = pathCommandsToGeometry([
      0, 1, 2,
      4, 10, 20, 30, 40, 50, 60,
    ]);
    const [start, end] = geometry!.subpaths[0]!.points;

    expect(start!.handleOut).toEqual({ x: 10, y: 20 });
    expect(end).toEqual({
      x: 50,
      y: 60,
      handleIn: { x: 30, y: 40 },
    });
  });

  it("deduplicates an explicit endpoint at the closing origin", () => {
    const geometry = pathCommandsToGeometry([
      0, 0, 0,
      4, 2, 0, 8, 0, 10, 0,
      4, 8, 4, 2, 4, 0, 0,
      5,
    ]);
    const points = geometry!.subpaths[0]!.points;

    expect(points).toHaveLength(2);
    expect(points[0]!.handleIn).toEqual({ x: 2, y: 4 });
    expect(geometry!.subpaths[0]!.closed).toBe(true);
  });

  it.each([
    ["empty input", []],
    ["a move-only path", [0, 0, 0]],
    ["a truncated move", [0, 0]],
    ["a truncated segment", [0, 0, 0, 4, 1, 2, 3]],
    ["a segment before any move", [1, 10, 20]],
    ["a close before any move", [5]],
    ["an unknown verb", [0, 0, 0, 6]],
    ["a fractional verb", [0, 0, 0, 1.5, 1, 1]],
    ["a non-finite coordinate", [0, 0, Number.NaN, 1, 1, 1]],
    [
      "overflowing elevated handles",
      [0, -Number.MAX_VALUE, 0, 2, Number.MAX_VALUE, 0, 0, 0],
    ],
    ["a non-finite conic weight", [0, 0, 0, 3, 1, 1, 2, 2, Infinity]],
    ["a zero conic denominator", [0, 0, 0, 3, 1, 1, 2, 2, -1]],
    ["a negative conic denominator", [0, 0, 0, 3, 1, 1, 2, 2, -2]],
    [
      "an overflowing conic denominator",
      [0, 0, 0, 3, 1, 1, 2, 2, Number.MAX_VALUE],
    ],
  ])("rejects %s", (_label, commands) => {
    expect(pathCommandsToGeometry(commands)).toBeNull();
  });
});

describe("path factories", () => {
  it("creates the default mark from fresh editable geometry", () => {
    const first = createPath({ x: 0, y: 0 });
    const second = createPath({ x: 0, y: 0 });

    expect(first.geometry).toBeDefined();
    expect(first.geometry).not.toBe(second.geometry);
    expect(first.geometry!.subpaths).toHaveLength(2);
    expect(first.geometry!.subpaths.every((subpath) => subpath.closed)).toBe(
      true,
    );
    expect(first.d).toBe(pathGeometryToSvg(first.geometry!));
    expect(first.intrinsicWidth).toBe(PATH_INTRINSIC_SIZE);
    expect(first.intrinsicHeight).toBe(PATH_INTRINSIC_SIZE);
  });

  it("treats supplied geometry as canonical over stale path data", () => {
    const node = createPath({
      x: 0,
      y: 0,
      d: "M 999 999",
      geometry: triangle,
    });

    expect(node.geometry).toBe(triangle);
    expect(node.d).toBe(pathGeometryToSvg(triangle));
  });

  it("keeps custom path data without inventing unrelated geometry", () => {
    const node = createPath({ x: 0, y: 0, d: "M 0 0 L 10 10" });

    expect(node.d).toBe("M 0 0 L 10 10");
    expect(node.geometry).toBeUndefined();
  });

  it("seeds the Sample mark with its editable compound A outline", () => {
    const document = createInitialDocument();
    const mark = Object.values(document.nodes).find(
      (node) => node.name === "Sample mark",
    );

    expect(mark?.type).toBe("path");
    if (!mark || mark.type !== "path") {
      throw new Error("Sample mark path missing");
    }

    expect(mark.geometry).toEqual({
      subpaths: [
        {
          closed: true,
          points: [
            { x: 48, y: 6 },
            { x: 88, y: 78 },
            { x: 68, y: 78 },
            { x: 60, y: 62 },
            { x: 36, y: 62 },
            { x: 28, y: 78 },
            { x: 8, y: 78 },
          ],
        },
        {
          closed: true,
          points: [
            { x: 44, y: 46 },
            { x: 52, y: 46 },
            { x: 48, y: 36 },
          ],
        },
      ],
    });
    expect(mark.d).toBe(pathGeometryToSvg(mark.geometry!));
    expect(mark.width).toBe(96);
    expect(mark.height).toBe(96);
    expect(mark.intrinsicWidth).toBe(96);
    expect(mark.intrinsicHeight).toBe(96);
  });
});

describe("transforms", () => {
  it("translate moves anchors and handles together", () => {
    const curve: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [{ x: 10, y: 10, handleOut: { x: 20, y: 20 } }],
        },
      ],
    };
    const moved = translatePathGeometry(curve, 5, -5);
    const point = moved.subpaths[0]!.points[0]!;

    expect(point.x).toBe(15);
    expect(point.y).toBe(5);
    expect(point.handleOut).toEqual({ x: 25, y: 15 });
  });

  it("scale multiplies coordinates", () => {
    const scaled = scalePathGeometry(triangle, 2, 0.5);
    const points = scaled.subpaths[0]!.points;

    expect(points[1]).toEqual({ x: 200, y: 0 });
    expect(points[2]).toEqual({ x: 100, y: 40 });
  });
});
