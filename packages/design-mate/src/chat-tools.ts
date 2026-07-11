import type { DesignReview, ReviewFinding } from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateProposal,
} from "./contracts";
import { designMateRiskForActions } from "./actions";
import {
  DESIGN_MATE_PROPOSAL_LIMITS,
  snapshotValidDesignMateProposal,
} from "./proposal-validation";
import { deepFreeze } from "./snapshot";
import {
  DESIGN_REVIEW_LIMITS,
  isValidDesignReview,
} from "./validation";

export const DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME =
  "submit_design_mate_proposal";
export const DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME =
  "inspect_design_review";
export const DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME =
  "explain_export_options";

export const DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS = Object.freeze({
  actions: 4,
  sourceFindingIds: 4,
});

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
): boolean {
  const allowed = new Set(required);
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

const referenceId = {
  type: "string",
  description: `A non-empty context reference id, limited to ${DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength} characters by runtime validation.`,
} as const;

const nodeIds = {
  type: "array",
  items: referenceId,
  description: `One to ${DESIGN_MATE_PROPOSAL_LIMITS.nodeIdsPerAction} unique selected node ids. Runtime validation enforces the bounds.`,
} as const;

const alignEdge = {
  type: "string",
  enum: ["left", "centerX", "right", "top", "centerY", "bottom"],
} as const;

const actionSchemas = [
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-text-content"] },
      nodeId: referenceId,
      content: {
        type: "string",
        description: `Non-empty replacement text, limited to ${DESIGN_MATE_PROPOSAL_LIMITS.textContentLength} characters by runtime validation.`,
      },
    },
    required: ["type", "nodeId", "content"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-fill-color"] },
      nodeId: referenceId,
      color: {
        type: "string",
        description:
          "An opaque CSS hex color in #RGB or #RRGGBB form. Runtime validation rejects other values.",
      },
    },
    required: ["type", "nodeId", "color"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-letter-spacing"] },
      nodeId: referenceId,
      letterSpacing: {
        type: "number",
        description: `Letter spacing from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumLetterSpacing} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumLetterSpacing}.`,
      },
    },
    required: ["type", "nodeId", "letterSpacing"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["create-wordmark"] },
      artboardId: referenceId,
      content: {
        type: "string",
        description:
          "The exact brand name from the supplied design brief. Runtime validation and compilation reject invented content.",
      },
    },
    required: ["type", "artboardId", "content"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["translate-nodes"] },
      nodeIds,
      dx: {
        type: "number",
        description: `Horizontal pixel delta from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumTranslation} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumTranslation}.`,
      },
      dy: {
        type: "number",
        description: `Vertical pixel delta from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumTranslation} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumTranslation}.`,
      },
    },
    required: ["type", "nodeIds", "dx", "dy"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["scale-nodes"] },
      nodeIds,
      scaleX: {
        type: "number",
        description: `Positive horizontal factor from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumScale} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumScale}.`,
      },
      scaleY: {
        type: "number",
        description: `Positive vertical factor from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumScale} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumScale}.`,
      },
    },
    required: ["type", "nodeIds", "scaleX", "scaleY"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["rotate-nodes"] },
      nodeIds,
      degrees: {
        type: "number",
        description: `Relative degrees from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumRotation} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumRotation}.`,
      },
    },
    required: ["type", "nodeIds", "degrees"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["align-nodes"] },
      nodeIds,
      edge: alignEdge,
      reference: {
        type: "string",
        enum: ["selection"],
      },
      keyObjectId: {
        type: "null",
      },
    },
    required: ["type", "nodeIds", "edge", "reference", "keyObjectId"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["align-nodes"] },
      nodeIds,
      edge: alignEdge,
      reference: {
        type: "string",
        enum: ["artboard"],
      },
      keyObjectId: {
        type: "null",
      },
    },
    required: ["type", "nodeIds", "edge", "reference", "keyObjectId"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["align-nodes"] },
      nodeIds,
      edge: alignEdge,
      reference: {
        type: "string",
        enum: ["key-object"],
      },
      keyObjectId: {
        ...referenceId,
        description:
          "The captured key-object id, which must also appear in nodeIds.",
      },
    },
    required: ["type", "nodeIds", "edge", "reference", "keyObjectId"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["distribute-nodes"] },
      nodeIds: {
        ...nodeIds,
        description: `At least three unique selected node ids, capped at ${DESIGN_MATE_PROPOSAL_LIMITS.nodeIdsPerAction} by runtime validation.`,
      },
      axis: {
        type: "string",
        enum: ["horizontal", "vertical"],
      },
    },
    required: ["type", "nodeIds", "axis"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-font-family"] },
      nodeId: referenceId,
      fontFamily: {
        type: "string",
        description: `A user- or context-supplied family name, limited to ${DESIGN_MATE_PROPOSAL_LIMITS.fontFamilyLength} characters by runtime validation.`,
      },
    },
    required: ["type", "nodeId", "fontFamily"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-font-size"] },
      nodeId: referenceId,
      fontSize: {
        type: "number",
        description: `Font size from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumFontSize}px to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumFontSize}px.`,
      },
    },
    required: ["type", "nodeId", "fontSize"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-font-weight"] },
      nodeId: referenceId,
      fontWeight: {
        type: "integer",
        description: `Integer weight from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumFontWeight} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumFontWeight}.`,
      },
    },
    required: ["type", "nodeId", "fontWeight"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-opacity"] },
      nodeId: referenceId,
      opacity: {
        type: "number",
        description: `Opacity from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumOpacity} to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumOpacity}.`,
      },
    },
    required: ["type", "nodeId", "opacity"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-stroke-color"] },
      nodeId: referenceId,
      color: {
        type: "string",
        description:
          "An opaque CSS hex color in #RGB or #RRGGBB form. Runtime validation rejects other values.",
      },
    },
    required: ["type", "nodeId", "color"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["set-stroke-width"] },
      nodeId: referenceId,
      width: {
        type: "number",
        description: `Stroke width from ${DESIGN_MATE_PROPOSAL_LIMITS.minimumStrokeWidth}px to ${DESIGN_MATE_PROPOSAL_LIMITS.maximumStrokeWidth}px.`,
      },
    },
    required: ["type", "nodeId", "width"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["create-logo-variant"] },
      sourceArtboardId: referenceId,
      purpose: {
        type: "string",
        enum: ["primary", "icon", "wordmark", "horizontal", "stacked"],
      },
    },
    required: ["type", "sourceArtboardId", "purpose"],
  },
] as const;

