import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import {
  createEllipse,
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
} from "./factory";
import { getActiveArtboard, selectionFrame } from "./queries";
import {
  normalizeAngle,
  reflectLeafPatches,
  reflectPoint,
  rotateLeafPatches,
  scaleLeafPatches,
  translateLeafPatches,
} from "./transforms";
import type { LogoDocument, LogoNode } from "./types";

/** Fresh document with the given nodes inserted on the active board. */
function docWith(...nodes: LogoNode[]): LogoDocument {
  const initial = createInitialDocument();
  return applyCommand(initial, {
    type: "insert-nodes",
    artboardId: getActiveArtboard(initial).id,
    nodes,
  }).document;
}

describe("rotateLeafPatches", () => {
  it("orbits the leaf centre around the pivot and increments rotation", () => {
    const rect = { ...createRectangle({ x: 100, y: 100 }), width: 40, height: 20 };
    const document = docWith(rect);

    // Centre (120,110) rotated 90° around (0,0) → (-110,120).
    const [update] = rotateLeafPatches(document, [rect.id], 90, { x: 0, y: 0 });
    expect(update!.patch.x).toBeCloseTo(-110 - 20, 6);
    expect(update!.patch.y).toBeCloseTo(120 - 10, 6);
    expect(update!.patch.rotation).toBe(90);
  });

  it("rotation around the node's own centre leaves x/y unchanged", () => {
    const rect = { ...createRectangle({ x: 100, y: 100 }), rotation: 10 };
    const document = docWith(rect);
    const pivot = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };

    const [update] = rotateLeafPatches(document, [rect.id], 35, pivot);
    expect(update!.patch.x).toBeCloseTo(rect.x, 6);
    expect(update!.patch.y).toBeCloseTo(rect.y, 6);
    expect(update!.patch.rotation).toBe(45);
  });

  it("skips locked leaves and normalizes past 180°", () => {
    const a = { ...createRectangle({ x: 0, y: 0 }), locked: true };
    const b = { ...createEllipse({ x: 50, y: 50 }), rotation: 170 };
    const document = docWith(a, b);

    const updates = rotateLeafPatches(document, [a.id, b.id], 30, { x: 0, y: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.nodeId).toBe(b.id);
    expect(updates[0]!.patch.rotation).toBe(-160);
  });
});

describe("reflectLeafPatches", () => {
  it("reflectPoint mirrors across horizontal and vertical axes", () => {
    expect(reflectPoint({ x: 3, y: 4 }, { x: 0, y: 0 }, 0)).toEqual({
      x: 3,
      y: -4,
    });
    const vertical = reflectPoint({ x: 3, y: 4 }, { x: 0, y: 0 }, 90);
    expect(vertical.x).toBeCloseTo(-3, 6);
    expect(vertical.y).toBeCloseTo(4, 6);
  });

  it("mirrors the box across a vertical line and flips path content", () => {
    const path = createPath({ x: 100, y: 0 });
    path.geometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 96, y: 30 },
          ],
        },
      ],
    };
    const document = docWith(path);

    const [update] = reflectLeafPatches(document, [path.id], 90, {
      x: 50,
      y: 0,
    });
    // Centre x = 148 reflected across x=50 → -48; box x = -48 - 48 = -96.
    expect(update!.patch.x).toBeCloseTo(-96, 6);
    expect(update!.patch.y).toBeCloseTo(path.y, 6);
    expect(update!.patch.rotation).toBe(180);
    // Intrinsic content flipped vertically (y → 96 - y).
    const flipped = update!.patch.geometry!.subpaths[0]!.points;
    expect(flipped[0]).toMatchObject({ x: 0, y: 96 });
    expect(flipped[1]).toMatchObject({ x: 96, y: 66 });
    expect(update!.patch.d).toContain("M 0 96");
  });

  it("reflecting twice across the same line restores the box", () => {
    const rect = { ...createRectangle({ x: 30, y: 60 }), rotation: 25 };
    const document = docWith(rect);
    const pivot = { x: 200, y: 200 };

    const [first] = reflectLeafPatches(document, [rect.id], 30, pivot);
    const once = applyCommand(document, {
      type: "update-nodes",
      updates: [{ nodeId: rect.id, patch: first!.patch }],
    }).document;
    const [second] = reflectLeafPatches(once, [rect.id], 30, pivot);

    expect(second!.patch.x).toBeCloseTo(rect.x, 6);
    expect(second!.patch.y).toBeCloseTo(rect.y, 6);
    expect(second!.patch.rotation).toBeCloseTo(rect.rotation, 6);
  });

  it("keeps text upright (no content mirror) on a vertical-line reflect", () => {
    const text = createText({ x: 100, y: 100 });
    const document = docWith(text);
    const [update] = reflectLeafPatches(document, [text.id], 90, {
      x: 0,
      y: 0,
    });
    expect(update!.patch.rotation).toBe(0); // not 180 — text stays readable
  });
});

