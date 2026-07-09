import { describe, expect, it } from "vitest";
import {
  type PathGeometry,
  averageAnchors,
  cutPathAt,
  isOpenEndpoint,
  joinAnchors,
  setAnchorCorner,
  setAnchorSmooth,
} from "./path-data";

/** Closed unit square, corner anchors, no handles. */
function square(): PathGeometry {
  return {
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
    ],
  };
}

/** Open three-point polyline. */
function polyline(): PathGeometry {
  return {
    subpaths: [
      {
        closed: false,
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 40 },
          { x: 100, y: 0 },
        ],
      },
    ],
  };
}

describe("setAnchorSmooth / setAnchorCorner", () => {
  it("pulls collinear handles out along the neighbour chord", () => {
    const smooth = setAnchorSmooth(square(), 0, 1)!;
    const point = smooth.subpaths[0]!.points[1]!;
    expect(point.handleIn).toBeDefined();
    expect(point.handleOut).toBeDefined();

    // Collinear: handleIn, anchor and handleOut on one line.
    const inDx = point.x - point.handleIn!.x;
    const inDy = point.y - point.handleIn!.y;
    const outDx = point.handleOut!.x - point.x;
    const outDy = point.handleOut!.y - point.y;
    expect(inDx * outDy - inDy * outDx).toBeCloseTo(0, 6);

    // Chord direction: from previous (0,0) to next (100,100).
    expect(outDx).toBeGreaterThan(0);
    expect(outDy).toBeGreaterThan(0);
  });

  it("gives an open-path endpoint a single handle", () => {
    const smooth = setAnchorSmooth(polyline(), 0, 0)!;
    const point = smooth.subpaths[0]!.points[0]!;
    expect(point.handleIn).toBeUndefined();
    expect(point.handleOut).toBeDefined();
  });

  it("corner retracts both handles and round-trips with smooth", () => {
    const smooth = setAnchorSmooth(square(), 0, 2)!;
    const corner = setAnchorCorner(smooth, 0, 2)!;
    const point = corner.subpaths[0]!.points[2]!;
    expect(point.handleIn).toBeUndefined();
    expect(point.handleOut).toBeUndefined();
    expect(point).toEqual({ x: 100, y: 100 });
    // Untouched anchors survive both conversions.
    expect(corner.subpaths[0]!.points[0]).toEqual({ x: 0, y: 0 });
  });

  it("returns null for a missing anchor", () => {
    expect(setAnchorSmooth(square(), 0, 9)).toBeNull();
    expect(setAnchorCorner(square(), 2, 0)).toBeNull();
  });
});

describe("cutPathAt", () => {
  it("opens a closed subpath at the anchor, duplicating it at both ends", () => {
    const result = cutPathAt(square(), 0, 1);
    expect(result?.kind).toBe("opened");
    if (result?.kind !== "opened") {
      return;
    }
    const cut = result.geometry.subpaths[0]!;
    expect(cut.closed).toBe(false);
    expect(cut.points).toHaveLength(5);
    expect(cut.points[0]).toMatchObject({ x: 100, y: 0 });
    expect(cut.points[4]).toMatchObject({ x: 100, y: 0 });
    // Walk order preserved: 1 → 2 → 3 → 0 → back to 1.
    expect(cut.points[1]).toMatchObject({ x: 100, y: 100 });
    expect(cut.points[3]).toMatchObject({ x: 0, y: 0 });
  });

  it("splits handle ownership across the cut", () => {
    const geometry: PathGeometry = {
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            {
              x: 100,
              y: 0,
              handleIn: { x: 80, y: -10 },
              handleOut: { x: 120, y: 10 },
            },
            { x: 100, y: 100 },
          ],
        },
      ],
    };
    const result = cutPathAt(geometry, 0, 1);
    if (result?.kind !== "opened") {
      throw new Error("expected opened");
    }
    const points = result.geometry.subpaths[0]!.points;
    expect(points[0]!.handleOut).toEqual({ x: 120, y: 10 });
    expect(points[0]!.handleIn).toBeUndefined();
    const last = points[points.length - 1]!;
    expect(last.handleIn).toEqual({ x: 80, y: -10 });
    expect(last.handleOut).toBeUndefined();
  });

  it("severs an open subpath at an interior anchor into two pieces", () => {
    const result = cutPathAt(polyline(), 0, 1);
    expect(result?.kind).toBe("split");
    if (result?.kind !== "split") {
      return;
    }
    expect(result.first.subpaths[0]!.points.map((p) => p.x)).toEqual([0, 50]);
    expect(result.second.subpaths[0]!.points.map((p) => p.x)).toEqual([50, 100]);
    expect(result.first.subpaths[0]!.closed).toBe(false);
    expect(result.second.subpaths[0]!.closed).toBe(false);
  });

  it("keeps sibling subpaths with the first piece on a split", () => {
    const geometry: PathGeometry = {
      subpaths: [...square().subpaths, ...polyline().subpaths],
    };
    const result = cutPathAt(geometry, 1, 1);
    if (result?.kind !== "split") {
      throw new Error("expected split");
    }
    expect(result.first.subpaths).toHaveLength(2);
    expect(result.first.subpaths[0]!.closed).toBe(true); // the square
    expect(result.second.subpaths).toHaveLength(1);
  });

  it("refuses to cut an open subpath at its endpoints", () => {
    expect(cutPathAt(polyline(), 0, 0)).toBeNull();
    expect(cutPathAt(polyline(), 0, 2)).toBeNull();
  });
});

