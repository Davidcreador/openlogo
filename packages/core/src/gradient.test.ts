import { describe, expect, it } from "vitest";
import {
  angleFromPoints,
  convertPaint,
  defaultLinearGradient,
  defaultRadialGradient,
  isGradient,
  linearGradientPoints,
  radialGradientGeometry,
  sampleStops,
  withStopAdded,
  withStopMoved,
  withStopPatched,
  withStopRemoved,
} from "./gradient";
import { applyCommand } from "./commands";
import { createInitialDocument } from "./factory";
import { parseDocument } from "./schema";
import type { LinearGradientPaint, RadialGradientPaint } from "./types";

const box = { x: 100, y: 50, width: 200, height: 100 };

const linear: LinearGradientPaint = {
  type: "linear-gradient",
  angle: 0,
  stops: [
    { offset: 0, color: "#000000" },
    { offset: 1, color: "#ffffff" },
  ],
};

const radial: RadialGradientPaint = {
  type: "radial-gradient",
  cx: 0.5,
  cy: 0.5,
  r: 0.5,
  stops: [
    { offset: 0, color: "#ff0000" },
    { offset: 1, color: "#0000ff", alpha: 0.5 },
  ],
};

describe("gradient geometry", () => {
  it("derives angle-only linear endpoints through the box centre", () => {
    const { start, end } = linearGradientPoints(linear, box);
    // angle 0 → left→right, half-length max(w,h)/2 = 100
    expect(start).toEqual({ x: 100, y: 100 });
    expect(end).toEqual({ x: 300, y: 100 });
  });

  it("prefers explicit normalized endpoints when present", () => {
    const paint: LinearGradientPaint = {
      ...linear,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
    };
    const { start, end } = linearGradientPoints(paint, box);
    expect(start).toEqual({ x: 100, y: 50 });
    expect(end).toEqual({ x: 300, y: 150 });
  });

  it("maps radial centre/radius through the box (elliptical on non-square)", () => {
    const geometry = radialGradientGeometry(radial, box);
    expect(geometry.center).toEqual({ x: 200, y: 100 });
    expect(geometry.rx).toBe(100);
    expect(geometry.ry).toBe(50);
    expect(geometry.focal).toBeNull();
  });

  it("exposes the focal point when set", () => {
    const geometry = radialGradientGeometry(
      { ...radial, fx: 0.25, fy: 0.75 },
      box,
    );
    expect(geometry.focal).toEqual({ x: 150, y: 125 });
  });

  it("angleFromPoints matches the direction of the line", () => {
    expect(angleFromPoints({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(angleFromPoints({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(90);
  });
});

describe("gradient stops", () => {
  it("samples interpolated colour and alpha between stops", () => {
    const mid = sampleStops(radial.stops, 0.5);
    expect(mid.color).toBe("#800080");
    expect(mid.alpha).toBeCloseTo(0.75);
  });

  it("adds a stop at the interpolated colour, sorted", () => {
    const { paint, index } = withStopAdded(linear, 0.5);
    expect(paint.stops).toHaveLength(3);
    expect(index).toBe(1);
    expect(paint.stops[1]!.offset).toBe(0.5);
    expect(paint.stops[1]!.color).toBe("#808080");
  });

  it("refuses to remove below two stops", () => {
    expect(withStopRemoved(linear, 0)).toBeNull();
    const three = withStopAdded(linear, 0.5).paint;
    expect(withStopRemoved(three, 1)!.stops).toHaveLength(2);
  });

  it("moves a stop and reports its re-sorted index", () => {
    const three = withStopAdded(linear, 0.5).paint;
    const moved = withStopMoved(three, 1, 0)!;
    // Ties sort stably; the moved stop lands at or before its old slot.
    expect(moved.paint.stops.map((s) => s.offset)).toEqual([0, 0, 1]);
    expect(moved.paint.stops[moved.index]!.color).toBe("#808080");
  });

  it("patches a stop's colour/alpha and drops alpha at 1", () => {
    const next = withStopPatched(radial, 1, { alpha: 1 })!;
    expect(next.stops[1]!.alpha).toBeUndefined();
    const tinted = withStopPatched(radial, 0, { color: "#00ff00", alpha: 0.25 })!;
    expect(tinted.stops[0]).toEqual({ offset: 0, color: "#00ff00", alpha: 0.25 });
  });

  it("converts between paint types preserving stops", () => {
    const toRadial = convertPaint(linear, "radial-gradient");
    expect(toRadial.type).toBe("radial-gradient");
    expect((toRadial as RadialGradientPaint).stops).toEqual(linear.stops);
    const toSolid = convertPaint(radial, "solid");
    expect(toSolid).toEqual({ type: "solid", color: "#ff0000" });
    const fromSolid = convertPaint({ type: "solid", color: "#123456" }, "linear-gradient");
    expect((fromSolid as LinearGradientPaint).stops[0]!.color).toBe("#123456");
  });

  it("seeds sensible defaults", () => {
    expect(isGradient(defaultLinearGradient("#111111"))).toBe(true);
    const r = defaultRadialGradient("#111111");
    expect(r.cx).toBe(0.5);
    expect(r.stops[0]!.color).toBe("#111111");
  });
});

describe("gradient document round-trip", () => {
  it("parses radial fills, stop alpha and stroke gradients; legacy 2-stop linear untouched", () => {
    const document = createInitialDocument();
    const [id] = Object.keys(document.nodes);
    const next = applyCommand(document, {
      type: "update-nodes",
      updates: [
        {
          nodeId: id!,
          patch: {
            fill: radial,
            stroke: { color: "#111111", width: 2, align: "center", paint: linear },
          },
        },
      ],
    }).document;

    const parsed = parseDocument(JSON.parse(JSON.stringify(next)));
    const node = parsed.nodes[id!]!;
    expect(node.fill).toEqual(radial);
    expect(node.stroke?.paint).toEqual(linear);
  });

  it("update-nodes fill patches invert exactly (radial → linear → back)", () => {
    const document = createInitialDocument();
    const [id] = Object.keys(document.nodes);
    const first = applyCommand(document, {
      type: "update-nodes",
      updates: [{ nodeId: id!, patch: { fill: radial } }],
    });
    const second = applyCommand(first.document, {
      type: "update-nodes",
      updates: [{ nodeId: id!, patch: { fill: linear } }],
    });
    const undone = applyCommand(second.document, second.inverse).document;
    expect(undone.nodes[id!]!.fill).toEqual(radial);
    const original = applyCommand(undone, first.inverse).document;
    expect(original.nodes[id!]!.fill).toEqual(document.nodes[id!]!.fill);
  });
});
