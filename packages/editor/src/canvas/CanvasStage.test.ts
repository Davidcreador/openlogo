import { describe, expect, it } from "vitest";
import { penPathAppearance } from "./CanvasStage";

describe("penPathAppearance", () => {
  it("uses stroke-only appearance for an open path", () => {
    expect(penPathAppearance(false)).toEqual({
      fill: { type: "solid", color: "#00000000" },
      stroke: { color: "#111827", width: 2, align: "center" },
    });
  });

  it("keeps the existing fill-only appearance for a closed path", () => {
    expect(penPathAppearance(true)).toEqual({
      fill: { type: "solid", color: "#111827" },
    });
  });
});
