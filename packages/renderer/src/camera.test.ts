import { describe, expect, it } from "vitest";
import { cameraKeepingCenter, createCamera } from "./camera";

describe("cameraKeepingCenter", () => {
  it("preserves zoom and the world point under the viewport centre", () => {
    const camera = { offset: { x: 100, y: 50 }, zoom: 2 };
    const next = cameraKeepingCenter(camera, { width: 800, height: 600 }, {
      width: 410,
      height: 600,
    });
    expect(next.zoom).toBe(2);
    // Previous centre world = 100 + 400/2 = 300 on x; 50 + 300/2 = 200 on y.
    expect(next.offset.x).toBeCloseTo(300 - 410 / 4, 6);
    expect(next.offset.y).toBeCloseTo(200 - 600 / 4, 6);
  });

  it("returns the same camera when the size is unchanged or invalid", () => {
    const camera = createCamera();
    expect(
      cameraKeepingCenter(camera, { width: 100, height: 100 }, {
        width: 100,
        height: 100,
      }),
    ).toBe(camera);
    expect(
      cameraKeepingCenter(camera, { width: 0, height: 100 }, {
        width: 200,
        height: 100,
      }),
    ).toBe(camera);
  });
});
