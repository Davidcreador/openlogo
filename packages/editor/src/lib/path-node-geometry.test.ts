import { describe, expect, it, vi } from "vitest";
import { materializePathGeometry } from "./path-node-geometry";

describe("materializePathGeometry", () => {
  it("converts legacy SVG path data and releases the Skia path", async () => {
    const deletePath = vi.fn();
    const canvasKit = {
      Path: {
        MakeFromSVGString: () => ({
          toCmds: () => new Float32Array([0, 0, 0, 1, 10, 0, 1, 10, 10, 5]),
          delete: deletePath,
        }),
      },
    } as never;

    expect(materializePathGeometry(canvasKit, "M0 0L10 0L10 10Z")).toEqual({
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    });
    expect(deletePath).toHaveBeenCalledOnce();
  });

  it("returns null when CanvasKit cannot parse the path", async () => {
    const canvasKit = {
      Path: { MakeFromSVGString: () => null },
    } as never;

    expect(materializePathGeometry(canvasKit, "not a path")).toBeNull();
  });

  it("releases the Skia path when command extraction fails", async () => {
    const deletePath = vi.fn();
    const canvasKit = {
      Path: {
        MakeFromSVGString: () => ({
          toCmds: () => {
            throw new Error("broken path");
          },
          delete: deletePath,
        }),
      },
    } as never;

    expect(() => materializePathGeometry(canvasKit, "M0 0")).toThrow("broken path");
    expect(deletePath).toHaveBeenCalledOnce();
  });
});
