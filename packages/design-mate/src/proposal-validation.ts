import type { LogoVariant } from "@openlogo/core";
import type {
  DesignMateAction,
  DesignMateProposal,
} from "./contracts";
import { deepFreeze } from "./snapshot";

export const DESIGN_MATE_PROPOSAL_LIMITS = Object.freeze({
  proposalIdLength: 256,
  labelLength: 160,
  rationaleLength: 2_000,
  sourceFindingIds: 64,
  referenceIdLength: 2_048,
  actions: 64,
  artboards: 64,
  textContentLength: 4_000,
  colorLength: 32,
  minimumLetterSpacing: -100,
  maximumLetterSpacing: 100,
  errorMessageLength: 240,
  impactSummaryLength: 240,
} as const);

const RISKS = new Set(["low", "medium", "high"]);
const LOGO_VARIANTS = new Set<LogoVariant>([
  "primary",
  "icon",
  "wordmark",
  "horizontal",
  "stacked",
]);

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

function isUniqueReferenceIds(value: unknown): value is string[] {
  const seen = new Set<string>();
  return isDenseBoundedArray(
    value,
    DESIGN_MATE_PROPOSAL_LIMITS.sourceFindingIds,
    (item) => {
      if (
        !isBoundedString(
          item,
          DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
        ) ||
        seen.has(item)
      ) {
        return false;
      }
      seen.add(item);
      return true;
    },
  );
}

/**
 * Proposal colors are intentionally limited to opaque CSS hex colors. This
 * keeps model output deterministic and excludes gradients, URLs, and alpha
 * compositing that the action contract cannot describe safely.
 */
export function isValidDesignMateSolidColor(value: unknown): value is string {
  return (
    isBoundedString(value, DESIGN_MATE_PROPOSAL_LIMITS.colorLength) &&
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
  );
}

export function normalizeDesignMateSolidColor(color: string): string {
  const digits = color.slice(1).toLowerCase();
  return digits.length === 3
    ? `#${digits
        .split("")
        .map((digit) => `${digit}${digit}`)
        .join("")}`
    : `#${digits}`;
}

function isDesignMateAction(value: unknown): value is DesignMateAction {
  if (!isPlainRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "set-text-content":
      return (
        hasExactKeys(value, ["type", "nodeId", "content"]) &&
        isBoundedString(
          value.nodeId,
          DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
        ) &&
        isBoundedString(
          value.content,
          DESIGN_MATE_PROPOSAL_LIMITS.textContentLength,
        )
      );
    case "set-fill-color":
      return (
        hasExactKeys(value, ["type", "nodeId", "color"]) &&
        isBoundedString(
          value.nodeId,
          DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
        ) &&
        isValidDesignMateSolidColor(value.color)
      );
    case "set-letter-spacing":
      return (
        hasExactKeys(value, ["type", "nodeId", "letterSpacing"]) &&
        isBoundedString(
          value.nodeId,
          DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
        ) &&
        typeof value.letterSpacing === "number" &&
        Number.isFinite(value.letterSpacing) &&
        value.letterSpacing >=
          DESIGN_MATE_PROPOSAL_LIMITS.minimumLetterSpacing &&
        value.letterSpacing <=
          DESIGN_MATE_PROPOSAL_LIMITS.maximumLetterSpacing
      );
    case "create-logo-variant":
      return (
        hasExactKeys(value, ["type", "sourceArtboardId", "purpose"]) &&
        isBoundedString(
          value.sourceArtboardId,
          DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
        ) &&
        typeof value.purpose === "string" &&
        LOGO_VARIANTS.has(value.purpose as LogoVariant)
      );
    default:
      return false;
  }
}

function validateDesignMateProposal(
  value: unknown,
): value is DesignMateProposal {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "label", "risk", "actions"],
      ["rationale", "sourceFindingIds"],
    ) ||
    !isBoundedString(
      value.id,
      DESIGN_MATE_PROPOSAL_LIMITS.proposalIdLength,
    ) ||
    !isBoundedString(value.label, DESIGN_MATE_PROPOSAL_LIMITS.labelLength) ||
    typeof value.risk !== "string" ||
    !RISKS.has(value.risk) ||
    !isDenseBoundedArray(
      value.actions,
      DESIGN_MATE_PROPOSAL_LIMITS.actions,
      isDesignMateAction,
    ) ||
    value.actions.length === 0
  ) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "rationale") &&
    !isBoundedString(
      value.rationale,
      DESIGN_MATE_PROPOSAL_LIMITS.rationaleLength,
    )
  ) {
    return false;
  }

  return (
    !Object.prototype.hasOwnProperty.call(value, "sourceFindingIds") ||
    isUniqueReferenceIds(value.sourceFindingIds)
  );
}

/** Runtime guard for the exact, closed proposal and action contracts. */
export function isValidDesignMateProposal(
  value: unknown,
): value is DesignMateProposal {
  try {
    return validateDesignMateProposal(value);
  } catch {
    return false;
  }
}

/**
 * Detach provider-owned proposal data before it enters compilation. A second
 * validation closes races caused by accessors or proxies during cloning.
 */
export function snapshotValidDesignMateProposal(
  value: unknown,
): DesignMateProposal | null {
  try {
    if (!isValidDesignMateProposal(value)) {
      return null;
    }
    const snapshot: unknown = structuredClone(value);
    return isValidDesignMateProposal(snapshot)
      ? deepFreeze(snapshot)
      : null;
  } catch {
    return null;
  }
}