export const DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL = deepFreeze({
  type: "function",
  name: DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
  description:
    "Filter the deterministic DesignReview snapshot supplied for this turn. This is read-only and never re-analyzes or mutates the document.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      findingIds: {
        type: ["array", "null"],
        items: referenceId,
        description: `Unique finding ids to return, or null for all findings. Runtime validation caps this at ${DESIGN_REVIEW_LIMITS.findings}.`,
      },
      severity: {
        type: ["string", "null"],
        enum: ["info", "warning", "strong", null],
        description: "A severity filter, or null for all severities.",
      },
    },
    required: ["findingIds", "severity"],
  },
});

export const DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL = deepFreeze({
  type: "function",
  name: DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
  description:
    "Read OpenLogo's supported delivery formats and settings. This provides guidance only and never starts an export or changes the document.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      format: {
        type: ["string", "null"],
        enum: ["svg", "png", "jpeg", "webp", "ico", null],
        description: "One supported format to inspect, or null for all.",
      },
    },
    required: ["format"],
  },
});

/**
 * Strict Responses API function tool. It exposes only the closed proposal
 * action surface; provider-side commands and document mutation are impossible.
 * Nullable fields are required because strict OpenAI schemas require every
 * property to appear in `required`.
 */
export const DESIGN_MATE_CHAT_PROPOSAL_TOOL = deepFreeze({
  type: "function",
  name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  description:
    "Submit one conservative, preview-only logo change for explicit user approval. Supported actions edit text, create a brief-backed wordmark, adjust solid fills, tracking, typography, opacity, existing solid strokes, selected-node geometry, or clone a logo variant. Geometry must use visible selected ids from one artboard. Never invent ids, content, key objects, strokes, or fonts. Calling this tool never applies a change.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: {
        type: "string",
        description: `A concise non-empty label, limited to ${DESIGN_MATE_PROPOSAL_LIMITS.labelLength} characters by runtime validation.`,
      },
      rationale: {
        type: ["string", "null"],
        description: `A concise rationale or null, limited to ${DESIGN_MATE_PROPOSAL_LIMITS.rationaleLength} characters by runtime validation.`,
      },
      sourceFindingIds: {
        type: ["array", "null"],
        items: referenceId,
        description: `Up to ${DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.sourceFindingIds} unique finding ids, or null. Runtime validation enforces the limit.`,
      },
      actions: {
        type: "array",
        items: { anyOf: actionSchemas },
        description: `One to ${DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.actions} actions. Runtime validation enforces the limit.`,
      },
    },
    required: [
      "label",
      "rationale",
      "sourceFindingIds",
      "actions",
    ],
  },
});

