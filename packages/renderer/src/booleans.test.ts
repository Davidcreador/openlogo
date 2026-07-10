import type { CanvasKit, Path } from "canvaskit-wasm";
import { createPath } from "@openlogo/core";
import { describe, expect, it, vi } from "vitest";
import { compoundNodes } from "./booleans";

function fakePath(commands: number[], bounds: [number, number, number, number]) {
  return {
    computeTightBounds: vi.fn(() => bounds),
    delete: vi.fn(),
    setFillType: vi.fn(),
    simplify: vi.fn(function (this: Path) {
      return this;
    }),
    toCmds: vi.fn(() => commands),
    transform: vi.fn(),
  } as unknown as Path;
}

describe("compoundNodes", () => {
  it("combines independent contours and applies each source fill rule", () => {
    const outer = fakePath(
      [0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 5],
      [0, 0, 10, 10],
    );
    const inner = fakePath(
      [0, 2, 2, 1, 8, 2, 1, 8, 8, 1, 2, 8, 5],
      [2, 2, 8, 8],
    );
    const queue = [outer, inner];
    const winding = { value: 0 };
    const evenOdd = { value: 1 };
    const canvasKit = {
      FillType: { Winding: winding, EvenOdd: evenOdd },
      Path: { MakeFromSVGString: vi.fn(() => queue.shift() ?? null) },
    } as unknown as CanvasKit;
    const first = createPath({ x: 0, y: 0, d: "outer" });
    const second = createPath({
      x: 0,
      y: 0,
      d: "inner",
      fillRule: "evenodd",
    });

    const result = compoundNodes(canvasKit, [first, second]);

    expect(result).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fillRule: "evenodd",
    });
    expect(result!.geometry.subpaths).toHaveLength(2);
    expect(result!.geometry.subpaths.every((subpath) => subpath.closed)).toBe(
      true,
    );
    expect(outer.setFillType).toHaveBeenCalledWith(winding);
    expect(inner.setFillType).toHaveBeenCalledWith(evenOdd);
    expect(outer.simplify).toHaveBeenCalledOnce();
    expect(inner.simplify).toHaveBeenCalledOnce();
    expect(outer.delete).toHaveBeenCalledOnce();
    expect(inner.delete).toHaveBeenCalledOnce();
  });

  it("returns null and releases parsed paths when any operand is invalid", () => {
    const valid = fakePath(
      [0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 5],
      [0, 0, 10, 10],
    );
    const queue: Array<Path | null> = [valid, null];
    const canvasKit = {
      FillType: { Winding: { value: 0 }, EvenOdd: { value: 1 } },
      Path: { MakeFromSVGString: vi.fn(() => queue.shift() ?? null) },
    } as unknown as CanvasKit;
    const nodes = [
      createPath({ x: 0, y: 0, d: "valid" }),
      createPath({ x: 0, y: 0, d: "invalid" }),
    ];

    expect(compoundNodes(canvasKit, nodes)).toBeNull();
    expect(valid.delete).toHaveBeenCalledOnce();
  });
});