describe("scaleLeafPatches", () => {
  it("scales the box about the pivot and text font size with sy", () => {
    const text = createText({ x: 100, y: 100 });
    const document = docWith(text);

    const [update] = scaleLeafPatches(document, [text.id], 2, 1.5, {
      x: 100,
      y: 100,
    });
    expect(update!.patch.x).toBe(100);
    expect(update!.patch.y).toBe(100);
    expect(update!.patch.width).toBe(text.width * 2);
    expect(update!.patch.height).toBe(text.height * 1.5);
    expect(update!.patch.fontSize).toBe(text.fontSize * 1.5);
  });

  it("rejects non-positive factors", () => {
    const rect = createRectangle({ x: 0, y: 0 });
    const document = docWith(rect);
    expect(scaleLeafPatches(document, [rect.id], -1, 1, { x: 0, y: 0 })).toEqual(
      [],
    );
  });
});

describe("translateLeafPatches", () => {
  it("moves every unlocked leaf by the delta", () => {
    const a = createRectangle({ x: 10, y: 20 });
    const b = { ...createEllipse({ x: 50, y: 50 }), locked: true };
    const document = docWith(a, b);

    const updates = translateLeafPatches(document, [a.id, b.id], 5, -7);
    expect(updates).toEqual([{ nodeId: a.id, patch: { x: 15, y: 13 } }]);
  });
});

describe("selectionFrame", () => {
  it("tilts with a single rotated leaf", () => {
    const rect = { ...createRectangle({ x: 10, y: 10 }), rotation: 30 };
    const document = docWith(rect);
    const frame = selectionFrame(document, [rect.id]);
    expect(frame).toEqual({
      bounds: { x: 10, y: 10, width: rect.width, height: rect.height },
      rotation: 30,
    });
  });

  it("multi-selection unions rotated AABBs, frame stays axis-aligned", () => {
    const a = {
      ...createRectangle({ x: 0, y: 0 }),
      width: 100,
      height: 20,
      rotation: 90,
    };
    const b = { ...createRectangle({ x: 200, y: 0 }), rotation: 0 };
    const document = docWith(a, b);
    const frame = selectionFrame(document, [a.id, b.id]);
    expect(frame!.rotation).toBe(0);
    // a's rotated AABB: 100×20 box turned 90° about (50,10) → x ∈ [40,60],
    // y ∈ [-40,60]; union with b extends to b's right edge.
    expect(frame!.bounds.x).toBeCloseTo(40, 6);
    expect(frame!.bounds.y).toBeCloseTo(-40, 6);
    expect(frame!.bounds.width).toBeCloseTo(200 + b.width - 40, 6);
  });

  it("uses live interaction bounds for attached text", () => {
    const path = createPath({ x: 300, y: 200 });
    const text = createText({ x: 10, y: 20, content: "Attached" });
    text.onPath = { pathId: path.id, startOffset: 0, flip: false };
    const document = docWith(path, text);
    const live = { x: 320, y: 170, width: 180, height: 80 };

    expect(selectionFrame(document, [text.id], new Map([[text.id, live]]))).toEqual({
      bounds: live,
      rotation: 0,
    });
  });

  it("normalizeAngle wraps into (-180, 180]", () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(360)).toBe(0);
  });
});
