// @vitest-environment happy-dom

import { Effect } from "effect";
import {
  type LogoDocument,
  type LogoNode,
  type PathNode,
  type TextNode,
  createGroup,
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
} from "@openlogo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentToSvg } from "./export";
import { documentStore } from "../state/document";

vi.mock("./canvaskit", async () => {
  const { Effect } = await import("effect");
  const canvasKit = {
    Path: {
      MakeFromSVGString: (d: string) => ({
        transform: vi.fn(),
        computeTightBounds: () => new Float32Array([0, 0, 100, 100]),
        toSVGString: () => d,
        toCmds: () =>
          new Float32Array([
            0, 0, 0, 1, 100, 0, 1, 100, 100, 1, 0, 100, 5,
          ]),
        delete: vi.fn(),
      }),
    },
  };
  return { canvasKit: Effect.succeed(canvasKit) };
});

import {
  MAX_SVG_IMPORT_BYTES,
  SvgImportError,
  importSvg,
  transformedStrokeWidth,
} from "./svg-import";

type ImportResult = string[] & { warnings?: readonly string[] };

function emptyDocument(): LogoDocument {
  const document = createInitialDocument();
  document.nodes = {};
  document.artboards[0] = { ...document.artboards[0]!, nodeIds: [] };
  return document;
}

async function runImport(svg: string): Promise<ImportResult> {
  return (await Effect.runPromise(importSvg(svg))) as ImportResult;
}

function importedNodes(): LogoNode[] {
  return Object.values(documentStore.document.nodes);
}

function nodeNamed(name: string): LogoNode | undefined {
  return importedNodes().find((node) => node.name === name);
}

beforeEach(() => {
  documentStore.reset(emptyDocument());
});

