import { createText } from "@openlogo/core";
import type { Canvas, CanvasKit } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import { SceneRenderer } from "./renderer";

type RecordedPaint = {
  style?: unknown;
  strokeWidth?: number;
  color?: unknown;
  blendMode?: unknown;
};

function rendererHarness() {
  const paints: RecordedPaint[] = [];
  const paintRuns: Array<{ fg: RecordedPaint; bg: RecordedPaint }> = [];
  const drawnParagraphs: unknown[] = [];
  const layerPaints: Array<RecordedPaint | undefined> = [];
  const onTextMetrics = vi.fn();

  class FakePaint implements RecordedPaint {
    style?: unknown;
    strokeWidth?: number;
    color?: unknown;
    blendMode?: unknown;

    constructor() {
      paints.push(this);
    }

    setAntiAlias() {}
    setStyle(style: unknown) {
      this.style = style;
    }
    setStrokeWidth(width: number) {
      this.strokeWidth = width;
    }
    setColor(color: unknown) {
      this.color = color;
    }
    setBlendMode(mode: unknown) {
      this.blendMode = mode;
    }
    delete() {}
  }

  class FakeParagraph {
    layout() {}
    getLongestLine() {
      return 100;
    }
    getHeight() {
      return 20;
    }
    delete() {}
  }

  class FakeBuilder {
    addText() {}
    pushStyle() {}
    pop() {}
    pushPaintStyle(_style: unknown, fg: RecordedPaint, bg: RecordedPaint) {
      paintRuns.push({ fg, bg });
    }
    build() {
      return new FakeParagraph();
    }
    delete() {}
  }

  const canvasKit = {
    Paint: FakePaint,
    PaintStyle: { Stroke: { name: "stroke" } },
    BlendMode: {
      DstIn: { name: "dst-in" },
      DstOut: { name: "dst-out" },
    },
    TRANSPARENT: [0, 0, 0, 0],
    TextAlign: { Left: 0, Center: 1, Right: 2 },
    FontSlant: { Italic: { name: "italic" } },
    ParagraphStyle: class {
      constructor(fields: object) {
        Object.assign(this, fields);
      }
    },
    TextStyle: class {
      constructor(fields: object) {
        Object.assign(this, fields);
      }
    },
    ParagraphBuilder: {
      MakeFromFontProvider: vi.fn(() => new FakeBuilder()),
    },
    parseColorString: vi.fn(() => [0, 0, 0, 1]),
  } as unknown as CanvasKit;

  const canvas = {
    save: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    drawParagraph: vi.fn((paragraph: unknown) => {
      drawnParagraphs.push(paragraph);
    }),
    saveLayer: vi.fn((paint?: RecordedPaint) => {
      layerPaints.push(paint);
    }),
  } as unknown as Canvas;

  const renderer = Object.assign(Object.create(SceneRenderer.prototype), {
    canvasKit,
    fonts: {
      isEmpty: false,
      provider: {},
      resolveProviderFamily: () => "Inter",
    },
    paragraphCache: new Map(),
    strokeParagraphCache: new Map(),
    maskParagraphCache: new Map(),
    textPathLayouts: new Map(),
    textPathBounds: new Map(),
    textInteractionBounds: new Map(),
    onTextMetrics,
  }) as SceneRenderer;
  const drawNode = (
    renderer as unknown as {
      drawNode(target: Canvas, node: ReturnType<typeof createText>): void;
    }
  ).drawNode.bind(renderer);
  const nodeContains = (
    renderer as unknown as {
      nodeContains(
        node: ReturnType<typeof createText>,
        point: { x: number; y: number },
      ): boolean;
    }
  ).nodeContains.bind(renderer);

  return {
    canvas,
    drawNode,
    nodeContains,
    onTextMetrics,
    paintRuns,
    drawnParagraphs,
    layerPaints,
  };
}

describe("text stroke rendering", () => {
  it("draws only the fill paragraph when the node has no stroke", () => {
    const { canvas, drawNode, drawnParagraphs, paintRuns } = rendererHarness();
    const node = createText({ x: 0, y: 0, content: "Brand" });

    drawNode(canvas, node);

    expect(drawnParagraphs).toHaveLength(1);
    expect(paintRuns).toHaveLength(0);
  });

  it("draws a stroked paragraph pass over the fill", () => {
    const { canvas, drawNode, drawnParagraphs, paintRuns } = rendererHarness();
    const node = createText({ x: 0, y: 0, content: "Brand" });
    node.stroke = { color: "#112233", width: 3, align: "center" };

    drawNode(canvas, node);

    expect(drawnParagraphs).toHaveLength(2);
    expect(paintRuns).toHaveLength(1);
    expect(paintRuns[0]?.fg.style).toEqual({ name: "stroke" });
    expect(paintRuns[0]?.fg.strokeWidth).toBe(3);
  });

  it("skips the stroke pass for zero-width strokes", () => {
    const { canvas, drawNode, drawnParagraphs } = rendererHarness();
    const node = createText({ x: 0, y: 0, content: "Brand" });
    node.stroke = { color: "#112233", width: 0, align: "center" };

    drawNode(canvas, node);

    expect(drawnParagraphs).toHaveLength(1);
  });

  it.each([
    ["inside", "dst-in"],
    ["outside", "dst-out"],
  ] as const)("masks a doubled %s stroke with glyph alpha", (align, blend) => {
    const { canvas, drawNode, drawnParagraphs, layerPaints, paintRuns } =
      rendererHarness();
    const node = createText({ x: 0, y: 0, content: "Brand" });
    node.stroke = { color: "#112233", width: 3, align };

    drawNode(canvas, node);

    expect(paintRuns[0]?.fg.strokeWidth).toBe(6);
    expect(drawnParagraphs).toHaveLength(3);
    expect(layerPaints.some((paint) => paint?.blendMode)).toBe(true);
    expect(layerPaints.find((paint) => paint?.blendMode)?.blendMode).toEqual({
      name: blend,
    });
  });

  it("hits rendered paragraph overflow outside the stored text box", () => {
    const { canvas, drawNode, nodeContains, onTextMetrics } = rendererHarness();
    const node = createText({ x: 10, y: 20, content: "Overflow" });
    node.width = 40;
    node.height = 8;

    drawNode(canvas, node);

    expect(nodeContains(node, { x: 90, y: 30 })).toBe(true);
    expect(nodeContains(node, { x: 90, y: 45 })).toBe(false);
    expect(onTextMetrics).toHaveBeenCalledWith(node.id, {
      width: 100,
      height: 20,
    });
  });
});
