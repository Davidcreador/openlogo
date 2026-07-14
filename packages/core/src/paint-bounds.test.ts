import { describe, expect, it } from "vitest";
import {
  createGroup,
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
} from "./factory";
import {
  getActiveArtboard,
  nodeBounds,
  paintBounds,
  selectionFrame,
  setTextLayoutBounds,
  visualBounds,
} from "./queries";

function documentWith(...nodes: ReturnType<typeof createRectangle>[]) {
  const document = createInitialDocument();
  const artboard = getActiveArtboard(document);
  document.nodes = Object.fromEntries(nodes.map((node) => [node.id, node]));
  artboard.nodeIds = nodes.map((node) => node.id);
  return document;
}

describe("paintBounds", () => {
  it.each([
    ["inside", { x: 10, y: 20, width: 100, height: 50 }],
    ["center", { x: 5, y: 15, width: 110, height: 60 }],
    ["outside", { x: 0, y: 10, width: 120, height: 70 }],
  ] as const)("uses %s stroke alignment for shape bounds", (align, expected) => {
    const rectangle = createRectangle({ x: 10, y: 20 });
    rectangle.width = 100;
    rectangle.height = 50;
    rectangle.stroke = { color: "#111827", width: 10, align };
    const document = documentWith(rectangle);

    expect(paintBounds(document, rectangle.id)).toEqual(expected);
  });

  it.each([
    ["inside", { x: 10, y: 20, width: 192, height: 48 }],
    ["center", { x: 0, y: 10, width: 212, height: 68 }],
    ["outside", { x: -10, y: 0, width: 232, height: 88 }],
  ] as const)("uses %s stroke alignment for scaled path bounds", (align, expected) => {
    const path = createPath({ x: 10, y: 20 });
    path.width = 192;
    path.height = 48;
    path.stroke = { color: "#111827", width: 10, align };
    const document = createInitialDocument();
    document.nodes = { [path.id]: path };
    getActiveArtboard(document).nodeIds = [path.id];

    expect(paintBounds(document, path.id)).toEqual(expected);
  });

  it("expands path strokes by the largest intrinsic-to-box scale", () => {
    const path = createPath({ x: 10, y: 20 });
    path.width = 192;
    path.height = 48;
    path.stroke = { color: "#111827", width: 10, align: "center" };
    const document = createInitialDocument();
    document.nodes = { [path.id]: path };
    getActiveArtboard(document).nodeIds = [path.id];

    expect(paintBounds(document, path.id)).toEqual({
      x: 0,
      y: 10,
      width: 212,
      height: 68,
    });
  });

  it("unions a directional three-sigma drop shadow with its source", () => {
    const rectangle = createRectangle({ x: 10, y: 20 });
    rectangle.width = 100;
    rectangle.height = 50;
    rectangle.effects = [
      {
        type: "drop-shadow",
        enabled: true,
        dx: 20,
        dy: -10,
        blur: 4,
        color: "#000000",
        opacity: 0.5,
      },
    ];
    const document = documentWith(rectangle);

    expect(paintBounds(document, rectangle.id)).toEqual({
      x: 10,
      y: 4,
      width: 126,
      height: 66,
    });
  });

  it("caps a clipped child's effect bleed at mask geometry", () => {
    const content = createRectangle({ x: 0, y: 0 });
    content.width = 200;
    content.height = 100;
    content.effects = [
      {
        type: "glow",
        enabled: true,
        blur: 20,
        color: "#2563eb",
        opacity: 0.8,
      },
    ];
    const mask = createRectangle({ x: 50, y: 25 });
    mask.width = 50;
    mask.height = 50;
    const group = createGroup([content.id, mask.id]);
    group.clippingMaskId = mask.id;
    const document = documentWith(content, mask);
    document.nodes[group.id] = group;
    getActiveArtboard(document).nodeIds = [group.id];

    expect(paintBounds(document, group.id)).toEqual({
      x: 50,
      y: 25,
      width: 50,
      height: 50,
    });
  });

  it("applies group effects after clipping so they can paint outside the mask", () => {
    const content = createRectangle({ x: 0, y: 0 });
    content.width = 200;
    content.height = 100;
    const mask = createRectangle({ x: 50, y: 25 });
    mask.width = 50;
    mask.height = 50;
    const group = createGroup([content.id, mask.id]);
    group.clippingMaskId = mask.id;
    group.effects = [
      {
        type: "outline",
        enabled: true,
        width: 12,
        color: "#111827",
        opacity: 1,
      },
    ];
    const document = documentWith(content, mask);
    document.nodes[group.id] = group;
    getActiveArtboard(document).nodeIds = [group.id];

    expect(paintBounds(document, group.id)).toEqual({
      x: 38,
      y: 13,
      width: 74,
      height: 74,
    });
  });

  it("uses rendered paragraph extents for text interaction and paint bounds", () => {
    const text = createText({ x: 10, y: 20, content: "Overflow" });
    text.width = 60;
    text.height = 10;
    text.stroke = { color: "#111827", width: 4, align: "center" };
    const document = createInitialDocument();
    document.nodes = { [text.id]: text };
    getActiveArtboard(document).nodeIds = [text.id];
    const rendered = { x: 10, y: 20, width: 92, height: 48 };

    setTextLayoutBounds(document, text.id, rendered);

    expect(nodeBounds(text)).toEqual(rendered);
    expect(selectionFrame(document, [text.id])).toEqual({
      bounds: rendered,
      rotation: 0,
    });
    expect(paintBounds(document, text.id)).toEqual({
      x: 8,
      y: 18,
      width: 96,
      height: 52,
    });
  });

  it("excludes hidden children from group visual and paint bounds", () => {
    const visible = createRectangle({ x: 10, y: 20 });
    visible.width = 40;
    visible.height = 30;
    const hidden = createRectangle({ x: 1000, y: 2000 });
    hidden.visible = false;
    const group = createGroup([visible.id, hidden.id]);
    const document = documentWith(visible, hidden);
    document.nodes[group.id] = group;
    getActiveArtboard(document).nodeIds = [group.id];

    const expected = { x: 10, y: 20, width: 40, height: 30 };
    expect(visualBounds(document, group.id)).toEqual(expected);
    expect(paintBounds(document, group.id)).toEqual(expected);
    expect(selectionFrame(document, [group.id])).toEqual({
      bounds: expected,
      rotation: 0,
    });
    expect(paintBounds(document, hidden.id)).toEqual({
      x: hidden.x,
      y: hidden.y,
      width: hidden.width,
      height: hidden.height,
    });
  });

  it("keeps hidden clipping-mask geometry in clipped group bounds", () => {
    const content = createRectangle({ x: 0, y: 0 });
    content.width = 200;
    content.height = 100;
    const mask = createRectangle({ x: 50, y: 25 });
    mask.width = 50;
    mask.height = 50;
    mask.visible = false;
    const group = createGroup([content.id, mask.id]);
    group.clippingMaskId = mask.id;
    const document = documentWith(content, mask);
    document.nodes[group.id] = group;
    getActiveArtboard(document).nodeIds = [group.id];

    expect(visualBounds(document, group.id)).toEqual({
      x: 50,
      y: 25,
      width: 50,
      height: 50,
    });
    expect(paintBounds(document, group.id)).toEqual({
      x: 50,
      y: 25,
      width: 50,
      height: 50,
    });
  });
});
