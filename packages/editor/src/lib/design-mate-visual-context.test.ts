import { describe, expect, it } from "vitest";
import {
  createArtboard,
  createGroup,
  createInitialDocument,
  createRectangle,
  getActiveArtboard,
  paintBounds,
  type LogoDocument,
} from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateSelection,
} from "@openlogo/design-mate";
import {
  bytesToBase64,
  calculateDesignMateRasterDimensions,
  captureDesignMateVisualContext,
  frameDesignMateArtboardSvg,
  hasPngSignature,
  isAcceptableDesignMatePng,
  planDesignMateVisualTargets,
  type DesignMateVisualCaptureDependencies,
} from "./design-mate-visual-context";
import { documentToSvg } from "./export";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function pngHeader(width: number, height: number, size = 33): Uint8Array {
  const bytes = new Uint8Array(Math.max(33, size));
  bytes.set(PNG_SIGNATURE);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function svgViewBox(svg: string): number[] {
  return svg
    .match(/<svg\b[^>]*\bviewBox="([^"]+)"/)![1]!
    .split(/\s+/)
    .map(Number);
}

function documentWithVariants(): LogoDocument {
  const initial = createInitialDocument();
  const iconA = createArtboard("icon", { name: "Icon A" });
  const iconB = createArtboard("icon", { name: "Icon B" });
  const wordmark = createArtboard("wordmark", { name: "Wordmark" });
  const stacked = createArtboard("stacked", { name: "Stacked" });
  return {
    ...initial,
    artboards: [
      initial.artboards[0]!,
      iconA,
      iconB,
      wordmark,
      stacked,
    ],
  };
}

function selectionFor(document: LogoDocument): DesignMateSelection {
  return {
    selectedNodeIds: [document.artboards[0]!.nodeIds[0]!],
  };
}

function fakeDependencies(
  overrides: Partial<DesignMateVisualCaptureDependencies> = {},
): DesignMateVisualCaptureDependencies {
  return {
    renderArtboard: (_document, artboard) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${artboard.width} ${artboard.height}"></svg>`,
    embedFonts: async (svg) => svg,
    rasterizePng: async (_svg, width, height, scale) =>
      pngHeader(Math.round(width * scale), Math.round(height * scale)),
    ...overrides,
  };
}

