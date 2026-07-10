import { describe, expect, it } from "vitest";
import { nextGradientStopOffset, paintPreviewBackground } from "./PaintEditor";

describe("nextGradientStopOffset", () => {
  it("adds the first keyboard stop midway between endpoint stops", () => {
    expect(
      nextGradientStopOffset([
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff" },
      ]),
    ).toBe(0.5);
  });

  it("uses the earliest largest interval as stops accumulate", () => {
    expect(
      nextGradientStopOffset([
        { offset: 0, color: "#000000" },
        { offset: 0.5, color: "#777777" },
        { offset: 1, color: "#ffffff" },
      ]),
    ).toBe(0.25);
  });
});

describe("paintPreviewBackground", () => {
  it("uses the authored linear-gradient angle and stops", () => {
    expect(
      paintPreviewBackground({
        type: "linear-gradient",
        angle: 0,
        stops: [
          { offset: 0, color: "#112233" },
          { offset: 1, color: "#abcdef", alpha: 0.5 },
        ],
      }),
    ).toBe("linear-gradient(90deg, #112233 0%, #abcdef80 100%)");
  });

  it("previews radial paint as a radial gradient", () => {
    expect(
      paintPreviewBackground({
        type: "radial-gradient",
        cx: 0.5,
        cy: 0.5,
        r: 0.5,
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#000000" },
        ],
      }),
    ).toBe("radial-gradient(circle, #ffffff 0%, #000000 100%)");
  });
});
