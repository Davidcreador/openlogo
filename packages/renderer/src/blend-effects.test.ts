import { createRectangle } from "@openlogo/core";
import type { Canvas, CanvasKit } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import { SceneRenderer } from "./renderer";

type RecordedPaint = {
  blendMode?: unknown;
  imageFilter?: unknown;
};

function rendererHarness() {
  const paints: RecordedPaint[] = [];
  const layerPaints: Array<RecordedPaint | undefined> = [];
  const shapePaints: RecordedPaint[] = [];
  const blendModes = {
    Multiply: { name: "multiply" },
    Screen: { name: "screen" },
    Overlay: { name: "overlay" },
    Darken: { name: "darken" },
    Lighten: { name: "lighten" },
    SrcIn: { name: "src-in" },
  };

  class FakePaint implements RecordedPaint {
    blendMode?: unknown;
    imageFilter?: unknown;

    constructor() {
      paints.push(this);
    }

    setAntiAlias() {}
    setColor() {}
    setStyle() {}
    setStrokeWidth() {}
    delete() {}

    setBlendMode(mode: unknown) {
      this.blendMode = mode;
    }

    setImageFilter(filter: unknown) {
      this.imageFilter = filter;
    }
  }

  const canvasKit = {
    Paint: FakePaint,
    PaintStyle: { Stroke: { name: "stroke" } },
    BlendMode: blendModes,
    parseColorString: vi.fn(() => [0, 0, 0, 1]),
    RRectXY: vi.fn((rect: unknown) => rect),
    XYWHRect: vi.fn((x: number, y: number, width: number, height: number) => [
      x,
      y,
      width,
      height,
    ]),
    ImageFilter: {
      MakeDropShadowOnly: vi.fn(() => ({ delete: vi.fn() })),
    },
  } as unknown as CanvasKit;

  const canvas = {
    save: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    drawRRect: vi.fn((_rect: unknown, paint: RecordedPaint) => {
      shapePaints.push(paint);
    }),
    saveLayer: vi.fn((paint?: RecordedPaint) => {
      layerPaints.push(paint);
    }),
  } as unknown as Canvas;

  const renderer = Object.assign(Object.create(SceneRenderer.prototype), {
    canvasKit,
  }) as SceneRenderer;
  const drawNode = (
    renderer as unknown as {
      drawNode(target: Canvas, node: ReturnType<typeof createRectangle>): void;
    }
  ).drawNode.bind(renderer);

  return {
    blendModes,
    canvas,
    drawNode,
    layerPaints,
    paints,
    shapePaints,
  };
}

describe("leaf blend modes and effects", () => {
  it.each([
    ["multiply", "Multiply"],
    ["screen", "Screen"],
    ["overlay", "Overlay"],
    ["darken", "Darken"],
    ["lighten", "Lighten"],
  ] as const)("composites a %s leaf as one layer", (mode, canvasKitMode) => {
    const { blendModes, canvas, drawNode, layerPaints, shapePaints } =
      rendererHarness();
    const node = createRectangle({ x: 10, y: 20 });
    node.blendMode = mode;

    drawNode(canvas, node);

    expect(layerPaints).toHaveLength(1);
    expect(layerPaints[0]?.blendMode).toBe(blendModes[canvasKitMode]);
    expect(shapePaints).toHaveLength(1);
    expect(shapePaints[0]?.blendMode).toBeUndefined();
  });

  it("keeps multiple effects and the stroke inside the blend layer", () => {
    const { blendModes, canvas, drawNode, layerPaints, shapePaints } =
      rendererHarness();
    const node = createRectangle({ x: 10, y: 20 });
    node.blendMode = "overlay";
    node.stroke = { color: "#ffffff", width: 2, align: "center" };
    node.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 3,
        dy: 4,
        blur: 8,
        color: "#000000",
        opacity: 0.4,
      },
      {
        type: "glow",
        enabled: true,
        blur: 12,
        color: "#f59e0b",
        opacity: 0.8,
      },
    ];

    drawNode(canvas, node);

    expect(layerPaints.map((paint) => paint?.blendMode)).toEqual([
      blendModes.Overlay,
      undefined,
      undefined,
    ]);
    expect(layerPaints.slice(1).every((paint) => paint?.imageFilter)).toBe(true);
    expect(shapePaints).toHaveLength(6);
    expect(shapePaints.every((paint) => paint.blendMode === undefined)).toBe(true);
  });
});
