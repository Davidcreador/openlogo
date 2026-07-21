import { describe, expect, it } from "vitest";
import { fillIsEnabled, toggledFill } from "./Inspector";

describe("fill controls", () => {
  it("recognizes canonical and imported no-fill paints", () => {
    for (const color of ["#00000000", "#0000", "transparent", "none"]) {
      expect(fillIsEnabled({ type: "solid", color })).toBe(false);
    }
    expect(fillIsEnabled({ type: "solid", color: "#111827" })).toBe(true);
    expect(
      fillIsEnabled({
        type: "linear-gradient",
        angle: 0,
        stops: [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#ffffff" },
        ],
      }),
    ).toBe(true);
  });

  it("toggles between canonical no fill and the default solid fill", () => {
    expect(toggledFill({ type: "solid", color: "#ef4444" })).toEqual({
      type: "solid",
      color: "#00000000",
    });
    expect(toggledFill({ type: "solid", color: "#00000000" })).toEqual({
      type: "solid",
      color: "#111827",
    });
  });
});