describe("Design Mate visual target planning", () => {
  it("falls empty selection back exactly to active-artboard scope", () => {
    const document = createInitialDocument();
    const plan = planDesignMateVisualTargets(
      document,
      { selectedNodeIds: ["missing-node"] },
      "selection",
    );
    expect(plan.scope).toBe("active-artboard");
    expect(plan.targets).toEqual([
      expect.objectContaining({
        kind: "active-artboard",
        artboardId: document.activeArtboardId,
      }),
    ]);
  });

  it("uses deterministic owning-artboard context for selection targets", () => {
    const document = createInitialDocument();
    const selection = selectionFor(document);
    const plan = planDesignMateVisualTargets(
      document,
      selection,
      "selection",
    );
    expect(plan.scope).toBe("selection");
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({
      kind: "selection",
      artboardId: document.activeArtboardId,
      nodeIds: selection.selectedNodeIds,
    });
    expect(plan.targets[0]!.sourceWidth).toBeGreaterThan(0);
    expect(plan.targets[0]!.sourceHeight).toBeGreaterThan(0);
  });

  it("orders cross-artboard selections by document order and caps at three", () => {
    const document = createInitialDocument();
    const selectedNodeIds = [document.artboards[0]!.nodeIds[0]!];
    for (let index = 1; index <= 3; index += 1) {
      const node = createRectangle({
        x: 20 * index,
        y: 10,
      });
      node.name = `Mark ${index}`;
      const artboard = createArtboard("icon", {
        name: `Board ${index}`,
        nodeIds: [node.id],
      });
      document.nodes[node.id] = node;
      document.artboards.push(artboard);
      selectedNodeIds.push(node.id);
    }

    const forward = planDesignMateVisualTargets(
      document,
      { selectedNodeIds },
      "selection",
    );
    const reversed = planDesignMateVisualTargets(
      document,
      { selectedNodeIds: [...selectedNodeIds].reverse() },
      "selection",
    );

    expect(forward.targets).toHaveLength(3);
    expect(forward.targets.map((target) => target.artboardId)).toEqual(
      document.artboards.slice(0, 3).map((artboard) => artboard.id),
    );
    expect(reversed.targets).toEqual(forward.targets);
  });

  it("orders active first, prefers unique variants, and caps at three", () => {
    const document = documentWithVariants();
    const before = JSON.stringify(document);
    const plan = planDesignMateVisualTargets(
      document,
      { selectedNodeIds: [] },
      "document",
    );
    expect(plan.targets.map((target) => target.artboardId)).toEqual([
      document.activeArtboardId,
      document.artboards[1]!.id,
      document.artboards[3]!.id,
    ]);
    expect(plan.targets.map((target) => target.kind)).toEqual([
      "active-artboard",
      "document-overview",
      "document-overview",
    ]);
    expect(plan.targets).toHaveLength(DESIGN_MATE_CHAT_LIMITS.attachments);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("Design Mate visual dimensions and encoding", () => {
  it("preserves landscape and portrait aspect ratios within the contract", () => {
    expect(calculateDesignMateRasterDimensions(1_000, 500, 512)).toEqual({
      width: 512,
      height: 256,
      scale: 0.512,
    });
    expect(calculateDesignMateRasterDimensions(500, 1_000, 384)).toEqual({
      width: 192,
      height: 384,
      scale: 0.384,
    });
    expect(calculateDesignMateRasterDimensions(2_000, 100, 512)).toEqual({
      width: 512,
      height: 32,
      scale: 0.256,
    });
    expect(calculateDesignMateRasterDimensions(0, 100, 512)).toBeNull();
  });

  it("frames an exact artboard render without injecting a background", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ffffff" /></svg>';
    const framed = frameDesignMateArtboardSvg(svg, {
      x: -5,
      y: -6,
      width: 10,
      height: 12,
    });
    expect(svgViewBox(framed!)).toEqual([-5, -6, 10, 12]);
    expect(framed!.match(/fill="#ffffff"/g)).toHaveLength(1);
    expect(framed).not.toContain("<rect");
    expect(
      frameDesignMateArtboardSvg("<not-svg />", {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).toBeNull();
  });

  it("validates the PNG signature and cap before pure base64 encoding", () => {
    expect(hasPngSignature(PNG_SIGNATURE)).toBe(true);
    expect(isAcceptableDesignMatePng(PNG_SIGNATURE)).toBe(false);
    expect(isAcceptableDesignMatePng(pngHeader(32, 32), 32, 32)).toBe(
      true,
    );
    expect(isAcceptableDesignMatePng(pngHeader(64, 32), 32, 32)).toBe(
      false,
    );
    expect(bytesToBase64(PNG_SIGNATURE)).toBe("iVBORw0KGgo=");
    expect(hasPngSignature(new Uint8Array(8))).toBe(false);

    const oversized = pngHeader(
      32,
      32,
      DESIGN_MATE_CHAT_LIMITS.attachmentBytes + 1,
    );
    expect(isAcceptableDesignMatePng(oversized)).toBe(false);
  });
});

describe("Design Mate visual capture", () => {
  it("renders the full owning artboard, crops by viewport, and never mutates", async () => {
    const document = createInitialDocument();
    const selection = selectionFor(document);
    const before = JSON.stringify(document);
    const calls: string[] = [];
    const result = await captureDesignMateVisualContext(
      document,
      selection,
      { scope: "selection", generation: 3, revision: 9 },
      fakeDependencies({
        renderArtboard: (source, artboard) => {
          calls.push(`artboard:${artboard.id}`);
          return documentToSvg(source, artboard);
        },
        embedFonts: async (svg) => {
          calls.push("fonts");
          return svg;
        },
        rasterizePng: async (svg, width, height, scale) => {
          calls.push(
            `raster:${Math.round(Math.max(width, height) * scale)}`,
          );
          const emittedViewBox = svgViewBox(svg);
          expect(emittedViewBox[2]).toBeCloseTo(width, 8);
          expect(emittedViewBox[3]).toBeCloseTo(height, 8);
          expect(svg).toContain(
            `viewBox="0 0 ${getActiveArtboard(document).width} ${getActiveArtboard(document).height}"`,
          );
          return pngHeader(
            Math.round(width * scale),
            Math.round(height * scale),
          );
        },
      }),
    );

    expect(result).toMatchObject({
      scope: "selection",
      attemptedTargets: 1,
      failedTargets: 0,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      kind: "selection",
      mimeType: "image/png",
      byteLength: 33,
      width: 512,
      height: 512,
      identity: {
        documentId: document.id,
        generation: 3,
        revision: 9,
      },
    });
    expect(result.attachments[0]!.label!.length).toBeLessThanOrEqual(
      DESIGN_MATE_CHAT_LIMITS.attachmentLabelLength,
    );
    expect(calls).toEqual([
      `artboard:${document.activeArtboardId}`,
      "fonts",
      "raster:512",
    ]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("preserves a dark artboard behind a selected white mark", async () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    artboard.background = "#111827";
    const mark = createRectangle({
      x: 40,
      y: 30,
      fill: "#ffffff",
    });
    mark.name = "White mark";
    mark.width = 80;
    mark.height = 60;
    document.nodes = { [mark.id]: mark };
    artboard.nodeIds = [mark.id];

    let rasterSvg = "";
    const result = await captureDesignMateVisualContext(
      document,
      { selectedNodeIds: [mark.id] },
      { scope: "selection", generation: 0, revision: 0 },
      fakeDependencies({
        renderArtboard: (source, owner) => documentToSvg(source, owner),
        rasterizePng: async (svg, width, height, scale) => {
          rasterSvg = svg;
          return pngHeader(
            Math.round(width * scale),
            Math.round(height * scale),
          );
        },
      }),
    );

    expect(result.attachments).toHaveLength(1);
    expect(rasterSvg).toContain(
      '<rect width="100%" height="100%" fill="#111827" />',
    );
    expect(rasterSvg.match(/fill="#ffffff"/g)).toHaveLength(1);
  });

  it("uses paint bounds for strokes and directional drop shadows", () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const mark = createRectangle({ x: 100, y: 80 });
    mark.width = 120;
    mark.height = 60;
    mark.stroke = { color: "#ffffff", width: 12, align: "center" };
    mark.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 24,
        dy: -8,
        blur: 8,
        color: "#000000",
        opacity: 0.5,
      },
    ];
    document.nodes = { [mark.id]: mark };
    artboard.nodeIds = [mark.id];

    const target = planDesignMateVisualTargets(
      document,
      { selectedNodeIds: [mark.id] },
      "selection",
    ).targets[0]!;
    const expected = paintBounds(document, mark.id)!;
    expect(target.selectionBounds).toEqual(expected);
    expect(target.sourceWidth).toBe(expected.width);
    expect(target.sourceHeight).toBe(expected.height);
  });

  it("retains clipping, opacity, effects, and artboard z-order for a child", async () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const content = createRectangle({ x: 20, y: 20 });
    content.name = "Selected child";
    content.width = 180;
    content.height = 120;
    const mask = createRectangle({ x: 50, y: 40 });
    mask.name = "Clip";
    mask.width = 80;
    mask.height = 60;
    const group = createGroup([content.id, mask.id]);
    group.name = "Opacity group";
    group.opacity = 0.35;
    group.clippingMaskId = mask.id;
    group.effects = [
      {
        type: "outline",
        enabled: true,
        width: 4,
        color: "#2563eb",
        opacity: 1,
      },
    ];
    const foreground = createRectangle({
      x: 60,
      y: 50,
      fill: "#f97316",
    });
    foreground.name = "Foreground context";
    document.nodes = {
      [content.id]: content,
      [mask.id]: mask,
      [group.id]: group,
      [foreground.id]: foreground,
    };
    artboard.nodeIds = [group.id, foreground.id];

    let rasterSvg = "";
    await captureDesignMateVisualContext(
      document,
      { selectedNodeIds: [content.id] },
      { scope: "selection", generation: 0, revision: 0 },
      fakeDependencies({
        renderArtboard: (source, owner) => documentToSvg(source, owner),
        rasterizePng: async (svg, width, height, scale) => {
          rasterSvg = svg;
          return pngHeader(
            Math.round(width * scale),
            Math.round(height * scale),
          );
        },
      }),
    );

    expect(rasterSvg).toContain("<clipPath");
    expect(rasterSvg).toContain('opacity="0.35"');
    expect(rasterSvg).toContain('data-name="Opacity group"');
    expect(rasterSvg).toContain('fill="#f97316"');
    expect(rasterSvg.indexOf('data-name="Opacity group"')).toBeLessThan(
      rasterSvg.indexOf('fill="#f97316"'),
    );
    const crop = svgViewBox(rasterSvg);
    const expected = paintBounds(document, group.id)!;
    expect(crop[0]).toBeLessThanOrEqual(expected.x);
    expect(crop[1]).toBeLessThanOrEqual(expected.y);
    expect(crop[0]! + crop[2]!).toBeGreaterThanOrEqual(
      expected.x + expected.width,
    );
    expect(crop[1]! + crop[3]!).toBeGreaterThanOrEqual(
      expected.y + expected.height,
    );
  });

  it("contain-fits a 20:1 artboard on a padded 512 by 32 canvas", async () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    artboard.width = 2_000;
    artboard.height = 100;
    let rasterCall:
      | {
          width: number;
          height: number;
          scale: number;
          viewBox: number[];
        }
      | undefined;

    const result = await captureDesignMateVisualContext(
      document,
      { selectedNodeIds: [] },
      { scope: "active-artboard", generation: 0, revision: 0 },
      fakeDependencies({
        renderArtboard: (source, owner) => documentToSvg(source, owner),
        rasterizePng: async (svg, width, height, scale) => {
          rasterCall = { width, height, scale, viewBox: svgViewBox(svg) };
          return pngHeader(
            Math.round(width * scale),
            Math.round(height * scale),
          );
        },
      }),
    );

    expect(rasterCall).toBeDefined();
    expect(rasterCall!.viewBox[2]).toBeCloseTo(rasterCall!.width, 8);
    expect(rasterCall!.viewBox[3]).toBeCloseTo(rasterCall!.height, 8);
    expect(rasterCall).toMatchObject({
      width: 2_000,
      height: 125,
      scale: 0.256,
    });
    expect(result.attachments[0]).toMatchObject({
      width: 512,
      height: 32,
    });
  });

  it("retries at a smaller edge when PNG bytes exceed the cap", async () => {
    const document = createInitialDocument();
    const edges: number[] = [];
    const result = await captureDesignMateVisualContext(
      document,
      { selectedNodeIds: [] },
      { scope: "active-artboard", generation: 0, revision: 0 },
      fakeDependencies({
        rasterizePng: async (_svg, width, height, scale) => {
          const edge = Math.round(Math.max(width, height) * scale);
          edges.push(edge);
          return pngHeader(
            Math.round(width * scale),
            Math.round(height * scale),
            edge === 512
              ? DESIGN_MATE_CHAT_LIMITS.attachmentBytes + 1
              : 33,
          );
        },
      }),
    );

    expect(edges).toEqual([512, 384]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      width: 384,
      height: 224,
    });
  });

  it("rejects invalid PNG output without base64 or a broken attachment", async () => {
    const document = createInitialDocument();
    const result = await captureDesignMateVisualContext(
      document,
      { selectedNodeIds: [] },
      { scope: "active-artboard", generation: 0, revision: 0 },
      fakeDependencies({
        rasterizePng: async () => new Uint8Array(32),
      }),
    );
    expect(result.attachments).toEqual([]);
    expect(result.failedTargets).toBe(1);
  });
});
