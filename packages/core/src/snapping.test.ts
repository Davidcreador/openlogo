import { describe, expect, it } from "vitest";
import { computeSnap } from "./snapping";

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
