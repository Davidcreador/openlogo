type CanvasSessionCanceler = () => void;

let activeCanceler: CanvasSessionCanceler | null = null;

/** CanvasStage registers the one place that owns pointer/edit session refs. */
export function registerCanvasSessionCanceler(
  canceler: CanvasSessionCanceler,
): () => void {
  activeCanceler = canceler;
  return () => {
    if (activeCanceler === canceler) {
      activeCanceler = null;
    }
  };
}

/** Cancel transient geometry before history or document identity changes. */
export function cancelActiveCanvasSessions(): void {
  activeCanceler?.();
}
