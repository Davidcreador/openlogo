import {
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
  getActiveArtboard,
  paintBounds,
  setTextLayoutBounds,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import { nodeToPreviewSvg, nodesToSvg } from "./export";

function viewBox(svg: string): number[] {
  return svg
    .match(/viewBox="([^"]+)"/)![1]!
    .split(/\s+/)
    .map(Number);
}

describe("paint-aware export bounds", () => {
  it("keeps scaled path strokes inside selection exports and previews", () => {
    const document = createInitialDocument();
    const path = createPath({ x: 10, y: 20 });
    path.width = 192;
    path.height = 48;
    path.stroke = { color: "#111827", width: 10, align: "center" };
    document.nodes = { [path.id]: path };
    getActiveArtboard(document).nodeIds = [path.id];

    const bounds = paintBounds(document, path.id)!;
    expect(viewBox(nodesToSvg(document, [path.id])!)).toEqual([
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    ]);

    const preview = viewBox(nodeToPreviewSvg(document, path.id)!);
    expect(preview[0]).toBeLessThan(bounds.x);
    expect(preview[1]).toBeLessThan(bounds.y);
    expect(preview[0]! + preview[2]!).toBeGreaterThan(
      bounds.x + bounds.width,
    );
    expect(preview[1]! + preview[3]!).toBeGreaterThan(
      bounds.y + bounds.height,
    );
  });

  it("includes directional effect bleed in a selection export", () => {
    const document = createInitialDocument();
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
    document.nodes = { [rectangle.id]: rectangle };
    getActiveArtboard(document).nodeIds = [rectangle.id];

    expect(viewBox(nodesToSvg(document, [rectangle.id])!)).toEqual([
      10, 4, 126, 66,
    ]);
  });

  it("uses rendered paragraph extents for a text selection export", () => {
    const document = createInitialDocument();
    const text = createText({ x: 10, y: 20, content: "Overflow" });
    text.width = 40;
    text.height = 8;
    document.nodes = { [text.id]: text };
    getActiveArtboard(document).nodeIds = [text.id];
    setTextLayoutBounds(document, text.id, {
      x: 10,
      y: 20,
      width: 100,
      height: 44,
    });

    expect(viewBox(nodesToSvg(document, [text.id])!)).toEqual([
      10, 20, 100, 44,
    ]);
  });
});
