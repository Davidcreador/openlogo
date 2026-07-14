import { createInitialDocument, createPath, createText } from "@openlogo/core";
import type { Canvas, CanvasKit } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import { SceneRenderer } from "./renderer";

function rendererHarness(glyphs = [11, 12], positions = [0, 0, 20, 0, 40, 0]) {
  const shapedTexts: string[] = [];
  const textStyles: Array<Record<string, unknown>> = [];
  const blobGlyphs: number[][] = [];
  const paints: FakePaint[] = [];
  const paintBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];

  class FakePath {
    static MakeFromSVGString() {
      return new FakePath();
    }
    copy() {
      return new FakePath();
    }
    transform() {}
    setFillType() {}
    delete() {}
  }
  class FakeMeasure {
    length() {
      return 200;
    }
    getPosTan(distance: number) {
      return [distance, 100, 1, 0];
    }
    delete() {}
  }
  class FakeContourMeasureIter {
    private done = false;
    next() {
      if (this.done) {
        return null;
      }
      this.done = true;
      return new FakeMeasure();
    }
    delete() {}
  }
  class FakeFont {
    delete() {}
  }
  class FakePaint {
    strokeWidth?: number;
    blendMode?: unknown;
    constructor() {
      paints.push(this);
    }
    setAntiAlias() {}
    setStyle() {}
    setStrokeWidth(width: number) {
      this.strokeWidth = width;
    }
    setColor() {}
    setBlendMode(mode: unknown) {
      this.blendMode = mode;
    }
    delete() {}
  }
  class FakeParagraph {
    layout() {}
    getShapedLines() {
      return [
        {
          top: 0,
          bottom: 20,
          baseline: 15,
          runs: [
            {
              glyphs: Uint16Array.from(glyphs),
              positions: Float32Array.from(positions),
              offsets: Uint32Array.from(glyphs.map((_, index) => index)),
            },
          ],
        },
      ];
    }
    delete() {}
  }
  class FakeBuilder {
    addText(text: string) {
      shapedTexts.push(text);
    }
    pushStyle() {}
    pop() {}
    build() {
      return new FakeParagraph();
    }
    delete() {}
  }

  const canvasKit = {
    Path: FakePath,
    FillType: { Winding: {}, EvenOdd: {} },
    ContourMeasureIter: FakeContourMeasureIter,
    Font: FakeFont,
    Paint: FakePaint,
    PaintStyle: { Stroke: {} },
    BlendMode: { DstIn: { name: "dst-in" }, DstOut: { name: "dst-out" } },
    ParagraphStyle: class {
      constructor(fields: object) {
        Object.assign(this, fields);
      }
    },
    TextStyle: class {
      constructor(fields: Record<string, unknown>) {
        textStyles.push(fields);
        Object.assign(this, fields);
      }
    },
    ParagraphBuilder: {
      MakeFromFontProvider: vi.fn(() => new FakeBuilder()),
    },
    TextBlob: {
      MakeFromRSXformGlyphs: vi.fn((placed: number[]) => {
        blobGlyphs.push([...placed]);
        return { delete() {} };
      }),
    },
    TextAlign: { Left: 0 },
    FontSlant: { Italic: {} },
    parseColorString: vi.fn(() => [0, 0, 0, 1]),
  } as unknown as CanvasKit;
  const canvas = {
    drawTextBlob: vi.fn(),
    saveLayer: vi.fn(),
    restore: vi.fn(),
  } as unknown as Canvas;
  const path = createPath({ x: 300, y: 220 });
  path.width = 240;
  path.height = 240;
  path.rotation = 35;
  const text = createText({ x: 10, y: 20, content: "AB" });
  text.fontSize = 20;
  text.onPath = { pathId: path.id, startOffset: 10, flip: false };
  const document = createInitialDocument();
  document.nodes = { [path.id]: path, [text.id]: text };
  document.artboards[0] = {
    ...document.artboards[0]!,
    nodeIds: [path.id, text.id],
  };
  const renderer = Object.assign(Object.create(SceneRenderer.prototype), {
    canvasKit,
    fonts: {
      provider: {},
      getTypeface: () => ({}),
      resolveProviderFamily: () => "Inter",
    },
    scene: {
      document,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedNodeIds: [],
    },
    pathCache: new Map(),
    textPathLayouts: new Map(),
    textPathBounds: new Map(),
    textInteractionBounds: new Map(),
    makePaint: (_paint: unknown, box: { x: number; y: number; width: number; height: number }) => {
      paintBoxes.push(box);
      return new FakePaint();
    },
  }) as SceneRenderer;
  const drawTextOnPath = (
    renderer as unknown as {
      drawTextOnPath(target: Canvas, node: typeof text): boolean;
    }
  ).drawTextOnPath.bind(renderer);
  const nodeContains = (
    renderer as unknown as {
      nodeContains(node: typeof text, point: { x: number; y: number }): boolean;
    }
  ).nodeContains.bind(renderer);

  return {
    blobGlyphs,
    canvas,
    document,
    drawTextOnPath,
    nodeContains,
    paintBoxes,
    paints,
    renderer,
    shapedTexts,
    text,
    textStyles,
  };
}

