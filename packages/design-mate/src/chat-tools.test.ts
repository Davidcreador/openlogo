import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_MUTATION_TOOLS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  snapshotDesignMateChatProposalToolArguments,
} from "./index";

function validArguments(): Record<string, unknown> {
  return {
    label: "Tighten the wordmark spacing",
    rationale: "A small spacing adjustment improves compact readability.",
    sourceFindingIds: null,
    actions: [
      {
        type: "set-letter-spacing",
        nodeId: "wordmark-node",
        letterSpacing: -1,
      },
    ],
  };
}

describe("Design Mate chat proposal tool", () => {
  it("publishes one deeply frozen strict function schema", () => {
    expect(DESIGN_MATE_CHAT_PROPOSAL_TOOL).toMatchObject({
      type: "function",
      name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: [
          "label",
          "rationale",
          "sourceFindingIds",
          "actions",
        ],
      },
    });
    expect(Object.isFrozen(DESIGN_MATE_CHAT_PROPOSAL_TOOL)).toBe(true);
    expect(
      Object.isFrozen(
        DESIGN_MATE_CHAT_PROPOSAL_TOOL.parameters.properties.actions,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(DESIGN_MATE_CHAT_PROPOSAL_TOOL),
    ).not.toContain('"command"');
    const schemas =
      DESIGN_MATE_CHAT_PROPOSAL_TOOL.parameters.properties.actions.items.anyOf;
    const actionTypes = schemas.map(
      (schema) => schema.properties.type.enum[0],
    );
    expect([...new Set(actionTypes)].sort()).toEqual(
      Object.keys(DESIGN_MATE_MUTATION_TOOLS).sort(),
    );
    expect(
      JSON.stringify(DESIGN_MATE_CHAT_PROPOSAL_TOOL),
    ).not.toMatch(
      /"(?:minLength|maxLength|pattern|format|minimum|maximum|multipleOf|minItems|maxItems|uniqueItems)"\s*:/,
    );
    expect(
      DESIGN_MATE_CHAT_PROPOSAL_TOOL.parameters.properties,
    ).not.toHaveProperty("risk");
  });

  it("assigns the caller-owned id and removes nullable optional fields", () => {
    const proposal = snapshotDesignMateChatProposalToolArguments(
      validArguments(),
      "service-owned-proposal-id",
    );

    expect(proposal).toEqual({
      id: "service-owned-proposal-id",
      label: "Tighten the wordmark spacing",
      rationale: "A small spacing adjustment improves compact readability.",
      risk: "medium",
      actions: [
        {
          type: "set-letter-spacing",
          nodeId: "wordmark-node",
          letterSpacing: -1,
        },
      ],
    });
    expect(Object.isFrozen(proposal)).toBe(true);

    const withoutRationale = snapshotDesignMateChatProposalToolArguments(
      { ...validArguments(), rationale: null },
      "proposal-without-rationale",
    );
    expect(withoutRationale).not.toHaveProperty("rationale");
  });

  it("fails closed on extra keys, invalid actions, and model-authored ids", () => {
    expect(
      snapshotDesignMateChatProposalToolArguments(
        { ...validArguments(), id: "model-controlled" },
        "service-owned",
      ),
    ).toBeNull();
    expect(
      snapshotDesignMateChatProposalToolArguments(
        {
          ...validArguments(),
          actions: [
            {
              type: "batch",
              commands: [],
            },
          ],
        },
        "service-owned",
      ),
    ).toBeNull();
    expect(
      snapshotDesignMateChatProposalToolArguments(
        {
          ...validArguments(),
          sourceFindingIds: ["duplicate", "duplicate"],
        },
        "service-owned",
      ),
    ).toBeNull();
    expect(
      snapshotDesignMateChatProposalToolArguments(
        {
          ...validArguments(),
          actions: Array.from(
            {
              length:
                DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS.actions + 1,
            },
            (_, index) => ({
              type: "set-letter-spacing",
              nodeId: `wordmark-${index}`,
              letterSpacing: index,
            }),
          ),
        },
        "service-owned",
      ),
    ).toBeNull();
  });

  it("accepts precision actions and enforces their cross-field rules", () => {
    const actions = [
      {
        type: "align-nodes",
        nodeIds: ["mark", "wordmark"],
        edge: "centerY",
        reference: "key-object",
        keyObjectId: "mark",
      },
      {
        type: "set-font-family",
        nodeId: "wordmark",
        fontFamily: "Space Grotesk",
      },
      {
        type: "set-stroke-width",
        nodeId: "mark",
        width: 3,
      },
    ];
    const result = snapshotDesignMateChatProposalToolArguments(
      { ...validArguments(), actions },
      "precision-id",
    );
    expect(result?.actions).toEqual(actions);
    expect(result?.risk).toBe("medium");

    expect(
      snapshotDesignMateChatProposalToolArguments(
        {
          ...validArguments(),
          actions: [
            {
              type: "align-nodes",
              nodeIds: ["mark", "wordmark"],
              edge: "centerY",
              reference: "key-object",
              keyObjectId: "missing",
            },
          ],
        },
        "invalid-key-object",
      ),
    ).toBeNull();
    expect(
      snapshotDesignMateChatProposalToolArguments(
        {
          ...validArguments(),
          actions: [
            {
              type: "set-opacity",
              nodeId: "mark",
              opacity: -0.1,
            },
          ],
        },
        "invalid-opacity",
      ),
    ).toBeNull();
  });
});
