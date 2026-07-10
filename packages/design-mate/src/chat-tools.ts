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

export const DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME =
  "submit_design_mate_proposal";

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
    "Submit one conservative, preview-only logo change for explicit user approval. Supported actions edit text, solid fills, tracking, typography, opacity, existing solid strokes, selected-node position/scale/rotation/alignment/distribution, or clone one logo variant. Geometry must use visible selected ids from one artboard; scale and rotation use the selection centre. Never invent ids, key objects, strokes, or font families. Calling this tool never applies a change.",
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