describe("text on path rendering", () => {
  it.each([
    ["left", 20],
    ["center", 95],
    ["right", 170],
  ] as const)("places %s-aligned text along the available path", (align, firstMid) => {
    const { canvas, drawTextOnPath, renderer, text } = rendererHarness();
    text.align = align;

    expect(drawTextOnPath(canvas, text)).toBe(true);

    expect(renderer.getTextPathLayout(text.id)?.[0]?.x).toBeCloseTo(firstMid, 6);
  });

  it("uses paragraph-shaped glyph IDs and OpenType features", () => {
    const { blobGlyphs, canvas, drawTextOnPath, shapedTexts, text, textStyles } =
      rendererHarness([777], [0, 0, 28, 0]);
    text.content = "fi\nmark";
    text.otFeatures = { liga: true, dlig: false };

    drawTextOnPath(canvas, text);

    expect(shapedTexts).toEqual(["fi mark"]);
    expect(blobGlyphs).toEqual([[777]]);
    expect(textStyles.some((style) =>
      JSON.stringify(style.fontFeatures) ===
      JSON.stringify([
        { name: "liga", value: 1 },
        { name: "dlig", value: 0 },
      ]),
    )).toBe(true);
  });

  it("hits the live glyph run instead of the stale text box", () => {
    const { canvas, drawTextOnPath, nodeContains, text } = rendererHarness();

    drawTextOnPath(canvas, text);

    expect(nodeContains(text, { x: 20, y: 95 })).toBe(true);
    expect(nodeContains(text, { x: text.x + 2, y: text.y + 2 })).toBe(false);
  });

  it("anchors text gradients to the live glyph-run bounds", () => {
    const { canvas, drawTextOnPath, paintBoxes, text } = rendererHarness();
    text.fill = {
      type: "linear-gradient",
      angle: 0,
      stops: [
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff" },
      ],
    };

    drawTextOnPath(canvas, text);

    expect(paintBoxes[0]).toEqual({ x: 10, y: 85, width: 40, height: 20 });
  });

  it.each([
    ["inside", "dst-in"],
    ["outside", "dst-out"],
  ] as const)("keeps the shaped arc-text %s stroke mask", (align, blend) => {
    const { canvas, drawTextOnPath, paints, text } = rendererHarness();
    text.stroke = { color: "#112233", width: 3, align };

    drawTextOnPath(canvas, text);

    expect(canvas.drawTextBlob).toHaveBeenCalledTimes(3);
    expect(canvas.saveLayer).toHaveBeenCalledOnce();
    expect(paints.some((paint) => paint.strokeWidth === 6)).toBe(true);
    expect(paints.some((paint) =>
      JSON.stringify(paint.blendMode) === JSON.stringify({ name: blend }),
    )).toBe(true);
  });
});
