import type { TextNode } from "./types";

/**
 * Manual kerning helpers. Kerning lives on TextNode as a sparse map of
 * pair-gap index → adjustment in Illustrator units (1/1000 em), so the
 * spacing scales with font size and the numbers match what designers
 * expect from Illustrator's kerning field.
 */

/** ⌥←/⌥→ step, 1/1000 em (Illustrator default). */
export const KERN_STEP = 20;
/** ⇧⌥←/⇧⌥→ step. */
export const KERN_STEP_LARGE = 100;

/** Attached text is one stream: collapse every line break into one space. */
export function normalizeTextPathContent(content: string): string {
  return content.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Adjustment for the gap after content[index], 1/1000 em. */
export function kernAt(
  kerning: Record<number, number> | undefined,
  index: number,
): number {
  return kerning?.[index] ?? 0;
}

/** 1/1000-em kerning value → px at a font size. */
export function kernToPx(value: number, fontSize: number): number {
  return (value / 1000) * fontSize;
}

/**
 * Adjust the pair gap at `index` by `delta` (1/1000 em). Zero entries
 * are pruned and an empty map collapses to undefined, so "no manual
 * kerning" round-trips as an absent field.
 */
export function withKernAdjusted(
  kerning: Record<number, number> | undefined,
  index: number,
  delta: number,
): Record<number, number> | undefined {
  const next: Record<number, number> = { ...kerning };
  const value = (next[index] ?? 0) + delta;
  if (value === 0) {
    delete next[index];
  } else {
    next[index] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Drop kerning entries that no longer sit between two characters of
 * `content` (after a text edit). Returns undefined when nothing is left.
 */
export function pruneKerning(
  kerning: Record<number, number> | undefined,
  content: string,
): Record<number, number> | undefined {
  if (!kerning) {
    return undefined;
  }
  const next: Record<number, number> = {};
  for (const [key, value] of Object.entries(kerning)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < content.length - 1 && value !== 0) {
      next[index] = value;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Count of manually kerned pairs on a text node. */
export function kernedPairCount(node: TextNode): number {
  return node.kerning ? Object.keys(node.kerning).length : 0;
}