describe("joinAnchors", () => {
  it("closes an open subpath joining its two ends with a segment", () => {
    const joined = joinAnchors(polyline(), { subpath: 0, index: 0 }, {
      subpath: 0,
      index: 2,
    })!;
    expect(joined.subpaths[0]!.closed).toBe(true);
    expect(joined.subpaths[0]!.points).toHaveLength(3);
  });

  it("welds coincident ends: cut-then-join restores the anchor count", () => {
    const cut = cutPathAt(square(), 0, 1);
    if (cut?.kind !== "opened") {
      throw new Error("expected opened");
    }
    const open = cut.geometry;
    const last = open.subpaths[0]!.points.length - 1;
    const joined = joinAnchors(open, { subpath: 0, index: 0 }, {
      subpath: 0,
      index: last,
    })!;
    expect(joined.subpaths[0]!.closed).toBe(true);
    expect(joined.subpaths[0]!.points).toHaveLength(4);
    // Same corner set as the original square.
    const xs = joined.subpaths[0]!.points.map((p) => `${p.x},${p.y}`).sort();
    expect(xs).toEqual(["0,0", "0,100", "100,0", "100,100"]);
  });

  it("merges two subpaths end-to-start, reorienting as needed", () => {
    const geometry: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
          ],
        },
        {
          closed: false,
          points: [
            { x: 200, y: 0 },
            { x: 120, y: 0 },
          ],
        },
      ],
    };
    // Join A's end (50,0) to B's END (120,0) — B must reverse.
    const joined = joinAnchors(geometry, { subpath: 0, index: 1 }, {
      subpath: 1,
      index: 1,
    })!;
    expect(joined.subpaths).toHaveLength(1);
    expect(joined.subpaths[0]!.points.map((p) => p.x)).toEqual([
      0, 50, 120, 200,
    ]);
    expect(joined.subpaths[0]!.closed).toBe(false);
  });

  it("welds coincident cross-subpath anchors into one", () => {
    const geometry: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0, handleIn: { x: 30, y: -5 } },
          ],
        },
        {
          closed: false,
          points: [
            { x: 50, y: 0, handleOut: { x: 70, y: 5 } },
            { x: 100, y: 0 },
          ],
        },
      ],
    };
    const joined = joinAnchors(geometry, { subpath: 0, index: 1 }, {
      subpath: 1,
      index: 0,
    })!;
    expect(joined.subpaths).toHaveLength(1);
    const points = joined.subpaths[0]!.points;
    expect(points).toHaveLength(3);
    // The welded anchor carries the incoming AND outgoing handles.
    expect(points[1]!.handleIn).toEqual({ x: 30, y: -5 });
    expect(points[1]!.handleOut).toEqual({ x: 70, y: 5 });
  });

  it("rejects non-endpoint or closed-subpath anchors", () => {
    expect(
      joinAnchors(polyline(), { subpath: 0, index: 1 }, { subpath: 0, index: 2 }),
    ).toBeNull();
    expect(
      joinAnchors(square(), { subpath: 0, index: 0 }, { subpath: 0, index: 3 }),
    ).toBeNull();
  });

  it("isOpenEndpoint answers exactly the joinable anchors", () => {
    expect(isOpenEndpoint(polyline(), { subpath: 0, index: 0 })).toBe(true);
    expect(isOpenEndpoint(polyline(), { subpath: 0, index: 2 })).toBe(true);
    expect(isOpenEndpoint(polyline(), { subpath: 0, index: 1 })).toBe(false);
    expect(isOpenEndpoint(square(), { subpath: 0, index: 0 })).toBe(false);
  });
});

describe("averageAnchors", () => {
  const refs = [
    { subpath: 0, index: 0 },
    { subpath: 0, index: 2 },
  ];

  it("moves anchors to their mean point (both axes)", () => {
    const averaged = averageAnchors(polyline(), refs, "both")!;
    expect(averaged.subpaths[0]!.points[0]).toMatchObject({ x: 50, y: 0 });
    expect(averaged.subpaths[0]!.points[2]).toMatchObject({ x: 50, y: 0 });
    // Non-referenced anchors stay put.
    expect(averaged.subpaths[0]!.points[1]).toMatchObject({ x: 50, y: 40 });
  });

  it("horizontal aligns to a common y, vertical to a common x", () => {
    const geometry: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 10 },
            { x: 100, y: 30 },
          ],
        },
      ],
    };
    const allRefs = [
      { subpath: 0, index: 0 },
      { subpath: 0, index: 1 },
    ];
    const horizontal = averageAnchors(geometry, allRefs, "horizontal")!;
    expect(horizontal.subpaths[0]!.points[0]).toMatchObject({ x: 0, y: 20 });
    expect(horizontal.subpaths[0]!.points[1]).toMatchObject({ x: 100, y: 20 });

    const vertical = averageAnchors(geometry, allRefs, "vertical")!;
    expect(vertical.subpaths[0]!.points[0]).toMatchObject({ x: 50, y: 10 });
    expect(vertical.subpaths[0]!.points[1]).toMatchObject({ x: 50, y: 30 });
  });

  it("carries handles along with the moved anchor", () => {
    const geometry: PathGeometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 10, y: 10 } },
            { x: 100, y: 0, handleIn: { x: 90, y: 10 } },
          ],
        },
      ],
    };
    const averaged = averageAnchors(
      geometry,
      [
        { subpath: 0, index: 0 },
        { subpath: 0, index: 1 },
      ],
      "both",
    )!;
    expect(averaged.subpaths[0]!.points[0]!.handleOut).toEqual({
      x: 60,
      y: 10,
    });
    expect(averaged.subpaths[0]!.points[1]!.handleIn).toEqual({ x: 40, y: 10 });
  });

  it("returns null with fewer than two valid anchors", () => {
    expect(averageAnchors(polyline(), [refs[0]!], "both")).toBeNull();
    expect(
      averageAnchors(polyline(), [{ subpath: 3, index: 0 }, refs[0]!], "both"),
    ).toBeNull();
  });
});
