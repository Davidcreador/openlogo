import { describe, expect, it } from "vitest";
import { pathGeometryBounds } from "./path-data";
import { documentSchema } from "./schema";
import {
  clampShapeParams,
  createBoxShapeNode,
  createVectorShapeNode,
  shapeGeometryInBox,
  shapeGeometryFromVector,
  shapeParamsPatch,
} from "./shapes";
import { createInitialDocument } from "./factory";

const BOX = { x: 40, y: 60, width: 200, height: 100 };

describe("shape geometry", () => {
  it("triangle has 3 anchors filling the box exactly", () => {
    const geometry = shapeGeometryInBox({ kind: "triangle" }, 200, 100)!;
    expect(geometry.subpaths).toHaveLength(1);
    expect(geometry.subpaths[0]!.closed).toBe(true);
    expect(geometry.subpaths[0]!.points).toHaveLength(3);
    expect(pathGeometryBounds(geometry)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("polygon defaults to a hexagon (6 anchors) and honours sides", () => {
    const hexagon = shapeGeometryInBox({ kind: "polygon" }, 100, 100)!;
    expect(hexagon.subpaths[0]!.points).toHaveLength(6);

    const octagon = shapeGeometryInBox({ kind: "polygon", sides: 8 }, 100, 100)!;
    expect(octagon.subpaths[0]!.points).toHaveLength(8);

    // Normalization: every polygon fills its box regardless of side count.
    for (const sides of [3, 5, 7, 12]) {
      const geometry = shapeGeometryInBox({ kind: "polygon", sides }, 80, 50)!;
      const bounds = pathGeometryBounds(geometry)!;
      expect(bounds.x).toBeCloseTo(0, 6);
      expect(bounds.y).toBeCloseTo(0, 6);
      expect(bounds.width).toBeCloseTo(80, 6);
      expect(bounds.height).toBeCloseTo(50, 6);
    }
  });

  it("star has 2×points anchors, alternating radii", () => {
    const star = shapeGeometryInBox(
      { kind: "star", sides: 5, innerRatio: 0.5 },
      100,
      100,
    )!;
    expect(star.subpaths[0]!.points).toHaveLength(10);

    const sevenPoint = shapeGeometryInBox({ kind: "star", sides: 7 }, 100, 100)!;
    expect(sevenPoint.subpaths[0]!.points).toHaveLength(14);
  });

  it("line is a 2-anchor open subpath from→to", () => {
    const geometry = shapeGeometryFromVector(
      { kind: "line" },
      { x: 10, y: 20 },
      { x: 110, y: 80 },
    )!;
    expect(geometry.subpaths[0]!.closed).toBe(false);
    expect(geometry.subpaths[0]!.points).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 80 },
    ]);
  });

  it("arrow is a closed 7-anchor polygon with its tip at `to`", () => {
    const geometry = shapeGeometryFromVector(
      { kind: "arrow" },
      { x: 0, y: 0 },
      { x: 120, y: 0 },
    )!;
    const points = geometry.subpaths[0]!.points;
    expect(geometry.subpaths[0]!.closed).toBe(true);
    expect(points).toHaveLength(7);
    expect(points.some((p) => p.x === 120 && p.y === 0)).toBe(true);
  });

  it("clamps params: sides 3–60 integral, innerRatio 0.05–0.95", () => {
    expect(clampShapeParams({ kind: "polygon", sides: 1 }).sides).toBe(3);
    expect(clampShapeParams({ kind: "polygon", sides: 999 }).sides).toBe(60);
    expect(clampShapeParams({ kind: "polygon", sides: 5.7 }).sides).toBe(6);
    expect(
      clampShapeParams({ kind: "star", innerRatio: 0 }).innerRatio,
    ).toBe(0.05);
    expect(clampShapeParams({ kind: "triangle", sides: 9 }).sides).toBeUndefined();
  });
});

describe("shape nodes", () => {
  it("box shape node sits at the box with matching intrinsic space", () => {
    const node = createBoxShapeNode({ kind: "polygon" }, BOX)!;
    expect(node.type).toBe("path");
    expect(node.shape).toEqual({ kind: "polygon", sides: 6 });
    expect(node).toMatchObject({
      x: BOX.x,
      y: BOX.y,
      width: BOX.width,
      height: BOX.height,
      intrinsicWidth: BOX.width,
      intrinsicHeight: BOX.height,
    });
    expect(node.geometry!.subpaths[0]!.points).toHaveLength(6);
  });

  it("horizontal line node clamps its degenerate height and gets a stroke", () => {
    const node = createVectorShapeNode(
      { kind: "line" },
      { x: 10, y: 50 },
      { x: 210, y: 50 },
    )!;
    expect(node.width).toBe(200);
    expect(node.height).toBeGreaterThan(0);
    expect(node.stroke).toMatchObject({ width: 3 });
    // Positive-size schema must accept the clamped node.
    const doc = createInitialDocument();
    doc.nodes[node.id] = node;
    doc.artboards[0]!.nodeIds.push(node.id);
    expect(() => documentSchema.parse(JSON.parse(JSON.stringify(doc)))).not.toThrow();
  });

  it("zero-length arrow yields no node", () => {
    const point = { x: 5, y: 5 };
    expect(createVectorShapeNode({ kind: "arrow" }, point, point)).toBeNull();
  });

  it("shapeParamsPatch regenerates geometry in place, keeping size", () => {
    const node = createBoxShapeNode({ kind: "polygon" }, BOX)!;
    const patch = shapeParamsPatch(node, { kind: "polygon", sides: 8 })!;
    expect(patch.shape).toEqual({ kind: "polygon", sides: 8 });
    expect(patch.geometry!.subpaths[0]!.points).toHaveLength(8);
    expect(patch.intrinsicWidth).toBe(node.width);
    const bounds = pathGeometryBounds(patch.geometry!)!;
    expect(bounds.width).toBeCloseTo(node.width, 6);
    expect(bounds.height).toBeCloseTo(node.height, 6);
  });

  it("shapeParamsPatch refuses vector kinds", () => {
    const node = createVectorShapeNode(
      { kind: "line" },
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    )!;
    expect(shapeParamsPatch(node, { kind: "line" })).toBeNull();
  });
});
