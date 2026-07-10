import {
  type LogoDocument,
  type LogoNode,
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
} from "@openlogo/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { documentToSvg, nodeToPreviewSvg } from "./export";
import { embedSvgFontFaces } from "./svg-fonts";
import {
  TextOutlineUnavailableError,
  outlineDocumentTexts,
} from "./text-to-path";

function documentWith(node: LogoNode): LogoDocument {
  const document = createInitialDocument();
  document.nodes = { [node.id]: node };
  document.artboards[0] = {
    ...document.artboards[0]!,
    nodeIds: [node.id],
  };
  return document;
}

describe("secure and faithful SVG generation", () => {
  it("escapes every user-controlled paint attribute used by layer previews", () => {
    const node = createRectangle({ x: 0, y: 0 });
    node.fill = {
      type: "solid",
      color: '#fff" onload="globalThis.__injected=true',
    };
    node.stroke = {
      color: '#000" onclick="evil()',
      width: 2,
      align: "center",
    };
    node.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 2,
        dy: 2,
        blur: 4,
        color: '#123" onmouseover="evil()',
        opacity: 1,
      },
    ];
    const document = documentWith(node);
    document.artboards[0]!.background = '#eee" onload="evil()';

    const preview = nodeToPreviewSvg(document, node.id)!;
    const exported = documentToSvg(document);
    expect(preview).toContain(
      'fill="#fff&quot; onload=&quot;globalThis.__injected=true"',
    );
    expect(preview).not.toContain('fill="#fff" onload=');
    expect(preview).not.toContain('stroke="#000" onclick=');
    expect(preview).not.toContain('flood-color="#123" onmouseover=');
    expect(exported).not.toContain('fill="#eee" onload=');
  });

  it("exports path blend modes on the transformed wrapper", () => {
    const path = createPath({ x: 0, y: 0 });
    path.blendMode = "multiply";
    const svg = documentToSvg(documentWith(path));
    expect(svg).toMatch(
      /<g[^>]*style="mix-blend-mode:multiply"[^>]*><path/,
    );
  });

  it("drops invalid OpenType tags before writing inline CSS", () => {
    const text = createText({ x: 0, y: 0, content: "Safe" });
    text.otFeatures = {
      liga: false,
      [`x';filter:url(evil)`]: true,
    };
    const svg = documentToSvg(documentWith(text));
    expect(svg).toContain("font-feature-settings: 'liga' 0");
    expect(svg).not.toContain("filter:url(evil)");
  });

  it("matches renderer angle-gradient geometry on a non-square box", () => {
    const node = createRectangle({ x: 0, y: 0 });
    node.width = 200;
    node.height = 100;
    node.fill = {
      type: "linear-gradient",
      angle: 90,
      stops: [
        { offset: 0, color: "#000" },
        { offset: 1, color: "#fff" },
      ],
    };
    const svg = documentToSvg(documentWith(node));
    const gradient = svg.match(
      /<linearGradient[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/,
    );
    expect(gradient).not.toBeNull();
    expect(Number(gradient![1])).toBeCloseTo(0.5, 6);
    expect(Number(gradient![2])).toBeCloseTo(-0.5, 6);
    expect(Number(gradient![3])).toBeCloseTo(0.5, 6);
    expect(Number(gradient![4])).toBeCloseTo(1.5, 6);
  });

  it("exports top-aligned multiline text using the document line height", () => {
    const text = createText({ x: 20, y: 40, content: "Open\nLogo" });
    text.lineHeight = 1.5;
    const svg = documentToSvg(documentWith(text));
    expect(svg).toContain('y="40" dominant-baseline="text-before-edge"');
    expect(svg).toContain("line-height:1.5");
    expect(svg).toContain('<tspan x="20" y="40">Open</tspan>');
    expect(svg).toContain('<tspan x="20" y="106">Logo</tspan>');
  });

  it("embeds font bytes into a self-contained raster source SVG", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Logo</text></svg>';
    const embedded = embedSvgFontFaces(svg, [
      {
        family: 'Safe "Family"',
        weight: 700,
        style: "italic",
        bytes: new Uint8Array([0, 1, 2]).buffer,
      },
    ]);
    expect(embedded).toContain("@font-face");
    expect(embedded).toContain("data:font/ttf;base64,AAEC");
    expect(embedded).toContain("font-weight:700");
    expect(embedded).toContain("<defs><style");
  });

  it("fails strict outline export instead of silently retaining text on a path", async () => {
    const path = createPath({ x: 0, y: 0 });
    const text = createText({ x: 0, y: 0, content: "Attached" });
    text.onPath = { pathId: path.id, startOffset: 0, flip: false };
    const document = createInitialDocument();
    document.nodes = { [path.id]: path, [text.id]: text };
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [path.id, text.id],
    };

    const error = await Effect.runPromise(
      Effect.flip(outlineDocumentTexts(document, { failOnSkip: true })),
    );
    expect(error).toBeInstanceOf(TextOutlineUnavailableError);
    expect(error._tag).toBe("TextOutlineUnavailableError");
    if (error._tag === "TextOutlineUnavailableError") {
      expect(error.nodeIds).toEqual([text.id]);
    }
  });
});
