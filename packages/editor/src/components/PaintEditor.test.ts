import { describe, expect, it } from "vitest";
import { nextGradientStopOffset } from "./PaintEditor";

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
