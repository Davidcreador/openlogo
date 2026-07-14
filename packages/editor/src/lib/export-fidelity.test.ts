import {
  type LogoDocument,
  type LogoNode,
  createEllipse,
  createGroup,
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
  it("cascades nested group opacity onto leaves instead of isolating groups", () => {
    const first = createRectangle({ x: 10, y: 20 });
    first.opacity = 0.8;
    const second = createEllipse({ x: 30, y: 40 });
    second.opacity = 0.6;
    const inner = createGroup([first.id, second.id]);
    inner.opacity = 0.5;
    const outer = createGroup([inner.id]);
    outer.opacity = 0.5;
    const document = createInitialDocument();
    document.nodes = {
      [first.id]: first,
      [second.id]: second,
      [inner.id]: inner,
      [outer.id]: outer,
    };
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [outer.id],
    };

    const svg = documentToSvg(document);

    expect(svg).toContain('<rect opacity="0.2"');
    expect(svg).toContain('<ellipse opacity="0.15"');
    expect(svg.match(/<g[^>]* opacity=/g)).toBeNull();
  });

  it("wraps a clipped group so effects can bleed beyond the clip", () => {
    const mask = createRectangle({ x: 20, y: 20 });
    mask.width = 80;
    mask.height = 80;
    const content = createRectangle({ x: 0, y: 0 });
    content.width = 140;
    content.height = 140;
    const group = createGroup([content.id, mask.id]);
    group.clippingMaskId = mask.id;
    group.blendMode = "multiply";
    group.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 18,
        dy: 12,
        blur: 24,
        color: "#000000",
        opacity: 0.7,
      },
    ];
    const document = createInitialDocument();
    document.nodes = {
      [mask.id]: mask,
      [content.id]: content,
      [group.id]: group,
    };
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [group.id],
    };

    const svg = documentToSvg(document);
    const body = svg.slice(svg.indexOf("</defs>") + 7);

    expect(body).toMatch(
      /<g(?=[^>]*filter="url\(#fx-\d+\)")(?=[^>]*style="mix-blend-mode:multiply")[^>]*>\s*<g[^>]*clip-path="url\(#clip-\d+\)"/,
    );
    expect(body).not.toMatch(/<g(?=[^>]*filter=)(?=[^>]*clip-path=)/);
  });

  it("sizes a user-space filter region from a huge drop shadow paint bound", () => {
    const node = createRectangle({ x: 100, y: 100 });
    node.width = 50;
    node.height = 50;
    node.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 60,
        dy: 0,
        blur: 80,
        color: "#000000",
        opacity: 1,
      },
    ];

    const svg = documentToSvg(documentWith(node));

    expect(svg).toContain(
      '<filter id="fx-',
    );
    expect(svg).toContain(
      'filterUnits="userSpaceOnUse" x="40" y="-20" width="290" height="290"',
    );
    expect(svg).not.toContain('x="-60%" y="-60%" width="220%" height="220%"');
  });

  it("keeps center-aligned stroke markup unchanged", () => {
    const node = createRectangle({ x: 10, y: 20 });
    node.stroke = { color: "#ff2d55", width: 12, align: "center" };

    const svg = documentToSvg(documentWith(node));

    expect(svg).toContain('stroke="#ff2d55" stroke-width="12"');
    expect(svg).not.toContain("data-openlogo-stroke-align");
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("<mask");
  });

  it("clips a doubled inside stroke to rounded rectangle geometry", () => {
    const node = createRectangle({ x: 10, y: 20 });
    node.width = 120;
    node.height = 80;
    node.cornerRadius = 18;
    node.stroke = { color: "#ff2d55", width: 12, align: "inside" };

    const svg = documentToSvg(documentWith(node));

    expect(svg).toContain("<clipPath");
    expect(svg).toContain('rx="18"');
    expect(svg).toContain('stroke-width="24"');
    expect(svg).toContain('data-openlogo-stroke-align="inside"');
  });

  it("masks a doubled outside ellipse stroke away from its fill", () => {
    const node = createEllipse({ x: 10, y: 20 });
    node.width = 120;
    node.height = 80;
    node.stroke = { color: "#ff2d55", width: 12, align: "outside" };

    const svg = documentToSvg(documentWith(node));

    expect(svg).toContain("<mask");
    expect(svg).toContain('fill="white"');
    expect(svg).toContain('fill="black"');
    expect(svg).toContain('stroke-width="24"');
    expect(svg).toContain('data-openlogo-stroke-align="outside"');
  });

  it.each(["inside", "outside"] as const)(
    "uses text glyph geometry for %s stroke alignment",
    (align) => {
      const text = createText({ x: 20, y: 40, content: "OpenLogo" });
      text.stroke = { color: "#ff2d55", width: 12, align };

      const svg = documentToSvg(documentWith(text));

      expect(svg).toContain(align === "inside" ? "<clipPath" : "<mask");
      expect(svg).toContain('stroke-width="24"');
      expect(svg).toContain(`data-openlogo-stroke-align="${align}"`);
      expect(svg.match(/<text /g)?.length).toBeGreaterThan(1);
    },
  );

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

  it.each([
    ["left", 'text-anchor="start"', 'startOffset="10"'],
    ["center", 'text-anchor="middle"', 'startOffset="105"'],
    ["right", 'text-anchor="end"', 'startOffset="200"'],
  ] as const)("exports %s path-text alignment numerically", (align, anchor, offset) => {
    const path = createPath({ x: 0, y: 0 });
    path.geometry = {
      subpaths: [
        { closed: false, points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
      ],
    };
    path.d = "M 0 0 L 200 0";
    path.intrinsicWidth = 200;
    path.intrinsicHeight = 1;
    path.width = 200;
    path.height = 1;
    const text = createText({ x: 0, y: 0, content: "Open\nLogo" });
    text.align = align;
    text.onPath = { pathId: path.id, startOffset: 10, flip: false };
    const document = createInitialDocument();
    document.nodes = { [path.id]: path, [text.id]: text };
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [path.id, text.id],
    };

    const svg = documentToSvg(document);

    expect(svg).toContain(anchor);
    expect(svg).toContain(offset);
    expect(svg).toContain(">Open Logo</textPath>");
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
