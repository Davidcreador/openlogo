type FrameCallback = (timestamp: number) => void;
type RequestFrame = (callback: FrameCallback) => number;
type CancelFrame = (handle: number) => void;

/** Coalesces invalidations into one animation frame and sleeps while clean. */
export class InvalidationScheduler {
  private dirty = false;
  private disposed = false;
  private frame: number | null = null;

  constructor(
    private readonly render: () => void,
    private readonly requestFrame: RequestFrame = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancelFrame: CancelFrame = (handle) =>
      cancelAnimationFrame(handle),
  ) {}

  invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.dirty = true;
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dirty = false;
    if (this.frame !== null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
  }

  private schedule(): void {
    if (this.frame !== null) {
      return;
    }
    this.frame = this.requestFrame(this.tick);
  }

  private tick = (): void => {
    this.frame = null;
    if (this.disposed || !this.dirty) {
      return;
    }

    this.dirty = false;
    this.render();

    // invalidate() normally schedules this while render runs; this also
    // covers an injected scheduler that defers request bookkeeping.
    if (this.dirty) {
      this.schedule();
    }
  };
}
