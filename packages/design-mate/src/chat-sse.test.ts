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
  type DesignMateChatProviderChunk,
  type DesignMateChatTransportEvent,
  type DesignMateChatTurnRequest,
  type DesignMateProposal,
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

function proposal(request = makeRequest()): DesignMateProposal {
  return {
    id: "remote-proposal",
    label: "Create icon variant",
    risk: "low",
    actions: [
      {
        type: "create-logo-variant",
        sourceArtboardId: request.document.activeArtboardId,
        purpose: "icon",
      },
    ],
  };
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
    if (chunk.type === "text-delta") {
      deltas.push(chunk.delta);
    }
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

  it("enforces cumulative stream and frame limits, including comments", () => {
    const tooManyFrames = createDesignMateChatSseDecoder();
    expect(() =>
      tooManyFrames.push(
        ":\n\n".repeat(DESIGN_MATE_CHAT_LIMITS.sseFrames + 1),
      ),
    ).toThrow(RangeError);

    const commentFrame = `:${"x".repeat(60 * 1_024)}\n\n`;
    const frameBytes = new TextEncoder().encode(commentFrame).byteLength;
    const framesToExceed =
      Math.floor(DESIGN_MATE_CHAT_LIMITS.sseStreamBytes / frameBytes) + 1;
    expect(framesToExceed).toBeLessThan(
      DESIGN_MATE_CHAT_LIMITS.sseFrames,
    );
    const tooManyBytes = createDesignMateChatSseDecoder();
    for (let index = 0; index < framesToExceed - 1; index += 1) {
      expect(tooManyBytes.push(commentFrame)).toEqual([]);
    }
    expect(() => tooManyBytes.push(commentFrame)).toThrow(RangeError);
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

  it("round-trips bounded proposal candidates", async () => {
    const event = {
      type: "proposal-candidate" as const,
      proposal: proposal(),
    };
    const decoded = await collectDecoded([
      new TextEncoder().encode(encodeDesignMateChatSseEvent(event)),
    ]);
    expect(decoded).toEqual([event]);
    expect(Object.isFrozen(decoded[0])).toBe(true);
    expect(
      decoded[0]?.type === "proposal-candidate" &&
        Object.isFrozen(decoded[0].proposal.actions),
    ).toBe(true);
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
    expect(capturedInit?.redirect).toBe("error");
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

  it("streams validated proposal candidates from the remote service", async () => {
    const request = makeRequest();
    const candidate = {
      type: "proposal-candidate" as const,
      proposal: proposal(request),
    };
    const provider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/design-mate/chat",
      fetch: vi.fn(
        async () =>
          sseResponse(
            [
              encodeDesignMateChatSseEvent(candidate),
              encodeDesignMateChatSseEvent({ type: "completed" }),
            ].join(""),
          ),
      ) as unknown as typeof fetch,
    });
    const chunks: DesignMateChatProviderChunk[] = [];
    for await (const chunk of provider.stream(request)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([candidate]);
  });

  it.each([
    [401, "authentication-required", false],
    [403, "origin-not-allowed", false],
    [408, "request-timeout", true],
    [413, "request-too-large", false],
    [429, "rate-limited", true],
    [502, "provider-failed", true],
    [504, "request-timeout", true],
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

  it("obtains a short-lived token and forwards the configured credentials mode", async () => {
    let capturedInit: RequestInit | undefined;
    const getAccessToken = vi.fn(async (_signal?: AbortSignal) => "session-token");
    const provider = createRemoteDesignMateChatProvider({
      endpoint: "https://example.test/chat",
      getAccessToken,
      credentials: "include",
      fetch: vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init;
          return sseResponse(
            [
              encodeDesignMateChatSseEvent({
                type: "text-delta",
                delta: "Authenticated guidance.",
              }),
              encodeDesignMateChatSseEvent({ type: "completed" }),
            ].join(""),
          );
        },
      ) as unknown as typeof fetch,
    });
    const controller = new AbortController();

    await expect(
      collectProvider(provider, makeRequest(), controller.signal),
    ).resolves.toBe("Authenticated guidance.");
    expect(getAccessToken).toHaveBeenCalledWith(controller.signal);
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(capturedInit?.credentials).toBe("include");
  });

  it("fails closed when an access-token callback fails or returns an unsafe value", async () => {
    for (const getAccessToken of [
      async () => {
        throw new Error("session unavailable");
      },
      async () => "token with spaces",
    ]) {
      const fetchMock = vi.fn() as unknown as typeof fetch;
      const provider = createRemoteDesignMateChatProvider({
        endpoint: "https://example.test/chat",
        getAccessToken,
        fetch: fetchMock,
      });
      await expect(
        captureProviderError(provider, makeRequest()),
      ).resolves.toMatchObject({
        code: "authentication-required",
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

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
