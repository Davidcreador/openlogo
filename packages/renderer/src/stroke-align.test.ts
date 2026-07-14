import {
  createEllipse,
  createPath,
  createRectangle,
  createVectorShapeNode,
} from "@openlogo/core";
import type { Canvas, CanvasKit } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import { SceneRenderer } from "./renderer";

type RecordedPaint = { strokeWidth?: number };

function harness() {
  const strokeWidths: number[] = [];
  class FakePaint implements RecordedPaint {
    strokeWidth?: number;
    setAntiAlias() {}
    setColor() {}
    setStyle() {}
    setStrokeWidth(width: number) {
      this.strokeWidth = width;
      strokeWidths.push(width);
    }
    delete() {}
  }
  class FakePath {
    private hitWidth = 0;
    static MakeFromSVGString() {
      return new FakePath();
    }
    addOval() {}
    copy() {
      return new FakePath();
    }
    stroke(options: { width: number }) {
      this.hitWidth = options.width;
      return true;
    }
    contains(x: number, y: number) {
      return this.hitWidth > 0 && x >= 0 && x <= 100 && Math.abs(y) <= this.hitWidth / 2;
    }
    setFillType() {}
    delete() {}
  }
  const clipOps = { Intersect: { name: "intersect" }, Difference: { name: "difference" } };
  const canvasKit = {
    Paint: FakePaint,
    PaintStyle: { Stroke: { name: "stroke" } },
    StrokeCap: { Round: { name: "round" } },
    StrokeJoin: { Round: { name: "round" } },
    ClipOp: clipOps,
    Path: FakePath,
    FillType: { Winding: { name: "winding" }, EvenOdd: { name: "even-odd" } },
    parseColorString: vi.fn(() => [0, 0, 0, 1]),
    XYWHRect: vi.fn((x: number, y: number, width: number, height: number) => [x, y, width, height]),
    RRectXY: vi.fn((rect: unknown) => rect),
  } as unknown as CanvasKit;
  const canvas = {
    save: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    drawRRect: vi.fn(),
    drawOval: vi.fn(),
    drawPath: vi.fn(),
    clipRRect: vi.fn(),
    clipPath: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
  } as unknown as Canvas;
  const renderer = Object.assign(Object.create(SceneRenderer.prototype), {
    canvasKit,
    pathCache: new Map(),
    textInteractionBounds: new Map(),
  }) as SceneRenderer;
  const drawNode = (
    renderer as unknown as {
      drawNode(
        target: Canvas,
        node:
          | ReturnType<typeof createRectangle>
          | ReturnType<typeof createEllipse>
          | ReturnType<typeof createPath>,
      ): void;
    }
  ).drawNode.bind(renderer);
  const nodeContains = (
    renderer as unknown as {
      nodeContains(
        node:
          | ReturnType<typeof createRectangle>
          | ReturnType<typeof createPath>,
        point: { x: number; y: number },
      ): boolean;
    }
  ).nodeContains.bind(renderer);
  return { canvas, clipOps, drawNode, nodeContains, strokeWidths };
}

describe("shape stroke alignment", () => {
  it("leaves center rendering pixel-identical", () => {
    const { canvas, drawNode, strokeWidths } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.stroke = { color: "#ff2d55", width: 12, align: "center" };

    drawNode(canvas, node);

    expect(strokeWidths).toEqual([12]);
    expect(canvas.clipRRect).not.toHaveBeenCalled();
  });

  it.each([
    ["inside", "intersect"],
    ["outside", "difference"],
  ] as const)("draws a doubled %s stroke through the geometry clip", (align, op) => {
    const { canvas, clipOps, drawNode, strokeWidths } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.stroke = { color: "#ff2d55", width: 12, align };

    drawNode(canvas, node);

    expect(strokeWidths).toEqual([24]);
    expect(canvas.clipRRect).toHaveBeenCalledWith(
      expect.anything(),
      op === "intersect" ? clipOps.Intersect : clipOps.Difference,
      true,
    );
  });

  it("clips an outside ellipse stroke against an oval path", () => {
    const { canvas, clipOps, drawNode, strokeWidths } = harness();
    const node = createEllipse({ x: 10, y: 20 });
    node.stroke = { color: "#ff2d55", width: 12, align: "outside" };

    drawNode(canvas, node);

    expect(strokeWidths).toEqual([24]);
    expect(canvas.clipPath).toHaveBeenCalledWith(
      expect.anything(),
      clipOps.Difference,
      true,
    );
  });

  it("clips an inside path stroke after its translate and scale", () => {
    const { canvas, clipOps, drawNode, strokeWidths } = harness();
    const node = createPath({ x: 10, y: 20 });
    node.width = 192;
    node.height = 48;
    node.stroke = { color: "#ff2d55", width: 12, align: "inside" };

    drawNode(canvas, node);

    expect(strokeWidths).toEqual([24]);
    expect(canvas.translate).toHaveBeenCalledWith(10, 20);
    expect(canvas.scale).toHaveBeenCalledWith(2, 0.5);
    expect(canvas.clipPath).toHaveBeenCalledWith(
      expect.anything(),
      clipOps.Intersect,
      true,
    );
  });

  it("hits an outside stroke beyond the original box", () => {
    const { nodeContains } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.width = 100;
    node.height = 50;
    node.stroke = { color: "#ff2d55", width: 12, align: "outside" };

    expect(nodeContains(node, { x: 0, y: 40 })).toBe(true);
  });

  it("does not expand an inside stroke hit region", () => {
    const { nodeContains } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.width = 100;
    node.height = 50;
    node.stroke = { color: "#ff2d55", width: 12, align: "inside" };

    expect(nodeContains(node, { x: 0, y: 40 })).toBe(false);
  });

  it("hits a default-stroke horizontal line outside its near-zero box", () => {
    const { nodeContains } = harness();
    const node = createVectorShapeNode(
      { kind: "line" },
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    )!;

    expect(node.height).toBe(0.01);
    expect(node.stroke?.width).toBe(3);
    expect(nodeContains(node, { x: 60, y: 22.5 })).toBe(true);
  });
});

describe("rounded rectangle hit-testing", () => {
  it("rejects transparent corners outside the rounded fill", () => {
    const { nodeContains } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.width = 100;
    node.height = 60;
    node.cornerRadius = 20;

    expect(nodeContains(node, { x: 11, y: 21 })).toBe(false);
    expect(nodeContains(node, { x: 60, y: 21 })).toBe(true);
  });

  it("uses the rounded outer outline for outside-stroke hits", () => {
    const { nodeContains } = harness();
    const node = createRectangle({ x: 10, y: 20 });
    node.width = 100;
    node.height = 60;
    node.cornerRadius = 20;
    node.stroke = { color: "#ff2d55", width: 10, align: "outside" };

    expect(nodeContains(node, { x: 5, y: 50 })).toBe(true);
    expect(nodeContains(node, { x: 5, y: 15 })).toBe(false);
  });
});
