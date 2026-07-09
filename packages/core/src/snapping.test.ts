import { describe, expect, it } from "vitest";
import {
  computeSnap,
  computeSpacingSnap,
  measureDistances,
  snapValue,
} from "./snapping";

const target = { x: 100, y: 100, width: 50, height: 50 };

describe("computeSnap", () => {
  it("snaps left edge to target left edge within threshold", () => {
    // Left edges 102→100 (delta -2); center pair would need +3 — edge wins.
    const moving = { x: 102, y: 300, width: 40, height: 40 };
    const result = computeSnap(moving, [target], 5);

    expect(result.dx).toBe(-2);
    expect(result.guides.some((g) => g.axis === "x" && g.position === 100)).toBe(
      true,
    );
  });

  it("snaps centers together", () => {
    // Moving center x = 127 → target center x = 125.
    const moving = { x: 107, y: 300, width: 40, height: 40 };
    const result = computeSnap(moving, [target], 5);

    expect(result.dx).toBe(-2);
  });

  it("does not snap beyond threshold", () => {
    const moving = { x: 160, y: 300, width: 40, height: 40 };
    const result = computeSnap(moving, [target], 3);

    expect(result.dx).toBe(0);
    expect(result.dy).toBe(0);
    expect(result.guides).toHaveLength(0);
  });

  it("snaps both axes independently", () => {
    const moving = { x: 148, y: 152, width: 50, height: 50 };
    const result = computeSnap(moving, [target], 5);

    // right edge 198 → 200? No: left 148→150 (target right), y 152→150.
    expect(result.dx).toBe(2);
    expect(result.dy).toBe(-2);
  });

  it("prefers the closest candidate", () => {
    const near = { x: 200, y: 0, width: 10, height: 10 };
    const moving = { x: 201, y: 300, width: 10, height: 10 };
    const result = computeSnap(moving, [target, near], 6);

    expect(result.dx).toBe(-1);
  });

  it("snapValue snaps a single edge and reports the guide", () => {
    const result = snapValue(
      148,
      { start: 300, end: 340 },
      [target],
      "x",
      5,
    );

    expect(result.delta).toBe(2); // 148 → 150 (target right edge)
    expect(result.guide).toMatchObject({ axis: "x", position: 150 });
    expect(result.guide!.start).toBe(100);
    expect(result.guide!.end).toBe(340);
  });

  it("snapValue returns zero delta outside threshold", () => {
    const result = snapValue(
      170,
      { start: 0, end: 10 },
      [target],
      "x",
      5,
    );

    expect(result.delta).toBe(0);
    expect(result.guide).toBeNull();
  });

  it("guide extent spans both boxes", () => {
    const moving = { x: 100, y: 300, width: 50, height: 40 };
    const result = computeSnap(moving, [target], 5);

    const guide = result.guides.find(
      (g) => g.axis === "x" && g.position === 100,
    );
    expect(guide).toBeDefined();
    expect(guide!.start).toBe(100);
    expect(guide!.end).toBe(340);
  });
});

