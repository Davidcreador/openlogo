import type opentype from "opentype.js";

/**
 * Pair-kerning lookup for a parsed opentype.js font, as a fraction of
 * the em. Reads GPOS pair adjustment through the (untyped) position API
 * first — Fontsource TTFs carry no legacy kern table, and
 * font.getKerningValue only reads that — falling back to the kern table
 * for fonts that do ship one. Coverage: GPOS lookup type 2 (pair
 * adjustment) and the kern table; contextual positioning is not applied.
 */
export function kerningLookup(
  font: opentype.Font,
): (left: string, right: string) => number {
  const unitsPerEm = font.unitsPerEm || 1000;
  const position = (
    font as unknown as {
      position?: {
        getKerningTables: (script: string, language?: string | null) => unknown;
        getKerningValue: (tables: unknown, left: number, right: number) => number;
      };
    }
  ).position;

  let tables: unknown = null;
  if (position) {
    for (const script of ["latn", "DFLT"]) {
      try {
        tables = position.getKerningTables(script, null);
      } catch {
        tables = null;
      }
      if (Array.isArray(tables) && tables.length > 0) {
        break;
      }
    }
  }
  const hasGpos = Array.isArray(tables) && tables.length > 0;

  const cache = new Map<string, number>();
  return (left, right) => {
    const key = left + right;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let value = 0;
    try {
      const l = font.charToGlyph(left);
      const r = font.charToGlyph(right);
      value =
        hasGpos && position
          ? (position.getKerningValue(tables, l.index ?? 0, r.index ?? 0) ?? 0) /
            unitsPerEm
          : font.getKerningValue(l, r) / unitsPerEm;
    } catch {
      value = 0;
    }
    cache.set(key, value);
    return value;
  };
}
