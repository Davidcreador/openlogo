import { describe, expect, it } from "vitest";
import {
  type PathGeometry,
  pathGeometryBounds,
  pathGeometryToSvg,
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
