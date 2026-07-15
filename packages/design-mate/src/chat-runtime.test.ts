import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_CHAT_LIMITS,
  assembleDesignMateChatPrompt,
  assembleDesignMateChatWirePrompt,
  buildDocumentIdentity,
  createFakeDesignMateChatProvider,
  makeDesignMateProviderError,
  orchestrateDesignMateChat,
  prepareDesignMateChatRequest,
  toDesignMateChatWireRequest,
  type DesignMateChatEvent,
  type DesignMateChatResult,
  type DesignMateChatTurnRequest,
  type DesignMateProposal,
  type DesignMateVisualAttachment,
} from "./index";

const CREATED_AT = "2026-07-10T20:00:00.000Z";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=";

function makeRequest(withImage = false): DesignMateChatTurnRequest {
  const document = createInitialDocument();
  document.name = "UNTRUSTED_CONTEXT_SENTINEL";
  const nodeId = document.artboards[0]!.nodeIds[0]!;
  (
    document.nodes[nodeId] as unknown as Record<string, unknown>
  ).rawProviderSecret = "RAW-NODE-MUST-NOT-LEAK";
  const options = { generation: 2, revision: 7 } as const;
  const identity = buildDocumentIdentity(document, options);
  const padding = PNG_BASE64.endsWith("==")
    ? 2
    : PNG_BASE64.endsWith("=")
      ? 1
      : 0;
  const attachment: DesignMateVisualAttachment = {
    id: "visual-1",
    kind: "selection",
    mimeType: "image/png",
    dataBase64: PNG_BASE64,
    width: 32,
    height: 32,
    byteLength: (PNG_BASE64.length / 4) * 3 - padding,
    identity,
    label: "Selected mark",
  };
  return prepareDesignMateChatRequest(
    document,
    { selectedNodeIds: [nodeId] },
    {
      conversationId: "conversation-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-2",
      history: [
        {
          id: "user-1",
          role: "user",
          text: "What stands out?",
          createdAt: CREATED_AT,
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "The geometry is the strongest signal.",
          createdAt: "2026-07-10T20:00:01.000Z",
        },
      ],
      userMessage: {
        id: "user-2",
        role: "user",
        text: "Review the balance and scalability.",
        createdAt: "2026-07-10T20:00:02.000Z",
      },
      attachments: withImage ? [attachment] : [],
    },
    { ...options, scope: "selection" },
  );
}

function variantProposal(
  request: DesignMateChatTurnRequest,
  id = "chat-variant-proposal",
  purpose: "primary" | "icon" = "icon",
): DesignMateProposal {
  return {
    id,
    label: `Create ${purpose} variant`,
    risk: "low",
    rationale: "Prepare a focused logo-system variant for review.",
    actions: [
      {
        type: "create-logo-variant",
        sourceArtboardId: request.document.activeArtboardId,
        purpose,
      },
    ],
  };
}

