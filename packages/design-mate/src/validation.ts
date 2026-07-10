import type { DesignReview, ReviewFinding } from "@openlogo/core";
import { deepFreeze } from "./snapshot";

/**
 * Provider-output limits. They bound both individual text fields and every
 * expandable list before a review can enter the event stream.
 */
export const DESIGN_REVIEW_LIMITS = {
  summaryLength: 2_000,
  findings: 256,
  findingIdLength: 2_048,
  titleLength: 240,
  detailLength: 4_000,
  actionLength: 2_000,
  nodeIds: 512,
  referenceIdLength: 2_048,
  evidence: 32,
  evidenceLabelLength: 240,
  evidenceStringValueLength: 2_000,
  evidenceUnitLength: 64,
  suggestedActions: 32,
  suggestedActionIdLength: 512,
  suggestedActionLabelLength: 1_000,
} as const;

const REVIEW_CATEGORIES = new Set([
  "concept",
  "composition",
  "typography",
  "geometry",
  "color",
  "scalability",
  "variants",
  "production",
]);
const REVIEW_SEVERITIES = new Set(["info", "warning", "strong"]);
const REVIEW_KINDS = new Set(["objective", "judgment"]);

type UnknownRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isDenseBoundedArray(
  value: unknown,
  maximumLength: number,
  validateItem: (item: unknown) => boolean,
): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    return false;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !validateItem(value[index])
    ) {
      return false;
    }
  }
  return true;
}

function isUniqueBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): value is string[] {
  const seen = new Set<string>();
  return isDenseBoundedArray(value, maximumItems, (item) => {
    if (
      !isBoundedString(item, maximumItemLength) ||
      seen.has(item)
    ) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

function isReviewEvidence(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["label", "value"], ["unit"]) ||
    !isBoundedString(
      value.label,
      DESIGN_REVIEW_LIMITS.evidenceLabelLength,
    )
  ) {
    return false;
  }

  const evidenceValue = value.value;
  if (
    !(
      isBoundedString(
        evidenceValue,
        DESIGN_REVIEW_LIMITS.evidenceStringValueLength,
        true,
      ) ||
      (typeof evidenceValue === "number" && Number.isFinite(evidenceValue))
    )
  ) {
    return false;
  }

  return (
    !Object.prototype.hasOwnProperty.call(value, "unit") ||
    isBoundedString(value.unit, DESIGN_REVIEW_LIMITS.evidenceUnitLength)
  );
}

function isSuggestedAction(value: unknown): value is {
  readonly id: string;
  readonly label: string;
} {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["id", "label"]) &&
    isBoundedString(
      value.id,
      DESIGN_REVIEW_LIMITS.suggestedActionIdLength,
    ) &&
    isBoundedString(
      value.label,
      DESIGN_REVIEW_LIMITS.suggestedActionLabelLength,
    )
  );
}

function hasValidSuggestedActions(value: unknown): boolean {
  const actionIds = new Set<string>();
  return isDenseBoundedArray(
    value,
    DESIGN_REVIEW_LIMITS.suggestedActions,
    (item) => {
      if (!isSuggestedAction(item) || actionIds.has(item.id)) {
        return false;
      }
      actionIds.add(item.id);
      return true;
    },
  );
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "severity",
        "category",
        "kind",
        "title",
        "detail",
        "action",
        "evidence",
        "suggestedActions",
      ],
      ["nodeIds", "artboardId"],
    ) ||
    !isBoundedString(value.id, DESIGN_REVIEW_LIMITS.findingIdLength) ||
    typeof value.severity !== "string" ||
    !REVIEW_SEVERITIES.has(value.severity) ||
    typeof value.category !== "string" ||
    !REVIEW_CATEGORIES.has(value.category) ||
    typeof value.kind !== "string" ||
    !REVIEW_KINDS.has(value.kind) ||
    !isBoundedString(value.title, DESIGN_REVIEW_LIMITS.titleLength) ||
    !isBoundedString(value.detail, DESIGN_REVIEW_LIMITS.detailLength) ||
    !isBoundedString(value.action, DESIGN_REVIEW_LIMITS.actionLength) ||
    !isDenseBoundedArray(
      value.evidence,
      DESIGN_REVIEW_LIMITS.evidence,
      isReviewEvidence,
    ) ||
    !hasValidSuggestedActions(value.suggestedActions)
  ) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "nodeIds") &&
    !isUniqueBoundedStringArray(
      value.nodeIds,
      DESIGN_REVIEW_LIMITS.nodeIds,
      DESIGN_REVIEW_LIMITS.referenceIdLength,
    )
  ) {
    return false;
  }

  return (
    !Object.prototype.hasOwnProperty.call(value, "artboardId") ||
    isBoundedString(
      value.artboardId,
      DESIGN_REVIEW_LIMITS.referenceIdLength,
    )
  );
}

function validateDesignReview(value: unknown): value is DesignReview {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["summary", "findings"]) ||
    !isBoundedString(value.summary, DESIGN_REVIEW_LIMITS.summaryLength)
  ) {
    return false;
  }

  const findingIds = new Set<string>();
  return isDenseBoundedArray(
    value.findings,
    DESIGN_REVIEW_LIMITS.findings,
    (finding) => {
      if (!isReviewFinding(finding) || findingIds.has(finding.id)) {
        return false;
      }
      findingIds.add(finding.id);
      return true;
    },
  );
}

/**
 * Runtime guard for the complete enriched DesignReview contract.
 */
export function isValidDesignReview(value: unknown): value is DesignReview {
  try {
    return validateDesignReview(value);
  } catch {
    return false;
  }
}

/**
 * Structured-clone first so accessors, unsupported scalar values, and later
 * mutation of provider-owned objects cannot affect emitted events.
 */
export function snapshotValidDesignReview(
  value: unknown,
): DesignReview | null {
  try {
    if (!isValidDesignReview(value)) {
      return null;
    }
    const snapshot: unknown = structuredClone(value);
    return isValidDesignReview(snapshot)
      ? deepFreeze(snapshot)
      : null;
  } catch {
    return null;
  }
}
