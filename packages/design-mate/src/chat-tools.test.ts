import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_CHAT_PROPOSAL_TOOL,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  snapshotDesignMateChatProposalToolArguments,
} from "./index";

function validArguments(): Record<string, unknown> {
  return {
    label: "Tighten the wordmark spacing",
    rationale: "A small spacing adjustment improves compact readability.",
    risk: "medium",
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
          "risk",
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
});
