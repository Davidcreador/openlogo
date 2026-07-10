import { describe, expect, it } from "vitest";
import {
  createGroup,
  createInitialDocument,
  createPath,
  createRectangle,
} from "./factory";
import { getActiveArtboard, paintBounds } from "./queries";

function documentWith(...nodes: ReturnType<typeof createRectangle>[]) {
  const document = createInitialDocument();
  const artboard = getActiveArtboard(document);
  document.nodes = Object.fromEntries(nodes.map((node) => [node.id, node]));
  artboard.nodeIds = nodes.map((node) => node.id);
  return document;
}

describe("paintBounds", () => {
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
});
