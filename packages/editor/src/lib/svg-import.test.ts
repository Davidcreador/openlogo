import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_SVG_IMPORT_BYTES,
  SvgImportError,
  importSvg,
  transformedStrokeWidth,
} from "./svg-import";

describe("SVG import hardening", () => {
  it("rejects oversized source before parsing or loading CanvasKit", async () => {
    const error = await Effect.runPromise(
      Effect.flip(importSvg(" ".repeat(MAX_SVG_IMPORT_BYTES + 1))),
    );
    expect(error).toBeInstanceOf(SvgImportError);
    expect(error._tag).toBe("SvgImportError");
    if (error._tag === "SvgImportError") {
      expect(error.reason).toContain("5 MB");
    }
  });

  it("scales strokes with uniform, rotated, and non-uniform transforms", () => {
    expect(transformedStrokeWidth(3, [2, 0, 0, 2, 0, 0])).toBe(6);
    expect(transformedStrokeWidth(3, [0, 1, -1, 0, 0, 0])).toBe(3);
    expect(transformedStrokeWidth(3, [4, 0, 0, 2, 0, 0])).toBe(12);
  });
});
