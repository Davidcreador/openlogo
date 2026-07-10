import {
  sanitizeDesignBrief,
  type DesignBrief,
} from "@openlogo/core";

export type DesignBriefDraft = {
  brandName: string;
  offering: string;
  audience: string;
  attributes: string;
  avoid: string;
  competitors: string;
  primaryUseCases: string;
  mustKeep: string;
  constraints: string;
  notes: string;
};

const LIST_SEPARATOR = /[\n,]+/;

const listToDraft = (items: readonly string[] | undefined): string =>
  items?.join("\n") ?? "";

const draftToList = (value: string): string[] =>
  value
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean);

export function designBriefToDraft(
  brief: DesignBrief | undefined,
): DesignBriefDraft {
  return {
    brandName: brief?.brandName ?? "",
    offering: brief?.offering ?? "",
    audience: brief?.audience ?? "",
    attributes: listToDraft(brief?.attributes),
    avoid: listToDraft(brief?.avoid),
    competitors: listToDraft(brief?.competitors),
    primaryUseCases: listToDraft(brief?.primaryUseCases),
    mustKeep: listToDraft(brief?.mustKeep),
    constraints: brief?.constraints ?? "",
    notes: brief?.notes ?? "",
  };
}

/**
 * Convert the form into canonical document data. An all-empty form clears the
 * optional brief instead of persisting a meaningless empty object.
 */
export function designBriefFromDraft(
  draft: DesignBriefDraft,
): DesignBrief | undefined {
  const brief = sanitizeDesignBrief({
    brandName: draft.brandName,
    offering: draft.offering,
    audience: draft.audience,
    attributes: draftToList(draft.attributes),
    avoid: draftToList(draft.avoid),
    competitors: draftToList(draft.competitors),
    primaryUseCases: draftToList(draft.primaryUseCases),
    mustKeep: draftToList(draft.mustKeep),
    constraints: draft.constraints,
    notes: draft.notes,
  });

  return Object.keys(brief).length > 0 ? brief : undefined;
}
