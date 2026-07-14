import { createRectangle } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  gradientHandlePoints,
  gradientTargetPaint,
  gradientTargetPatch,
} from "./gradient-annotator";

describe("gradient edit targets", () => {
  it("reads and updates stroke gradient geometry without touching fill", () => {
    const node = createRectangle({ x: 20, y: 30 });
    node.width = 200;
    node.height = 100;
    node.fill = { type: "solid", color: "#abcdef" };
    node.stroke = {
      color: "#ff0000",
      width: 8,
      align: "center",
      paint: {
        type: "linear-gradient",
        angle: 0,
        start: { x: 0.1, y: 0.2 },
        end: { x: 0.9, y: 0.8 },
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#0000ff" },
        ],
      },
    };

    const paint = gradientTargetPaint(node, "stroke");
    expect(paint).toBe(node.stroke.paint);
    expect(gradientHandlePoints(node, paint!)).toEqual([
      { part: "start", x: 40, y: 50 },
      { part: "end", x: 200, y: 110 },
    ]);

    const moved = {
      ...paint!,
      start: { x: 0.25, y: 0.5 },
    };
    const patch = gradientTargetPatch(node, "stroke", moved);
    expect(patch).not.toHaveProperty("fill");
    expect(patch.stroke?.paint).toEqual(moved);
    expect(node.fill).toEqual({ type: "solid", color: "#abcdef" });
  });
});
