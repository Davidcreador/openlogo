import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it, vi } from "vitest";
import {
  DESIGN_MATE_CHAT_LIMITS,
  createDesignMateChatSseDecoder,
  createRemoteDesignMateChatProvider,
  decodeDesignMateChatSse,
  encodeDesignMateChatSseEvent,
  makeDesignMateProviderError,
  prepareDesignMateChatRequest,
  type DesignMateChatProvider,
  type DesignMateChatTransportEvent,
  type DesignMateChatTurnRequest,
  type DesignMateProviderError,
} from "./index";

function makeRequest(): DesignMateChatTurnRequest {
  const document = createInitialDocument();
  return prepareDesignMateChatRequest(
    document,
    { selectedNodeIds: [] },
    {
      conversationId: "conversation-sse",
      turnId: "turn-sse",
      assistantMessageId: "assistant-sse",
      history: [],
      userMessage: {
        id: "user-sse",
        role: "user",
        text: "Review this logo.",
        createdAt: "2026-07-10T20:00:00.000Z",
      },
      attachments: [],
    },
    { generation: 0, revision: 1 },
  );
}

async function collectDecoded(
  chunks: readonly Uint8Array[],
): Promise<readonly DesignMateChatTransportEvent[]> {
  const events: DesignMateChatTransportEvent[] = [];
  for await (const event of decodeDesignMateChatSse(chunks)) {
    events.push(event);
  }
  return events;
}

function sseResponse(payload: string): Response {
  const bytes = new TextEncoder().encode(payload);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function collectProvider(
  provider: DesignMateChatProvider,
  request: DesignMateChatTurnRequest,
  signal?: AbortSignal,
): Promise<string> {
  const deltas: string[] = [];
  for await (const chunk of provider.stream(request, signal)) {
    deltas.push(chunk.delta);
  }
  return deltas.join("");
}

async function captureProviderError(
  provider: DesignMateChatProvider,
  request: DesignMateChatTurnRequest,
  signal?: AbortSignal,
): Promise<DesignMateProviderError> {
  try {
    await collectProvider(provider, request, signal);
  } catch (cause) {
    return cause as DesignMateProviderError;
  }
  throw new Error("Expected the provider to fail.");
}

describe("Design Mate chat SSE codec", () => {
  it("handles split UTF-8 chunks, CRLF, comments, and multiple frames", async () => {
    const delta = encodeDesignMateChatSseEvent({
      type: "text-delta",
      delta: "Balance ✨",
    }).replace(/\n/g, "\r\n");
    const completed = encodeDesignMateChatSseEvent({ type: "completed" });
    const bytes = new TextEncoder().encode(
      `: heartbeat\r\n\r\n${delta}${completed}`,
    );
    const chunks = Array.from(bytes, (_, index) =>
      bytes.slice(index, index + 1),
    );

    await expect(collectDecoded(chunks)).resolves.toEqual([
      { type: "text-delta", delta: "Balance ✨" },
      { type: "completed" },
    ]);
  });

  it("fails closed on malformed, mismatched, and oversized frames", () => {
    const malformed = createDesignMateChatSseDecoder();
    expect(() => malformed.push("data: not-json\n\n")).toThrow(TypeError);

    const mismatched = createDesignMateChatSseDecoder();
    expect(() =>
      mismatched.push(
        'event: completed\ndata: {"type":"text-delta","delta":"x"}\n\n',
      ),
    ).toThrow(TypeError);

    const unknown = createDesignMateChatSseDecoder();
    expect(() =>
      unknown.push('data: {"type":"tool-call"}\n\n'),
    ).toThrow(TypeError);

    const oversized = createDesignMateChatSseDecoder();
    expect(() =>
      oversized.push(
        `data: ${"x".repeat(DESIGN_MATE_CHAT_LIMITS.sseFrameBytes)}`,
      ),
    ).toThrow(RangeError);
  });

  it("round-trips failed transport events", async () => {
    const error = makeDesignMateProviderError(
      "remote",
      "Temporary failure.",
      { code: "provider-failed", retryable: true },
    );
    const encoded = encodeDesignMateChatSseEvent({
      type: "failed",
      error,
    });
    const decoded = await collectDecoded([new TextEncoder().encode(encoded)]);
    expect(decoded).toEqual([{ type: "failed", error }]);
    expect(Object.isFrozen(decoded[0])).toBe(true);
  });
});

describe("remote Design Mate chat provider", () => {
  it("posts only the wire request and streams remote deltas", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return sseResponse(
          [
            encodeDesignMateChatSseEvent({
              type: "text-delta",
              delta: "Remote guidance.",
            }),
            encodeDesignMateChatSseEvent({ type: "completed" }),
          ].join(""),
        );
      },
    ) as unknown as typeof fetch;
    const provider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/design-mate/chat",
      fetch: fetchMock,
    });

    await expect(collectProvider(provider, makeRequest())).resolves.toBe(
      "Remote guidance.",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("accept")).toBe(
      "text/event-stream",
    );
    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("document");
    expect(body).toHaveProperty("context");
  });

  it.each([
    [429, "rate-limited", true],
    [400, "invalid-request", false],
    [503, "provider-failed", true],
  ] as const)(
    "maps HTTP %i to %s",
    async (status, code, retryable) => {
      const fetchMock = vi.fn(
        async () => new Response(null, { status }),
      ) as unknown as typeof fetch;
      const provider = createRemoteDesignMateChatProvider({
        endpoint: "https://example.test/chat",
        fetch: fetchMock,
      });

      const error = await captureProviderError(provider, makeRequest());
      expect(error).toMatchObject({ code, retryable });
    },
  );

  it("maps network failures, malformed SSE, and aborts distinctly", async () => {
    const networkProvider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/chat",
      fetch: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }) as unknown as typeof fetch,
    });
    await expect(
      captureProviderError(networkProvider, makeRequest()),
    ).resolves.toMatchObject({
      code: "provider-failed",
      retryable: true,
    });

    const malformedProvider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/chat",
      fetch: vi.fn(
        async () => sseResponse("data: not-json\n\n"),
      ) as unknown as typeof fetch,
    });
    await expect(
      captureProviderError(malformedProvider, makeRequest()),
    ).resolves.toMatchObject({
      code: "invalid-chat-response",
      retryable: false,
    });

    const missingContentTypeProvider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/chat",
      fetch: vi.fn(
        async () =>
          new Response(
            encodeDesignMateChatSseEvent({
              type: "text-delta",
              delta: "Untrusted response.",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    });
    await expect(
      captureProviderError(missingContentTypeProvider, makeRequest()),
    ).resolves.toMatchObject({
      code: "invalid-chat-response",
      retryable: false,
    });

    const fetchMock = vi.fn(
      async () => sseResponse(encodeDesignMateChatSseEvent({ type: "completed" })),
    ) as unknown as typeof fetch;
    const abortedProvider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/chat",
      fetch: fetchMock,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureProviderError(
        abortedProvider,
        makeRequest(),
        controller.signal,
      ),
    ).resolves.toMatchObject({
      code: "cancelled",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
