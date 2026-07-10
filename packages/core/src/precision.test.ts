import { describe, expect, it } from "vitest";
import {
  alignUnitOffsets,
  distributeEvenGapOffsets,
  distributeSpacingOffsets,
  pixelSnapPatch,
} from "./precision";

describe("pixelSnapPatch", () => {
  it("rounds position and dimensions to whole pixels", () => {
    expect(
      pixelSnapPatch({ x: 10.4, y: 19.6, width: 99.5, height: 40.2 }),
    ).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("only touches fields present in the patch", () => {
    const snapped = pixelSnapPatch({ x: 3.7, rotation: 12.34 });
    expect(snapped).toEqual({ x: 4, rotation: 12.34 });
    expect("y" in snapped).toBe(false);
    expect("width" in snapped).toBe(false);
  });

  it("never rounds a dimension below 1", () => {
    expect(pixelSnapPatch({ width: 0.3, height: 0.49 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("leaves non-geometric fields untouched", () => {
    const fill = { type: "solid", color: "#ff0000" } as const;
    expect(pixelSnapPatch({ fill, opacity: 0.55 })).toEqual({
      fill,
      opacity: 0.55,
    });
  });

  it("is idempotent (snapping a snapped patch is the identity)", () => {
    const once = pixelSnapPatch({ x: 1.5, y: -2.5, width: 7.7, height: 3.1 });
    expect(pixelSnapPatch(once)).toEqual(once);
  });
});

const unit = (id: string, x: number, y: number, w = 20, h = 20) => ({
  id,
  bounds: { x, y, width: w, height: h },
});

describe("alignUnitOffsets", () => {
  it("aligns to a supplied artboard reference", () => {
    expect(
      alignUnitOffsets(
        [unit("a", 20, 30, 40, 20)],
        "centerX",
        { x: 0, y: 0, width: 200, height: 100 },
      ),
    ).toEqual([{ id: "a", dx: 60, dy: 0 }]);
  });

  it("aligns a selection to its union and preserves a key object", () => {
    const units = [
      unit("a", 10, 20, 20, 10),
      unit("b", 70, 60, 30, 30),
    ];
    expect(alignUnitOffsets(units, "top")).toEqual([
      { id: "b", dx: 0, dy: -40 },
    ]);
    expect(alignUnitOffsets(units, "right", undefined, "a")).toEqual([
      { id: "b", dx: -70, dy: 0 },
    ]);
  });

  it("omits no-ops and fails closed for invalid bounds", () => {
    expect(
      alignUnitOffsets(
        [unit("a", 0, 0), unit("b", 20, 0)],
        "top",
      ),
    ).toEqual([]);
    expect(
      alignUnitOffsets(
        [unit("a", Number.NaN, 0)],
        "left",
      ),
    ).toEqual([]);
  });
});

describe("distributeEvenGapOffsets", () => {
  it("distributes mixed-width units while fixing the endpoints", () => {
    expect(
      distributeEvenGapOffsets(
        [
          unit("a", 0, 0, 10),
          unit("b", 30, 0, 20),
          unit("c", 100, 0, 10),
        ],
        "horizontal",
      ),
    ).toEqual([{ id: "b", dx: 15, dy: 0 }]);
  });

  it("supports vertical distribution and rejects insufficient units", () => {
    expect(
      distributeEvenGapOffsets(
        [
          unit("a", 0, 0, 10, 10),
          unit("b", 0, 90, 10, 20),
          unit("c", 0, 200, 10, 10),
        ],
        "vertical",
      ),
    ).toEqual([{ id: "b", dx: 0, dy: 5 }]);
    expect(
      distributeEvenGapOffsets(
        [unit("a", 0, 0), unit("b", 40, 0)],
        "horizontal",
      ),
    ).toEqual([]);
  });
});

describe("distributeSpacingOffsets", () => {
  it("produces exact gaps along the horizontal axis", () => {
    const offsets = distributeSpacingOffsets(
      [unit("a", 0, 0), unit("b", 33, 0), unit("c", 91, 0)],
      "horizontal",
      20,
    );
    // First unit anchors; b lands at 0+20+20=40, c at 40+20+20=80.
    expect(offsets).toEqual([
      { id: "b", dx: 7, dy: 0 },
      { id: "c", dx: -11, dy: 0 },
    ]);
  });

  it("works on the vertical axis with mixed heights", () => {
    const offsets = distributeSpacingOffsets(
      [unit("a", 0, 0, 20, 10), unit("b", 0, 100, 20, 30), unit("c", 0, 50)],
      "vertical",
      5,
    );
    // Sorted a(0,h10) c(50,h20) b(100,h30): c → 15, b → 40.
    expect(offsets).toEqual([
      { id: "c", dx: 0, dy: -35 },
      { id: "b", dx: 0, dy: -60 },
    ]);
  });

  it("keeps the anchor unit fixed and chains both directions", () => {
    const offsets = distributeSpacingOffsets(
      [unit("a", 0, 0), unit("b", 50, 0), unit("c", 100, 0)],
      "horizontal",
      10,
      "b",
    );
    // b stays at 50; a ends at 50-10-20=20, c at 50+20+10=80.
    expect(offsets).toEqual([
      { id: "a", dx: 20, dy: 0 },
      { id: "c", dx: -20, dy: 0 },
    ]);
    expect(offsets.some((o) => o.id === "b")).toBe(false);
  });

  it("falls back to the first unit when the anchor is not in the set", () => {
    const offsets = distributeSpacingOffsets(
      [unit("a", 0, 0), unit("b", 21, 0)],
      "horizontal",
      1,
      "missing",
    );
    expect(offsets).toEqual([]); // b already sits exactly at 0+20+1
  });

  it("returns nothing for fewer than two units or non-finite spacing", () => {
    expect(distributeSpacingOffsets([unit("a", 0, 0)], "horizontal", 10)).toEqual(
      [],
    );
    expect(
      distributeSpacingOffsets(
        [unit("a", 0, 0), unit("b", 50, 0)],
        "horizontal",
        Number.NaN,
      ),
    ).toEqual([]);
  });

  it("supports negative spacing (overlap) exactly", () => {
    const offsets = distributeSpacingOffsets(
      [unit("a", 0, 0), unit("b", 100, 0)],
      "horizontal",
      -5,
    );
    expect(offsets).toEqual([{ id: "b", dx: -85, dy: 0 }]);
  });
});
