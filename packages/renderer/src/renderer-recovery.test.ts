import type { CanvasKit, Surface } from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import type { FontRegistry } from "./fonts";
import { SceneRenderer } from "./renderer";

describe("SceneRenderer surface recovery", () => {
  it("drops a lost surface, prevents default context teardown, and recreates", () => {
    const listeners = new Map<string, EventListener>();
    const canvas = {
      width: 1,
      height: 1,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    } as unknown as HTMLCanvasElement;
    const first = { delete: vi.fn() } as unknown as Surface;
    const second = { delete: vi.fn() } as unknown as Surface;
    const makeWebGl = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const canvasKit = {
      MakeWebGLCanvasSurface: makeWebGl,
      MakeSWCanvasSurface: vi.fn(() => null),
    } as unknown as CanvasKit;

    const renderer = new SceneRenderer(
      canvasKit,
      canvas,
      {} as FontRegistry,
    );
    const preventDefault = vi.fn();
    listeners.get("webglcontextlost")?.({
      preventDefault,
    } as unknown as Event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(first.delete).toHaveBeenCalledOnce();
    expect(renderer.recover()).toBe(true);
    expect(makeWebGl).toHaveBeenCalledTimes(2);

    renderer.dispose();
    expect(second.delete).toHaveBeenCalledOnce();
    expect(canvas.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