describe("computeSpacingSnap", () => {
  // A row on y=100..180: left box ends at 220, right box starts at 520.
  const left = { x: 100, y: 100, width: 120, height: 80 };
  const right = { x: 520, y: 100, width: 120, height: 80 };

  it("centres the moving box between two neighbours", () => {
    // Span 220..520 is 300 wide; a 120-wide box centres at x=310 (gap 90).
    const moving = { x: 313, y: 110, width: 120, height: 80 };
    const result = computeSpacingSnap(moving, [left, right], "x", 6);

    expect(result).not.toBeNull();
    expect(result!.delta).toBe(-3);
    expect(result!.gaps).toHaveLength(2);
    expect(result!.gaps[0]).toMatchObject({ from: 220, to: 310, distance: 90 });
    expect(result!.gaps[1]).toMatchObject({ from: 430, to: 520, distance: 90 });
  });

  it("reports gap segments at the overlap midline", () => {
    const moving = { x: 313, y: 110, width: 120, height: 80 };
    const result = computeSpacingSnap(moving, [left, right], "x", 6);

    // Overlap of y:100..180 and y:110..190 is 110..180 → midline 145.
    expect(result!.gaps[0]!.cross).toBe(145);
  });

  it("extends a row to the right by repeating the previous gap", () => {
    // Gap left→right is 300; placing after `right` repeats it at x=940.
    const moving = { x: 944, y: 120, width: 100, height: 40 };
    const result = computeSpacingSnap(moving, [left, right], "x", 6);

    expect(result).not.toBeNull();
    expect(result!.delta).toBe(-4);
    expect(result!.gaps[0]).toMatchObject({ from: 220, to: 520, distance: 300 });
    expect(result!.gaps[1]).toMatchObject({ from: 640, to: 940, distance: 300 });
  });

  it("extends a row to the left by repeating the next gap", () => {
    // Placing before `left` with the same 300 gap: x = 100 - 300 - 100.
    const moving = { x: -303, y: 120, width: 100, height: 40 };
    const result = computeSpacingSnap(moving, [left, right], "x", 6);

    expect(result).not.toBeNull();
    expect(result!.delta).toBe(3);
    expect(result!.gaps[0]).toMatchObject({ from: -200, to: 100, distance: 300 });
    expect(result!.gaps[1]).toMatchObject({ from: 220, to: 520, distance: 300 });
  });

  it("returns null outside the threshold", () => {
    const moving = { x: 330, y: 110, width: 120, height: 80 };
    expect(computeSpacingSnap(moving, [left, right], "x", 6)).toBeNull();
  });

  it("ignores neighbours in a different cross band", () => {
    const other = { x: 520, y: 400, width: 120, height: 80 };
    const moving = { x: 313, y: 110, width: 120, height: 80 };
    expect(computeSpacingSnap(moving, [left, other], "x", 6)).toBeNull();
  });

  it("ignores zero-thickness ruler-guide lines and containers", () => {
    const guide = { x: 400, y: 0, width: 0, height: 1000 };
    const artboard = { x: 0, y: 0, width: 1024, height: 1024 };
    const moving = { x: 313, y: 110, width: 120, height: 80 };
    const result = computeSpacingSnap(
      moving,
      [artboard, guide, left, right],
      "x",
      6,
    );

    // Same answer as with just the two real neighbours.
    expect(result!.delta).toBe(-3);
  });

  it("skips centring when the moving box does not fit the span", () => {
    // Span 50..60 is 10 wide; a 100-wide box would need a negative gap.
    // Without the fit guard the candidate (x=5, delta 3) is in threshold.
    const a = { x: 0, y: 100, width: 50, height: 50 };
    const b = { x: 60, y: 100, width: 50, height: 50 };
    const moving = { x: 2, y: 100, width: 100, height: 50 };
    expect(computeSpacingSnap(moving, [a, b], "x", 50)).toBeNull();
  });

  it("works on the y axis", () => {
    const top = { x: 100, y: 100, width: 80, height: 60 };
    const bottom = { x: 100, y: 400, width: 80, height: 60 };
    // Span 160..400 is 240; a 60-tall box centres at y=250 (gap 90).
    const moving = { x: 110, y: 254, width: 60, height: 60 };
    const result = computeSpacingSnap(moving, [top, bottom], "y", 6);

    expect(result).not.toBeNull();
    expect(result!.delta).toBe(-4);
    expect(result!.gaps.map((g) => g.distance)).toEqual([90, 90]);
  });

  it("prefers the candidate with the smaller correction", () => {
    // Between-position 310 (delta -3) beats row-extension x=940 (far away),
    // and among overlapping candidates the smaller |delta| must win.
    const third = { x: 640, y: 100, width: 120, height: 80 };
    const moving = { x: 313, y: 110, width: 120, height: 80 };
    const result = computeSpacingSnap(moving, [left, right, third], "x", 6);

    expect(result!.delta).toBe(-3);
  });
});

describe("measureDistances", () => {
  const left = { x: 100, y: 100, width: 120, height: 80 };
  const right = { x: 520, y: 100, width: 120, height: 80 };

  it("measures the gap to the nearest neighbour on each side", () => {
    const moving = { x: 310, y: 110, width: 120, height: 80 };
    const result = measureDistances(moving, [left, right]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      axis: "x",
      from: 220,
      to: 310,
      distance: 90,
    });
    expect(result[1]).toMatchObject({
      axis: "x",
      from: 430,
      to: 520,
      distance: 90,
    });
  });

  it("keeps only the nearest neighbour per side", () => {
    const far = { x: 0, y: 100, width: 40, height: 80 };
    const moving = { x: 310, y: 110, width: 120, height: 80 };
    const result = measureDistances(moving, [far, left, right]);

    expect(result.filter((s) => s.axis === "x")).toHaveLength(2);
    expect(result[0]!.from).toBe(220); // left's right edge, not far's
  });

  it("measures both axes independently", () => {
    const above = { x: 300, y: 0, width: 140, height: 60 };
    const moving = { x: 310, y: 110, width: 120, height: 80 };
    const result = measureDistances(moving, [left, above]);

    const xSeg = result.find((s) => s.axis === "x");
    const ySeg = result.find((s) => s.axis === "y");
    expect(xSeg).toMatchObject({ from: 220, to: 310, distance: 90 });
    expect(ySeg).toMatchObject({ from: 60, to: 110, distance: 50 });
  });

  it("ignores containers, guide lines, and overlapping boxes", () => {
    const artboard = { x: 0, y: 0, width: 1024, height: 1024 };
    const guide = { x: 250, y: 0, width: 0, height: 1024 };
    const overlapping = { x: 280, y: 110, width: 120, height: 80 };
    const moving = { x: 310, y: 110, width: 120, height: 80 };

    expect(measureDistances(moving, [artboard, guide, overlapping])).toEqual(
      [],
    );
  });

  it("puts the segment on the midline of the cross overlap", () => {
    const moving = { x: 310, y: 110, width: 120, height: 80 };
    const result = measureDistances(moving, [left]);

    // Overlap of y:100..180 and y:110..190 is 110..180 → midline 145.
    expect(result[0]!.cross).toBe(145);
  });
});
