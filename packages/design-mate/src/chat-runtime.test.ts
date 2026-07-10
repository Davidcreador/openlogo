import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_CHAT_LIMITS,
  assembleDesignMateChatPrompt,
  assembleDesignMateChatWirePrompt,
  buildDocumentIdentity,
  createFakeDesignMateChatProvider,
  createFallbackDesignMateChatProvider,
  createHeuristicDesignMateChatProvider,
  makeDesignMateProviderError,
  orchestrateDesignMateChat,
  prepareDesignMateChatRequest,
  toDesignMateChatWireRequest,
  type DesignMateChatEvent,
  type DesignMateChatResult,
  type DesignMateChatTurnRequest,
  type DesignMateVisualAttachment,
} from "./index";

const CREATED_AT = "2026-07-10T20:00:00.000Z";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=";

function makeRequest(withImage = false): DesignMateChatTurnRequest {
  const document = createInitialDocument();
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
    expect(first.system).toContain("Bounded DesignContext JSON");
    expect(first.system).toContain("proposal approval pipeline");
    expect(first.system).toContain("untrusted design data");
    expect(first.system).not.toContain("RAW-NODE-MUST-NOT-LEAK");
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
  it("streams a concise local analysis without claiming canvas changes", async () => {
    const request = makeRequest();
    const provider = createHeuristicDesignMateChatProvider();
    const deltas: string[] = [];
    for await (const chunk of provider.stream(request)) {
      deltas.push(chunk.delta);
    }
    const response = deltas.join("");

    expect(response).toContain("Highest-priority findings");
    expect(response).toContain("No canvas changes were made");
    expect(response).toContain("proposal approval pipeline");
    expect(deltas.every((delta) => delta.length > 0)).toBe(true);
  });

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

  it("falls back only for retryable provider or rate-limit failures", async () => {
    const request = makeRequest();
    const fallback = createFakeDesignMateChatProvider({
      id: "fallback",
      chunks: [{ type: "text-delta", delta: "Fallback response." }],
    });
    const retryablePrimary = createFakeDesignMateChatProvider({
      id: "primary",
      error: makeDesignMateProviderError("primary", "Rate limited.", {
        code: "rate-limited",
        retryable: true,
      }),
    });
    const success = await drain(
      orchestrateDesignMateChat(
        request,
        createFallbackDesignMateChatProvider(retryablePrimary, fallback),
      ),
    );
    expect(success.result).toMatchObject({
      status: "completed",
      message: { text: "Fallback response." },
    });
    expect(fallback.requests).toHaveLength(1);

    const invalidFallback = createFakeDesignMateChatProvider({
      id: "unused-fallback",
      chunks: [{ type: "text-delta", delta: "Must not run." }],
    });
    const invalidPrimary = createFakeDesignMateChatProvider({
      id: "invalid-primary",
      error: makeDesignMateProviderError(
        "invalid-primary",
        "Invalid output.",
        { code: "invalid-chat-response", retryable: false },
      ),
    });
    const failed = await drain(
      orchestrateDesignMateChat(
        request,
        createFallbackDesignMateChatProvider(
          invalidPrimary,
          invalidFallback,
        ),
      ),
    );
    expect(failed.result).toMatchObject({
      status: "failed",
      error: { code: "invalid-chat-response" },
    });
    expect(invalidFallback.requests).toHaveLength(0);

    const partialFallback = createFakeDesignMateChatProvider({
      id: "unused-after-partial",
      chunks: [{ type: "text-delta", delta: "Must not append." }],
    });
    const partialPrimary = createFakeDesignMateChatProvider({
      id: "partial-primary",
      chunks: [{ type: "text-delta", delta: "Partial response." }],
      error: makeDesignMateProviderError(
        "partial-primary",
        "Disconnected after output.",
        { code: "provider-failed", retryable: true },
      ),
    });
    const partial = await drain(
      orchestrateDesignMateChat(
        request,
        createFallbackDesignMateChatProvider(
          partialPrimary,
          partialFallback,
        ),
      ),
    );
    expect(partial.result).toMatchObject({
      status: "failed",
      error: { code: "provider-failed" },
    });
    expect(partialFallback.requests).toHaveLength(0);
  });
});
