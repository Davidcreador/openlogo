import { describe, expect, it, vi } from "vitest";
import { InvalidationScheduler } from "./invalidation-scheduler";

type FrameCallback = (timestamp: number) => void;

class FakeAnimationFrames {
  private nextHandle = 1;
  private callbacks = new Map<number, FrameCallback>();

  readonly request = vi.fn((callback: FrameCallback): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  });

  readonly cancel = vi.fn((handle: number): void => {
    this.callbacks.delete(handle);
  });

  get pending(): number {
    return this.callbacks.size;
  }

  get firstPendingHandle(): number | null {
    return this.callbacks.keys().next().value ?? null;
  }

  flushNext(timestamp = 0): void {
    const entry = this.callbacks.entries().next();
    if (entry.done) {
      throw new Error("No animation frame is pending.");
    }
    const [handle, callback] = entry.value;
    this.callbacks.delete(handle);
    callback(timestamp);
  }
}

describe("InvalidationScheduler", () => {
  it("coalesces invalidations and sleeps after rendering", () => {
    const frames = new FakeAnimationFrames();
    const render = vi.fn();
    const scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.invalidate();

    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(1);

    frames.flushNext();

    expect(render).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(0);
    expect(frames.request).toHaveBeenCalledTimes(1);
  });

  it("wakes again only after a new invalidation", () => {
    const frames = new FakeAnimationFrames();
    const render = vi.fn();
    const scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    frames.flushNext();
    expect(frames.pending).toBe(0);

    scheduler.invalidate();
    expect(frames.pending).toBe(1);
    frames.flushNext();

    expect(render).toHaveBeenCalledTimes(2);
    expect(frames.pending).toBe(0);
  });

  it("schedules another frame when invalidated during rendering", () => {
    const frames = new FakeAnimationFrames();
    let scheduler: InvalidationScheduler;
    const render = vi.fn(() => {
      if (render.mock.calls.length === 1) {
        scheduler.invalidate();
      }
    });
    scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    frames.flushNext();

    expect(render).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(1);
    expect(frames.request).toHaveBeenCalledTimes(2);

    frames.flushNext();

    expect(render).toHaveBeenCalledTimes(2);
    expect(frames.pending).toBe(0);
  });

  it("clears a pending frame after a synchronous paint", () => {
    const frames = new FakeAnimationFrames();
    const render = vi.fn();
    const scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    const handle = frames.firstPendingHandle;
    scheduler.clearPending();

    expect(handle).not.toBeNull();
    expect(frames.cancel).toHaveBeenCalledWith(handle);
    expect(frames.pending).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });

  it("cancels a pending frame and cannot reschedule after disposal", () => {
    const frames = new FakeAnimationFrames();
    const render = vi.fn();
    const scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    const handle = frames.firstPendingHandle;
    scheduler.dispose();
    scheduler.invalidate();

    expect(handle).not.toBeNull();
    expect(frames.cancel).toHaveBeenCalledOnce();
    expect(frames.cancel).toHaveBeenCalledWith(handle);
    expect(frames.pending).toBe(0);
    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("cancels a follow-up invalidation when disposed during rendering", () => {
    const frames = new FakeAnimationFrames();
    let scheduler: InvalidationScheduler;
    const render = vi.fn(() => {
      scheduler.invalidate();
      scheduler.dispose();
      scheduler.invalidate();
    });
    scheduler = new InvalidationScheduler(
      render,
      frames.request,
      frames.cancel,
    );

    scheduler.invalidate();
    frames.flushNext();

    expect(render).toHaveBeenCalledOnce();
    expect(frames.request).toHaveBeenCalledTimes(2);
    expect(frames.cancel).toHaveBeenCalledOnce();
    expect(frames.pending).toBe(0);
  });
});
