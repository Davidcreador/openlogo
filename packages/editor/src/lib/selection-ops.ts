export function resolveMarqueeSelection(
  hits: readonly string[],
  existing: readonly string[],
  addToSelection: boolean,
): string[] {
  return addToSelection ? [...new Set([...existing, ...hits])] : [...hits];
}