export const DESIGN_MATE_CHAT_READ_ONLY_TOOLS = deepFreeze([
  DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL,
  DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL,
] as const);

export const DESIGN_MATE_CHAT_MODEL_TOOLS = deepFreeze([
  ...DESIGN_MATE_CHAT_READ_ONLY_TOOLS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL,
] as const);

/**
 * Convert untrusted function arguments into the normal proposal contract.
 * The caller owns the id; model-authored ids are never accepted.
 */
export function snapshotDesignMateChatProposalToolArguments(
  value: unknown,
  proposalId: string,
): DesignMateProposal | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, [
        "label",
        "rationale",
        "sourceFindingIds",
        "actions",
      ])
    ) {
      return null;
    }
    const snapshot: unknown = structuredClone(value);
    if (
      !isPlainRecord(snapshot) ||
      !hasExactKeys(snapshot, [
        "label",
        "rationale",
        "sourceFindingIds",
        "actions",
      ]) ||
      (snapshot.rationale !== null &&
        typeof snapshot.rationale !== "string") ||
      (snapshot.sourceFindingIds !== null &&
        !Array.isArray(snapshot.sourceFindingIds)) ||
      !Array.isArray(snapshot.actions) ||
      snapshot.actions.length >
        DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.actions ||
      (Array.isArray(snapshot.sourceFindingIds) &&
        snapshot.sourceFindingIds.length >
          DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.sourceFindingIds)
    ) {
      return null;
    }

    const validated = snapshotValidDesignMateProposal({
      id: proposalId,
      label: snapshot.label,
      risk: "high",
      actions: snapshot.actions,
      ...(snapshot.rationale === null
        ? {}
        : { rationale: snapshot.rationale }),
      ...(snapshot.sourceFindingIds === null
        ? {}
        : { sourceFindingIds: snapshot.sourceFindingIds }),
    });
    if (!validated) {
      return null;
    }
    const proposal = snapshotValidDesignMateProposal({
      ...validated,
      risk: designMateRiskForActions(validated.actions),
    });
    if (!proposal) {
      return null;
    }
    const serialized = JSON.stringify({
      type: "proposal-candidate",
      proposal,
    });
    return utf8ByteLength(serialized) <=
      DESIGN_MATE_CHAT_LIMITS.proposalSerializedBytes
      ? proposal
      : null;
  } catch {
    return null;
  }
}

const REVIEW_SEVERITIES = new Set(["info", "warning", "strong"]);
const EXPORT_FORMATS = new Set(["svg", "png", "jpeg", "webp", "ico"]);