async function drain(
  stream: AsyncGenerator<DesignMateChatEvent, DesignMateChatResult, void>,
): Promise<{
  readonly events: DesignMateChatEvent[];
  readonly result: DesignMateChatResult;
}> {
  const events: DesignMateChatEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

describe("chat prompt assembly", () => {
  it("is deterministic, multimodal, context-bounded, and document-free", () => {
    const request = makeRequest(true);
    const first = assembleDesignMateChatPrompt(request);
    const second = assembleDesignMateChatPrompt(request);
    const fromWire = assembleDesignMateChatWirePrompt(
      toDesignMateChatWireRequest(request),
    );

    expect(first).toEqual(second);
    expect(fromWire).toEqual(first);
    expect(first.system).toContain("logo-design expert");
    expect(first.system).toContain("proposal approval pipeline");
    expect(first.system).toContain("untrusted design data");
    expect(first.system).not.toContain("UNTRUSTED_CONTEXT_SENTINEL");
    expect(first.system).not.toContain("RAW-NODE-MUST-NOT-LEAK");
    expect(first.contextMessage.role).toBe("user");
    expect(first.contextMessage.text).toContain(
      "BEGIN_UNTRUSTED_DESIGN_CONTEXT",
    );
    expect(first.contextMessage.text).toContain(
      "Canonical bounded DesignContext JSON",
    );
    expect(first.contextMessage.text).toContain(
      "UNTRUSTED_CONTEXT_SENTINEL",
    );
    expect(first.contextMessage.text).toContain(
      "END_UNTRUSTED_DESIGN_CONTEXT",
    );
    expect(first.contextMessage.text).toContain(
      "BEGIN_UNTRUSTED_DESIGN_REVIEW",
    );
    expect(first.contextMessage.text).toContain(
      "BEGIN_UNTRUSTED_PROPOSAL_MEMORY",
    );
    expect(first.review).toEqual(request.review);
    expect(first.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(first.images).toHaveLength(1);
    expect(first.images[0]!.dataUrl).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    );
    expect(JSON.stringify(first)).not.toContain('"rawProviderSecret"');
    expect(Object.isFrozen(first.images[0])).toBe(true);
  });
});

describe("chat providers and orchestration", () => {
  it("emits stable success order, increasing indices, and a frozen message", async () => {
    const request = makeRequest();
    const provider = createFakeDesignMateChatProvider({
      chunks: [
        { type: "text-delta", delta: "First " },
        { type: "text-delta", delta: "second." },
      ],
    });
    const { events, result } = await drain(
      orchestrateDesignMateChat(request, provider),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "message-start",
      "text-delta",
      "text-delta",
      "message-end",
      "completed",
    ]);
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.index),
    ).toEqual([0, 1]);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("Expected completed chat result.");
    }
    expect(result.message.text).toBe("First second.");
    expect(Object.isFrozen(result.message)).toBe(true);
    expect(provider.requests).toEqual([request]);
    expect(
      events.filter(
        (event) =>
          event.type === "completed" ||
          event.type === "failed" ||
          event.type === "cancelled",
      ),
    ).toHaveLength(1);
  });

  it("prepares interleaved proposal candidates against the frozen turn snapshot", async () => {
    const request = makeRequest();
    const proposal = variantProposal(request);
    const provider = createFakeDesignMateChatProvider({
      chunks: [
        { type: "text-delta", delta: "I recommend " },
        { type: "proposal-candidate", proposal },
        { type: "text-delta", delta: "an icon variant." },
      ],
    });
    const { events, result } = await drain(
      orchestrateDesignMateChat(request, provider),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "message-start",
      "text-delta",
      "proposal-prepared",
      "text-delta",
      "message-end",
      "completed",
    ]);
    const prepared = events.find(
      (event) => event.type === "proposal-prepared",
    );
    expect(prepared).toMatchObject({
      type: "proposal-prepared",
      index: 0,
      prepared: {
        proposal: { id: proposal.id },
        command: { type: "batch" },
      },
    });
    expect(
      prepared?.type === "proposal-prepared" &&
        Object.isFrozen(prepared.prepared.previewDocument),
    ).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      message: { text: "I recommend an icon variant." },
      preparedProposals: [{ proposal: { id: proposal.id } }],
      rejectedProposals: [],
    });
  });

  it("completes proposal-only turns and reports safe preparation rejection", async () => {
    const request = makeRequest();
    const proposalOnly = await drain(
      orchestrateDesignMateChat(
        request,
        createFakeDesignMateChatProvider({
          chunks: [
            {
              type: "proposal-candidate",
              proposal: variantProposal(request),
            },
          ],
        }),
      ),
    );
    expect(proposalOnly.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "message-start",
      "proposal-prepared",
      "message-end",
      "completed",
    ]);
    expect(proposalOnly.result).toMatchObject({
      status: "completed",
      message: { text: expect.stringContaining("Nothing has been applied") },
    });

    const rejected = await drain(
      orchestrateDesignMateChat(
        request,
        createFakeDesignMateChatProvider({
          chunks: [
            {
              type: "proposal-candidate",
              proposal: variantProposal(request, "duplicate-primary", "primary"),
            },
          ],
        }),
      ),
    );
    expect(rejected.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "message-start",
      "proposal-rejected",
      "message-end",
      "completed",
    ]);
    expect(rejected.result).toMatchObject({
      status: "completed",
      preparedProposals: [],
      rejectedProposals: [
        {
          proposalId: "duplicate-primary",
          error: { code: "precondition-failed" },
        },
      ],
    });
  });

  it("rejects geometry outside the chat turn's frozen selection", async () => {
    const request = makeRequest();
    const unselectedId = request.document.artboards[0]!.nodeIds[1]!;
    const proposal: DesignMateProposal = {
      id: "unselected-geometry",
      label: "Move another object",
      risk: "medium",
      actions: [
        {
          type: "translate-nodes",
          nodeIds: [unselectedId],
          dx: 4,
          dy: 0,
        },
      ],
    };
    const { events, result } = await drain(
      orchestrateDesignMateChat(
        request,
        createFakeDesignMateChatProvider({
          chunks: [{ type: "proposal-candidate", proposal }],
        }),
      ),
    );

    expect(events.some((event) => event.type === "proposal-prepared")).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "proposal-rejected",
        proposalId: proposal.id,
        error: expect.objectContaining({ code: "precondition-failed" }),
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      preparedProposals: [],
      rejectedProposals: [
        {
          proposalId: proposal.id,
          error: { code: "precondition-failed" },
        },
      ],
    });
  });

  it("fails closed on duplicate or excessive proposal candidates", async () => {
    const request = makeRequest();
    const duplicate = variantProposal(request);
    const duplicateResult = await drain(
      orchestrateDesignMateChat(
        request,
        createFakeDesignMateChatProvider({
          chunks: [
            { type: "proposal-candidate", proposal: duplicate },
            { type: "proposal-candidate", proposal: duplicate },
          ],
        }),
      ),
    );
    expect(duplicateResult.result).toMatchObject({
      status: "failed",
      error: { code: "invalid-chat-response" },
    });
    expect(
      duplicateResult.events.some(
        (event) => event.type === "proposal-prepared",
      ),
    ).toBe(true);

    const excessiveResult = await drain(
      orchestrateDesignMateChat(
        request,
        createFakeDesignMateChatProvider({
          chunks: Array.from(
            { length: DESIGN_MATE_CHAT_LIMITS.proposalCandidates + 1 },
            (_, index) => ({
              type: "proposal-candidate" as const,
              proposal: variantProposal(request, `proposal-${index}`),
            }),
          ),
        }),
      ),
    );
    expect(excessiveResult.result).toMatchObject({
      status: "failed",
      error: { code: "invalid-chat-response" },
    });
    expect(
      excessiveResult.events.filter(
        (event) => event.type === "proposal-prepared",
      ),
    ).toHaveLength(DESIGN_MATE_CHAT_LIMITS.proposalCandidates);
  });

  it("fails closed on oversized output and invalid provider chunks", async () => {
    const request = makeRequest();
    const oversized = createFakeDesignMateChatProvider({
      chunks: Array.from({ length: 5 }, () => ({
        type: "text-delta" as const,
        delta: "x".repeat(DESIGN_MATE_CHAT_LIMITS.deltaTextLength),
      })),
    });
    const oversizedResult = await drain(
      orchestrateDesignMateChat(request, oversized),
    );
    expect(oversizedResult.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "invalid-chat-response" },
    });
    expect(oversizedResult.result.status).toBe("failed");

    const invalid = createFakeDesignMateChatProvider({
      chunks: [
        {
          type: "text-delta",
          delta: "",
        },
      ],
    });
    const invalidResult = await drain(
      orchestrateDesignMateChat(request, invalid),
    );
    expect(invalidResult.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "message-start",
      "failed",
    ]);
  });

  it("normalizes provider failures and preserves retry policy", async () => {
    const error = makeDesignMateProviderError(
      "failing-chat",
      "Temporary outage.",
      { code: "provider-failed", retryable: true },
    );
    const provider = createFakeDesignMateChatProvider({
      id: "failing-chat",
      error,
    });
    const { events, result } = await drain(
      orchestrateDesignMateChat(makeRequest(), provider),
    );

    expect(events.at(-1)).toEqual({ type: "failed", error });
    expect(result).toMatchObject({ status: "failed", error });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("cancels before provider start and between streamed chunks", async () => {
    const request = makeRequest();
    const beforeController = new AbortController();
    beforeController.abort();
    const beforeProvider = createFakeDesignMateChatProvider({
      chunks: [{ type: "text-delta", delta: "unused" }],
    });
    const before = await drain(
      orchestrateDesignMateChat(request, beforeProvider, {
        signal: beforeController.signal,
      }),
    );
    expect(before.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "cancelled",
    ]);
    expect(beforeProvider.requests).toHaveLength(0);
    expect(before.result.status).toBe("cancelled");

    const midController = new AbortController();
    const midProvider = createFakeDesignMateChatProvider({
      chunks: [
        { type: "text-delta", delta: "first" },
        { type: "text-delta", delta: "second" },
      ],
    });
    const stream = orchestrateDesignMateChat(request, midProvider, {
      signal: midController.signal,
    });
    const events: DesignMateChatEvent[] = [];
    for (let count = 0; count < 4; count += 1) {
      const next = await stream.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        events.push(next.value);
      }
    }
    expect(events.at(-1)?.type).toBe("text-delta");
    midController.abort();
    while (true) {
      const next = await stream.next();
      if (next.done) {
        expect(next.value.status).toBe("cancelled");
        break;
      }
      events.push(next.value);
    }
    expect(events.at(-1)?.type).toBe("cancelled");
    expect(events.some((event) => event.type === "message-end")).toBe(false);
  });

});
