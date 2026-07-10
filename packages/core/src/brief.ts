import type { DesignBrief } from "./types";

/**
 * Durability limits for user-authored brief data. They keep documents and
 * command payloads small while leaving room for useful prose and research:
 * a 200-character brand name, 4,000-character prose fields, and at most
 * 50 list entries of 240 characters each.
 */
export const DESIGN_BRIEF_LIMITS = {
  brandNameLength: 200,
  proseLength: 4_000,
  listItems: 50,
  listItemLength: 240,
} as const;

function sanitizeString(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = value.trim().slice(0, maxLength).trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeList(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items: string[] = [];
  const seen = new Set<string>();
  for (const rawItem of value) {
    const item = sanitizeString(rawItem, DESIGN_BRIEF_LIMITS.listItemLength);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
    if (items.length === DESIGN_BRIEF_LIMITS.listItems) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
}

/**
 * Canonicalize a Design Mate brief at every write boundary. Unknown runtime
 * properties are deliberately not copied; schema loading retains Zod's normal
 * object-stripping behavior and commands cannot smuggle arbitrary metadata
 * into a document.
 */
export function sanitizeDesignBrief(brief: DesignBrief): DesignBrief {
  const brandName = sanitizeString(
    brief?.brandName,
    DESIGN_BRIEF_LIMITS.brandNameLength,
  );
  const offering = sanitizeString(
    brief?.offering,
    DESIGN_BRIEF_LIMITS.proseLength,
  );
  const audience = sanitizeString(
    brief?.audience,
    DESIGN_BRIEF_LIMITS.proseLength,
  );
  const attributes = sanitizeList(brief?.attributes);
  const avoid = sanitizeList(brief?.avoid);
  const competitors = sanitizeList(brief?.competitors);
  const primaryUseCases = sanitizeList(brief?.primaryUseCases);
  const mustKeep = sanitizeList(brief?.mustKeep);
  const constraints = sanitizeString(
    brief?.constraints,
    DESIGN_BRIEF_LIMITS.proseLength,
  );
  const notes = sanitizeString(
    brief?.notes,
    DESIGN_BRIEF_LIMITS.proseLength,
  );

  return {
    ...(brandName !== undefined ? { brandName } : {}),
    ...(offering !== undefined ? { offering } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(avoid !== undefined ? { avoid } : {}),
    ...(competitors !== undefined ? { competitors } : {}),
    ...(primaryUseCases !== undefined ? { primaryUseCases } : {}),
    ...(mustKeep !== undefined ? { mustKeep } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}
