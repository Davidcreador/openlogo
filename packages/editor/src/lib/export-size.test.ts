import { describe, expect, it } from "vitest";
import {
  MAX_RASTER_DIMENSION,
  MAX_RASTER_PIXELS,
  validateRasterSize,
} from "./export";

describe("validateRasterSize", () => {
  it("rounds a normal scaled export", () => {
    expect(validateRasterSize(720, 420, 2)).toEqual({
      ok: true,
      width: 1440,
      height: 840,
    });
  });

  it("clamps positive subpixel axes to one pixel", () => {
    expect(validateRasterSize(0.1, 100, 1)).toEqual({
      ok: true,
      width: 1,
      height: 100,
    });
    expect(validateRasterSize(100, 0.1, 1)).toEqual({
      ok: true,
      width: 100,
      height: 1,
    });
    expect(validateRasterSize(1, 1, 0.1)).toEqual({
      ok: true,
      width: 1,
      height: 1,
    });
  });

  it("rejects non-finite and non-positive source dimensions or scale", () => {
    expect(validateRasterSize(Infinity, 100, 1).ok).toBe(false);
    expect(validateRasterSize(100, 0, 1).ok).toBe(false);
    expect(validateRasterSize(100, 100, Number.NaN).ok).toBe(false);
    expect(validateRasterSize(-100, -100, -1).ok).toBe(false);
    expect(validateRasterSize(100, 100, 0).ok).toBe(false);
  });

  it("rejects non-finite scaled allocations", () => {
    expect(validateRasterSize(Number.MAX_VALUE, 1, 2).ok).toBe(false);
  });

  it("rejects either oversized side", () => {
    expect(validateRasterSize(MAX_RASTER_DIMENSION + 1, 1, 1).ok).toBe(false);
    expect(validateRasterSize(1, MAX_RASTER_DIMENSION + 1, 1).ok).toBe(false);
  });

  it("rejects unsafe total pixel allocations", () => {
    const side = Math.floor(Math.sqrt(MAX_RASTER_PIXELS)) + 1;
    expect(validateRasterSize(side, side, 1).ok).toBe(false);
  });

  it("applies allocation limits after clamping thin axes", () => {
    expect(
      validateRasterSize(MAX_RASTER_DIMENSION, Number.MIN_VALUE, 1),
    ).toEqual({
      ok: true,
      width: MAX_RASTER_DIMENSION,
      height: 1,
    });
    expect(
      validateRasterSize(MAX_RASTER_DIMENSION + 1, Number.MIN_VALUE, 1).ok,
    ).toBe(false);
  });
});
