# ADR 0003: Invalidation-driven CanvasKit rendering

- Status: Accepted
- Date: 2026-07-09

## Context

The renderer previously requested animation frames forever, including when the
scene was unchanged. Document preview notifications also propagated through
React, regenerating inspector sections, layer thumbnails, and export previews
for pointer-move frames.

## Decision

- `SceneRenderer` uses a one-shot invalidation scheduler. Multiple invalidates
  coalesce into one frame, invalidation during drawing schedules one follow-up,
  and a clean scene requests no frames.
- CanvasStage subscribes to all document changes and sends them directly to
  CanvasKit.
- React chrome observes committed document snapshots by default.
- Components that must follow gestures opt into `useLiveDocument` or maintain a
  narrowly scoped local preview, such as gradient handles and stop chips.
- Preview changes remain outside history and persistence; pointer cancellation
  restores the committed document.

## Consequences

- Idle CPU/GPU work falls to zero for the render loop.
- Pointer previews remain visually live without rerendering unrelated panels.
- New live-preview UI must explicitly choose a narrow subscription; a broad
  `useDocument` change is intentionally insufficient.
- Scheduler behavior is independently testable with fake animation frames.