describe("SVG import hardening", () => {
  it("round-trips cascaded group opacity and nested clipping wrappers", async () => {
    const source = emptyDocument();
    const mask = createRectangle({ x: 20, y: 20 });
    mask.width = 80;
    mask.height = 80;
    const first = createRectangle({ x: 0, y: 0 });
    first.name = "First clipped child";
    first.opacity = 0.8;
    const second = createRectangle({ x: 40, y: 40 });
    second.name = "Second clipped child";
    second.opacity = 0.6;
    const group = createGroup([first.id, second.id, mask.id]);
    group.name = "Soft clip";
    group.opacity = 0.5;
    group.clippingMaskId = mask.id;
    group.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 12,
        dy: 8,
        blur: 20,
        color: "#000000",
        opacity: 0.5,
      },
    ];
    source.nodes = {
      [first.id]: first,
      [second.id]: second,
      [mask.id]: mask,
      [group.id]: group,
    };
    source.artboards[0] = {
      ...source.artboards[0]!,
      nodeIds: [group.id],
    };

    await runImport(documentToSvg(source, source.artboards[0]));

    const importedGroup = importedNodes().find(
      (node): node is Extract<LogoNode, { type: "group" }> =>
        node.type === "group" && node.clippingMaskId !== undefined,
    );
    expect(importedGroup).toBeDefined();
    expect(nodeNamed(first.name)?.opacity).toBeCloseTo(0.4);
    expect(nodeNamed(second.name)?.opacity).toBeCloseTo(0.3);
  });

  it("rejects oversized source before parsing or loading CanvasKit", async () => {
    const error = await Effect.runPromise(
      Effect.flip(importSvg(" ".repeat(MAX_SVG_IMPORT_BYTES + 1))),
    );
    expect(error).toBeInstanceOf(SvgImportError);
    expect(error._tag).toBe("SvgImportError");
    if (error._tag === "SvgImportError") {
      expect(error.reason).toContain("5 MB");
    }
  });

  it("scales strokes with uniform, rotated, and non-uniform transforms", () => {
    expect(transformedStrokeWidth(3, [2, 0, 0, 2, 0, 0])).toBe(6);
    expect(transformedStrokeWidth(3, [0, 1, -1, 0, 0, 0])).toBe(3);
    expect(transformedStrokeWidth(3, [4, 0, 0, 2, 0, 0])).toBe(12);
  });

  it("round-trips OpenLogo paint, text, effects, transparency, and metadata", async () => {
    const document = emptyDocument();
    document.artboards[0] = {
      ...document.artboards[0]!,
      width: 640,
      height: 480,
    };

    const path = createPath({
      x: 40,
      y: 50,
      d: "M 0 0 L 100 0 L 100 100 L 0 100 Z",
      name: "Gradient path",
    });
    path.intrinsicWidth = 100;
    path.intrinsicHeight = 100;
    path.width = 180;
    path.height = 120;
    path.fill = {
      type: "linear-gradient",
      angle: 33,
      start: { x: 0.1, y: 0.2 },
      end: { x: 0.9, y: 0.8 },
      stops: [
        { offset: 0, color: "#ff0000", alpha: 0.4 },
        { offset: 1, color: "#0000ff" },
      ],
    };
    path.stroke = {
      color: "#123456",
      width: 7,
      align: "center",
      paint: {
        type: "radial-gradient",
        cx: 0.4,
        cy: 0.6,
        r: 0.75,
        fx: 0.2,
        fy: 0.3,
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#000000", alpha: 0.25 },
        ],
      },
    };
    path.blendMode = "multiply";
    path.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 4,
        dy: 6,
        blur: 8,
        color: "#112233",
        opacity: 0.6,
      },
      {
        type: "outline",
        enabled: true,
        width: 3,
        color: "#445566",
        opacity: 0.7,
      },
      {
        type: "bevel",
        enabled: true,
        size: 2,
        soften: 4,
        intensity: 0.8,
      },
      {
        type: "glow",
        enabled: true,
        blur: 10,
        color: "#778899",
        opacity: 0.5,
      },
    ];

    const text = createText({ x: 260, y: 70, content: "Open\nLogo" });
    text.name = "Kerned multiline";
    text.width = 240;
    text.height = 130;
    text.fontFamily = "Inter";
    text.fontSize = 36;
    text.fontWeight = 650;
    text.fontStyle = "italic";
    text.letterSpacing = 1.5;
    text.lineHeight = 1.4;
    text.align = "center";
    text.kerning = { 0: -80, 4: 45 };
    text.otFeatures = { liga: false, smcp: true };

    const pathText = createText({ x: 40, y: 50, content: "Around\nHere" });
    pathText.name = "Path label";
    pathText.align = "center";
    pathText.onPath = { pathId: path.id, startOffset: 14, flip: true };

    const transparent = createPath({
      x: 30,
      y: 300,
      d: "M 0 0 L 80 0 L 80 40 L 0 40 Z",
      name: "Transparent node",
    });
    transparent.fill = { type: "solid", color: "#00000000" };
    transparent.opacity = 0;

    const rounded = createRectangle({ x: 400, y: 300 });
    rounded.name = "Hidden rounded";
    rounded.cornerRadius = 27;
    rounded.visible = false;

    document.nodes = Object.fromEntries(
      [path, text, pathText, transparent, rounded].map((node) => [node.id, node]),
    );
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [path.id, text.id, pathText.id, transparent.id, rounded.id],
    };

    const svg = documentToSvg(document, document.artboards[0]);
    const result = await runImport(svg);

    expect(result.warnings ?? []).toEqual([]);
    expect(importedNodes().filter((node) => node.type !== "group")).toHaveLength(5);
    const importedPath = nodeNamed(path.name) as PathNode | undefined;
    expect(importedPath).toBeDefined();
    if (importedPath?.type === "path") {
      expect(importedPath.x).toBeCloseTo(path.x, 5);
      expect(importedPath.y).toBeCloseTo(path.y, 5);
      expect(importedPath.width).toBeCloseTo(path.width, 5);
      expect(importedPath.height).toBeCloseTo(path.height, 5);
      expect(importedPath.fill).toEqual(path.fill);
      expect(importedPath.stroke).toEqual(path.stroke);
      expect(importedPath.blendMode).toBe(path.blendMode);
      expect(importedPath.effects).toEqual(path.effects);
    }

    const importedText = nodeNamed(text.name) as TextNode | undefined;
    expect(importedText).toBeDefined();
    if (importedText?.type === "text") {
      expect(importedText.content).toBe(text.content);
      expect(importedText.fontFamily).toBe(text.fontFamily);
      expect(importedText.fontSize).toBe(text.fontSize);
      expect(importedText.fontWeight).toBe(text.fontWeight);
      expect(importedText.fontStyle).toBe(text.fontStyle);
      expect(importedText.letterSpacing).toBe(text.letterSpacing);
      expect(importedText.lineHeight).toBe(text.lineHeight);
      expect(importedText.align).toBe(text.align);
      expect(importedText.kerning).toEqual(text.kerning);
      expect(importedText.otFeatures).toEqual(text.otFeatures);
    }

    const importedPathText = nodeNamed(pathText.name) as TextNode | undefined;
    expect(importedPathText).toBeDefined();
    if (importedPathText?.type === "text") {
      expect(importedPathText.content).toBe("Around Here");
      expect(importedPathText.align).toBe("center");
      expect(importedPathText.onPath?.startOffset).toBe(14);
      expect(importedPathText.onPath?.flip).toBe(true);
      expect(documentStore.document.nodes[importedPathText.onPath!.pathId]?.name).toBe(
        path.name,
      );
    }

    const importedTransparent = nodeNamed(transparent.name);
    expect(importedTransparent?.opacity).toBe(0);
    expect(importedTransparent?.fill).toEqual(transparent.fill);

    const importedRounded = nodeNamed(rounded.name);
    expect(importedRounded?.type).toBe("rectangle");
    if (importedRounded?.type === "rectangle") {
      expect(importedRounded.cornerRadius).toBe(rounded.cornerRadius);
      expect(importedRounded.visible).toBe(false);
    }
  });

  it("inherits legacy wrapper strokes for exported paths", async () => {
    await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g fill="#abcdef" stroke="#123456" stroke-width="9">
          <path d="M 0 0 L 100 0 L 100 100 Z" />
        </g>
      </svg>
    `);

    const path = importedNodes().find((node) => node.type === "path");
    expect(path?.stroke).toEqual({
      color: "#123456",
      width: 9,
      align: "center",
    });
  });

  it("imports foreign text that maps cleanly and warns about unsupported text", async () => {
    const result = await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120">
        <text x="10" y="20" transform="rotate(12 100 60)"
          font-family="Inter" font-size="20"
          font-weight="600" font-style="italic" letter-spacing="2"
          style="font-feature-settings: 'liga' 0; line-height:1.3; inline-size:180px">
          <tspan x="10" y="20">Hello</tspan><tspan x="10" y="46">SVG</tspan>
        </text>
        <text><textPath href="#missing">Lost</textPath></text>
      </svg>
    `);

    const text = importedNodes().find((node) => node.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text") {
      expect(text.content).toBe("Hello\nSVG");
      expect(text.fontFamily).toBe("Inter");
      expect(text.fontSize).toBe(20);
      expect(text.fontWeight).toBe(600);
      expect(text.fontStyle).toBe("italic");
      expect(text.width).toBe(180);
      expect(text.rotation).toBe(12);
      expect(text.letterSpacing).toBe(2);
      expect(text.lineHeight).toBe(1.3);
      expect(text.otFeatures).toEqual({ liga: false });
    }
    expect(result.warnings?.join(" ")).toMatch(/1 unsupported text/i);
  });

  it("resolves foreign linear and radial gradients for fill and stroke", async () => {
    const result = await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="fill" x1="0.1" y1="0.2" x2="0.9" y2="0.8">
            <stop offset="0" stop-color="#f00" stop-opacity="0.25" />
            <stop offset="100%" stop-color="#00f" />
          </linearGradient>
          <radialGradient id="stroke" cx="40%" cy="50%" r="80%" fx="20%" fy="30%">
            <stop offset="0" stop-color="#fff" />
            <stop offset="1" stop-color="#000" stop-opacity="0.5" />
          </radialGradient>
        </defs>
        <path d="M 0 0 L 100 0 L 100 100 Z" fill="url(#fill)"
          stroke="url(#stroke)" stroke-width="4" />
      </svg>
    `);

    expect(result.warnings ?? []).toEqual([]);
    const path = importedNodes().find((node) => node.type === "path");
    expect(path?.fill).toEqual({
      type: "linear-gradient",
      angle: expect.any(Number),
      start: { x: 0.1, y: 0.2 },
      end: { x: 0.9, y: 0.8 },
      stops: [
        { offset: 0, color: "#f00", alpha: 0.25 },
        { offset: 1, color: "#00f" },
      ],
    });
    expect(path?.stroke?.paint).toEqual({
      type: "radial-gradient",
      cx: 0.4,
      cy: 0.5,
      r: 0.8,
      fx: 0.2,
      fy: 0.3,
      stops: [
        { offset: 0, color: "#fff" },
        { offset: 1, color: "#000", alpha: 0.5 },
      ],
    });
  });

  it("parses exported blend modes and all four effect graphs", async () => {
    const source = emptyDocument();
    const path = createPath({
      x: 0,
      y: 0,
      d: "M 0 0 L 100 0 L 100 100 Z",
      name: "Effects",
    });
    path.blendMode = "screen";
    path.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 3,
        dy: 5,
        blur: 8,
        color: "#111111",
        opacity: 0.4,
      },
      {
        type: "outline",
        enabled: true,
        width: 2,
        color: "#222222",
        opacity: 0.5,
      },
      {
        type: "bevel",
        enabled: true,
        size: 3,
        soften: 6,
        intensity: 0.7,
      },
      {
        type: "glow",
        enabled: true,
        blur: 12,
        color: "#333333",
        opacity: 0.6,
      },
    ];
    source.nodes = { [path.id]: path };
    source.artboards[0] = { ...source.artboards[0]!, nodeIds: [path.id] };

    const result = await runImport(
      documentToSvg(source, source.artboards[0], { transparentBackground: true }),
    );
    expect(result.warnings ?? []).toEqual([]);
    const imported = nodeNamed(path.name);
    expect(imported?.blendMode).toBe("screen");
    expect(imported?.effects).toEqual(path.effects);
  });

  it("warns instead of silently dropping unknown paint servers and filters", async () => {
    const result = await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <pattern id="p" width="10" height="10" />
          <filter id="f"><feTurbulence /></filter>
        </defs>
        <path d="M 0 0 L 100 0 L 100 100 Z" fill="url(#p)" filter="url(#f)" />
      </svg>
    `);

    expect(importedNodes().some((node) => node.type === "path")).toBe(true);
    expect(result.warnings?.join(" ")).toMatch(/paint server/i);
    expect(result.warnings?.join(" ")).toMatch(/filter/i);
  });

  it("keeps marked transparent nodes but preserves foreign transparent pruning", async () => {
    await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg" data-openlogo-version="1">
        <path data-openlogo-name="Invisible" d="M 0 0 L 100 0 L 100 100 Z"
          fill="#00000000" opacity="0" />
      </svg>
    `);
    expect(nodeNamed("Invisible")?.opacity).toBe(0);

    documentStore.reset(emptyDocument());
    await runImport(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <path d="M 0 0 L 100 0 L 100 100 Z" fill="none" />
      </svg>
    `);
    expect(importedNodes()).toEqual([]);
  });
});
