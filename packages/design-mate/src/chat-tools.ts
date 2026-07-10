import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateProposal,
} from "./contracts";
import { DESIGN_MATE_MUTATION_TOOLS } from "./actions";
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
  minLength: 1,
  maxLength: DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength,
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
        minLength: 1,
        maxLength: DESIGN_MATE_PROPOSAL_LIMITS.textContentLength,
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
        minLength: 4,
        maxLength: DESIGN_MATE_PROPOSAL_LIMITS.colorLength,
        pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
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
        minimum: DESIGN_MATE_PROPOSAL_LIMITS.minimumLetterSpacing,
        maximum: DESIGN_MATE_PROPOSAL_LIMITS.maximumLetterSpacing,
      },
    },
    required: ["type", "nodeId", "letterSpacing"],
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
  description: [
    "Submit one conservative logo change for explicit user preview and approval.",
    `Text: ${DESIGN_MATE_MUTATION_TOOLS["set-text-content"].description}`,
    `Fill: ${DESIGN_MATE_MUTATION_TOOLS["set-fill-color"].description}`,
    `Spacing: ${DESIGN_MATE_MUTATION_TOOLS["set-letter-spacing"].description}`,
    `Variant: ${DESIGN_MATE_MUTATION_TOOLS["create-logo-variant"].description}`,
    "Calling this tool never applies the change.",
  ].join(" "),
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: {
        type: "string",
        minLength: 1,
        maxLength: DESIGN_MATE_PROPOSAL_LIMITS.labelLength,
      },
      rationale: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: DESIGN_MATE_PROPOSAL_LIMITS.rationaleLength,
      },
      risk: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      sourceFindingIds: {
        type: ["array", "null"],
        maxItems: DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.sourceFindingIds,
        uniqueItems: true,
        items: referenceId,
      },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.actions,
        items: { anyOf: actionSchemas },
      },
    },
    required: [
      "label",
      "rationale",
      "risk",
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
        "risk",
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
        "risk",
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

    const proposal = snapshotValidDesignMateProposal({
      id: proposalId,
      label: snapshot.label,
      risk: snapshot.risk,
      actions: snapshot.actions,
      ...(snapshot.rationale === null
        ? {}
        : { rationale: snapshot.rationale }),
      ...(snapshot.sourceFindingIds === null
        ? {}
        : { sourceFindingIds: snapshot.sourceFindingIds }),
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