export const DESIGN_MATE_EXPORT_OPTIONS_CATALOG = deepFreeze({
  formats: [
    {
      id: "svg",
      kind: "editable-vector",
      transparency: true,
      guidance:
        "Best master delivery format for scalable vectors and professional handoff.",
    },
    {
      id: "png",
      kind: "lossless-raster",
      transparency: true,
      guidance:
        "Best general raster delivery format for logos, UI, and transparent backgrounds.",
      limits: { maximumDimension: 16_384, maximumPixels: 32 * 1_024 * 1_024 },
    },
    {
      id: "jpeg",
      kind: "lossy-raster",
      transparency: false,
      guidance:
        "Use only when a small photographic-style asset is required; OpenLogo requires an explicit opaque background.",
      limits: { maximumDimension: 16_384, maximumPixels: 32 * 1_024 * 1_024 },
    },
    {
      id: "webp",
      kind: "compressed-raster",
      transparency: true,
      guidance:
        "Useful for compact web delivery when the receiving platform supports WebP.",
      limits: { maximumDimension: 16_384, maximumPixels: 32 * 1_024 * 1_024 },
    },
    {
      id: "ico",
      kind: "multi-size-icon",
      transparency: true,
      guidance:
        "Use the icon variant for favicon delivery and verify clarity at 16, 32, and 48 pixels.",
    },
  ],
  scopes: ["active-artboard", "all-artboards", "selection"],
  notes: [
    "Keep an editable SVG master alongside raster deliverables.",
    "Use a logo-system variant suited to the destination rather than scaling one lockup everywhere.",
    "Preview icon artwork at 16px before favicon delivery.",
  ],
});

function boundedToolOutput(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return utf8ByteLength(serialized) <=
      DESIGN_MATE_CHAT_LIMITS.readOnlyToolOutputBytes
      ? serialized
      : null;
  } catch {
    return null;
  }
}

function inspectReviewToolOutput(
  review: DesignReview,
  value: unknown,
): string | null {
  if (
    !isValidDesignReview(review) ||
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["findingIds", "severity"]) ||
    (value.findingIds !== null && !Array.isArray(value.findingIds)) ||
    (value.severity !== null &&
      (typeof value.severity !== "string" ||
        !REVIEW_SEVERITIES.has(value.severity)))
  ) {
    return null;
  }
  let findingIds: Set<string> | null = null;
  if (Array.isArray(value.findingIds)) {
    if (
      value.findingIds.length > DESIGN_REVIEW_LIMITS.findings ||
      value.findingIds.some(
        (id) =>
          typeof id !== "string" ||
          id.trim().length === 0 ||
          id.length > DESIGN_REVIEW_LIMITS.findingIdLength,
      )
    ) {
      return null;
    }
    findingIds = new Set(value.findingIds as string[]);
    if (findingIds.size !== value.findingIds.length) {
      return null;
    }
  }
  const severity =
    value.severity === null
      ? null
      : (value.severity as ReviewFinding["severity"]);
  const findings = review.findings.filter(
    (finding) =>
      (findingIds === null || findingIds.has(finding.id)) &&
      (severity === null || finding.severity === severity),
  );
  return boundedToolOutput({
    summary: review.summary,
    findings,
  });
}

function exportOptionsToolOutput(value: unknown): string | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["format"]) ||
    (value.format !== null &&
      (typeof value.format !== "string" || !EXPORT_FORMATS.has(value.format)))
  ) {
    return null;
  }
  const format = value.format;
  return boundedToolOutput({
    formats:
      format === null
        ? DESIGN_MATE_EXPORT_OPTIONS_CATALOG.formats
        : DESIGN_MATE_EXPORT_OPTIONS_CATALOG.formats.filter(
            (candidate) => candidate.id === format,
          ),
    scopes: DESIGN_MATE_EXPORT_OPTIONS_CATALOG.scopes,
    notes: DESIGN_MATE_EXPORT_OPTIONS_CATALOG.notes,
  });
}

/**
 * Execute one model-requested read-only helper against already validated,
 * bounded prompt data. Null means the call must fail closed.
 */
export function executeDesignMateChatReadOnlyTool(
  toolName: string,
  value: unknown,
  review: DesignReview,
): string | null {
  if (toolName === DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME) {
    return inspectReviewToolOutput(review, value);
  }
  if (toolName === DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME) {
    return exportOptionsToolOutput(value);
  }
  return null;
}
