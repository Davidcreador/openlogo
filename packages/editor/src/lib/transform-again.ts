import { type TransformSpec, applyTransform } from "./transform-ops";

/**
 * Transform Again (⌘D, Illustrator semantics): the last committed
 * interactive transform — move/rotate/scale/reflect, with its copy
 * flag — replays on the current selection. Session-local, like the
 * clipboard: it is gesture state, not document state.
 */
export type RecordedTransform = TransformSpec & { copy: boolean };

let recorded: RecordedTransform | null = null;

export function recordTransform(transform: RecordedTransform): void {
  recorded = transform;
}
/**
 * Repeat the recorded transform on the selection. Returns the ids to
 * select afterwards (the new copies when the transform duplicated), or
 * null when there is nothing to repeat.
 */
export function transformAgain(nodeIds: readonly string[]): string[] | null {
  if (!recorded || nodeIds.length === 0) {
    return null;
  }
  const { copy, ...spec } = recorded;
  return applyTransform(nodeIds, spec as TransformSpec, copy);
}
