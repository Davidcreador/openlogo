import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_MUTATION_TOOLS,
  DESIGN_MATE_CHAT_COLOR_CONTRAST_TOOL_NAME,
  DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
  DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
  DESIGN_MATE_CHAT_MODEL_TOOLS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_LIMITS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  executeDesignMateChatReadOnlyTool,
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

  it("publishes bounded read-only review and export tools", () => {
    expect(DESIGN_MATE_CHAT_MODEL_TOOLS.map((tool) => tool.name)).toEqual([
      DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
      DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
      DESIGN_MATE_CHAT_COLOR_CONTRAST_TOOL_NAME,
      DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
    ]);
    expect(Object.isFrozen(DESIGN_MATE_CHAT_MODEL_TOOLS)).toBe(true);
    expect(
      DESIGN_MATE_CHAT_MODEL_TOOLS.every(
        (tool) =>
          tool.strict &&
          tool.parameters.additionalProperties === false,
      ),
    ).toBe(true);

    const review = {
      summary: "Two findings",
      findings: [
        {
          id: "warning-finding",
          severity: "warning" as const,
          category: "geometry" as const,
          kind: "objective" as const,
          title: "Alignment",
          detail: "The centers differ.",
          action: "Align the lockup.",
          evidence: [{ label: "Delta", value: 8, unit: "px" }],
          suggestedActions: [
            { id: "align-lockup-centers", label: "Align the lockup." },
          ],
        },
        {
          id: "info-finding",
          severity: "info" as const,
          category: "variants" as const,
          kind: "objective" as const,
          title: "Variant",
          detail: "An icon is missing.",
          action: "Create an icon.",
          evidence: [{ label: "Icon artboards", value: 0 }],
          suggestedActions: [
            { id: "create-icon-variant", label: "Create an icon." },
          ],
        },
      ],
    };
    const filtered = executeDesignMateChatReadOnlyTool(
      DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
      { findingIds: null, severity: "warning" },
      review,
    );
    expect(JSON.parse(filtered!)).toMatchObject({
      summary: "Two findings",
      findings: [{ id: "warning-finding" }],
    });
    const png = executeDesignMateChatReadOnlyTool(
      DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
      { format: "png" },
      review,
    );
    expect(JSON.parse(png!).formats).toEqual([
      expect.objectContaining({ id: "png", transparency: true }),
    ]);
    expect(
      executeDesignMateChatReadOnlyTool(
        DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
        { findingIds: ["missing", "missing"], severity: null },
        review,
      ),
    ).toBeNull();
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

describe("Design Mate color contrast tool", () => {
  const review = { summary: "None", findings: [] };

  function contrast(value: unknown): string | null {
    return executeDesignMateChatReadOnlyTool(
      DESIGN_MATE_CHAT_COLOR_CONTRAST_TOOL_NAME,
      value,
      review,
    );
  }

  it("computes the WCAG ratio for black on white", () => {
    const output = JSON.parse(
      contrast({ foreground: "#000000", background: "#ffffff" })!,
    );
    expect(output.ratio).toBe(21);
    expect(output.wcag).toEqual({
      normalTextAA: true,
      largeTextAA: true,
      normalTextAAA: true,
    });
  });

  it("expands #RGB shorthand and flags weak pairings", () => {
    const output = JSON.parse(
      contrast({ foreground: "#777", background: "#888" })!,
    );
    expect(output.ratio).toBeLessThan(3);
    expect(output.wcag.largeTextAA).toBe(false);
    expect(output.guidance).toMatch(/Insufficient/);
  });

  it("returns a corrective payload for unparseable colors", () => {
    const output = JSON.parse(
      contrast({ foreground: "red", background: "#ffffff" })!,
    );
    expect(output.error).toMatch(/hex/i);
  });

  it("fails closed on structurally invalid arguments", () => {
    expect(contrast({ foreground: "#000" })).toBeNull();
    expect(
      contrast({ foreground: "#000", background: "#fff", extra: 1 }),
    ).toBeNull();
  });
});
