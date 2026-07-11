import { describe, expect, it } from "vitest";
import {
  makeDesignMateProviderError,
  type DesignMateChatMessage,
  type DesignMateChatProvider,
  type DocumentIdentity,
} from "@openlogo/design-mate";
import {
  DESIGN_MATE_TRANSCRIPT_LIMIT,
  EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
  boundDesignMateChatHistory,
  createDesignMateChatId,
  createDesignMateChatProviderSetup,
  designMateChatHistoryFromTranscript,
  designMateConversationMemoryFromTranscript,
  designMateChatModeLabel,
  getDesignMateAccessToken,
  isDesignMateTranscriptNearBottom,
  isDesignMateChatAnswerStale,
  normalizeDesignMateServiceUrl,
  reduceDesignMateChatTranscript,
  resolveDesignMateChatEndpoint,
  setDesignMateAccessTokenProvider,
  type DesignMateChatAnswerContext,
  type DesignMateChatTranscriptState,
} from "./design-mate-chat";
import { createDesignMateRequestSignature } from "./design-mate-review";

const CREATED_AT = "2026-07-10T20:00:00.000Z";
const IDENTITY: DocumentIdentity = {
  documentId: "document-1",
  schemaVersion: 5,
  generation: 2,
  revision: 7,
  contentFingerprint: "fnv1a64-v1:1234567890abcdef",
};

function message(
  id: string,
  role: "user" | "assistant",
  text = id,
): DesignMateChatMessage {
  return { id, role, text, createdAt: CREATED_AT };
}

function provider(id: string): DesignMateChatProvider {
  return {
    id,
    stream: async function* () {
      yield { type: "text-delta", delta: id };
    },
  };
}

function startState(turnId = "turn-1"): DesignMateChatTranscriptState {
  return reduceDesignMateChatTranscript(EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT, {
    type: "start-turn",
    turnId,
    userMessage: message(`user-${turnId}`, "user", "Review this."),
    assistantMessage: message(`assistant-${turnId}`, "assistant", ""),
    providerLabel: "AI + local fallback",
    answerContext: {
      identity: IDENTITY,
      request: createDesignMateRequestSignature("selection", {
        selectedNodeIds: ["node-1"],
      }),
    },
  });
}

function context(
  identity: DocumentIdentity = IDENTITY,
  selectedNodeIds: readonly string[] = ["node-1"],
): DesignMateChatAnswerContext {
  return {
    identity,
    request: createDesignMateRequestSignature("selection", {
      selectedNodeIds,
    }),
  };
}

function appendCompleteTurn(
  state: DesignMateChatTranscriptState,
  turnId: string,
  answerContext: DesignMateChatAnswerContext = context(),
): DesignMateChatTranscriptState {
  let next = reduceDesignMateChatTranscript(state, {
    type: "start-turn",
    turnId,
    userMessage: message(`user-${turnId}`, "user", `Question ${turnId}`),
    assistantMessage: message(`assistant-${turnId}`, "assistant", ""),
    providerLabel: "Local guidance",
    answerContext,
  });
  next = reduceDesignMateChatTranscript(next, {
    type: "stream-event",
    turnId,
    event: {
      type: "message-start",
      messageId: `assistant-${turnId}`,
      role: "assistant",
      createdAt: CREATED_AT,
    },
  });
  const answer = message(
    `assistant-${turnId}`,
    "assistant",
    `Answer ${turnId}`,
  );
  next = reduceDesignMateChatTranscript(next, {
    type: "stream-event",
    turnId,
    event: { type: "message-end", message: answer },
  });
  return reduceDesignMateChatTranscript(next, {
    type: "stream-event",
    turnId,
    event: { type: "completed", message: answer },
  });
}

describe("Design Mate service URL configuration", () => {
  it("accepts same-origin paths, HTTPS, and loopback HTTP", () => {
    expect(normalizeDesignMateServiceUrl("/design-mate/")).toBe(
      "/design-mate/",
    );
    expect(normalizeDesignMateServiceUrl("./design-mate")).toBe(
      "/design-mate",
    );
    expect(normalizeDesignMateServiceUrl("https://ai.example.test/base")).toBe(
      "https://ai.example.test/base",
    );
    expect(normalizeDesignMateServiceUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/",
    );
    expect(normalizeDesignMateServiceUrl("http://127.8.9.10:8787")).toBe(
      "http://127.8.9.10:8787/",
    );
    expect(normalizeDesignMateServiceUrl("http://[::1]:8787")).toBe(
      "http://[::1]:8787/",
    );
  });

  it("rejects insecure remote, credentialed, fragmented, and invalid values", () => {
    for (const value of [
      "http://example.test",
      "https://user:secret@example.test",
      "https://example.test/path#fragment",
      "//example.test/path",
      "javascript:alert(1)",
      "https://exa mple.test",
      `https://example.test/${"x".repeat(2_100)}`,
      "",
      null,
    ]) {
      expect(normalizeDesignMateServiceUrl(value)).toBeNull();
    }
  });

  it("resolves the fixed service route without duplicating it", () => {
    expect(resolveDesignMateChatEndpoint("/proxy")).toBe(
      "/proxy/v1/design-mate/chat",
    );
    expect(resolveDesignMateChatEndpoint("/v1/design-mate/chat")).toBe(
      "/v1/design-mate/chat",
    );
    expect(
      resolveDesignMateChatEndpoint("https://ai.example.test/service/"),
    ).toBe("https://ai.example.test/service/v1/design-mate/chat");
  });
});

describe("Design Mate chat provider setup", () => {
  it("uses local-only mode without an endpoint and package fallback with one", () => {
    const calls: string[] = [];
    let receivedTokenProvider:
      | ((signal?: AbortSignal) => string | null | Promise<string | null>)
      | undefined;
    const factories = {
      createRemote: ({
        endpoint,
        getAccessToken,
      }: {
        readonly endpoint: string;
        readonly getAccessToken?: (
          signal?: AbortSignal,
        ) => string | null | Promise<string | null>;
      }) => {
        receivedTokenProvider = getAccessToken;
        calls.push(`remote:${endpoint}`);
        return provider("remote");
      },
      createLocal: () => {
        calls.push("local");
        return provider("local");
      },
      createFallback: (
        primary: DesignMateChatProvider,
        fallback: DesignMateChatProvider,
      ) => {
        calls.push(`fallback:${primary.id}:${fallback.id}`);
        return provider(`${primary.id}+${fallback.id}`);
      },
    };

    const local = createDesignMateChatProviderSetup(null, factories);
    expect(local).toMatchObject({ mode: "local", provider: { id: "local" } });
    expect(designMateChatModeLabel(local.mode)).toBe("Local guidance");
    expect(calls).toEqual(["local"]);

    calls.length = 0;
    const remote = createDesignMateChatProviderSetup(
      "/v1/design-mate/chat",
      factories,
      { getAccessToken: () => "short-lived-token" },
    );
    expect(remote).toMatchObject({
      mode: "remote-with-fallback",
      provider: { id: "remote+local" },
    });
    expect(designMateChatModeLabel(remote.mode)).toBe("AI + local fallback");
    expect(calls).toEqual([
      "local",
      "remote:/v1/design-mate/chat",
      "fallback:remote:local",
    ]);
    expect(receivedTokenProvider?.()).toBe("short-lived-token");
  });

  it("keeps only the host token callback in memory", async () => {
    const tokenProvider = async () => "runtime-token";
    setDesignMateAccessTokenProvider(tokenProvider);
    await expect(getDesignMateAccessToken()).resolves.toBe("runtime-token");
    setDesignMateAccessTokenProvider(null);
    expect(getDesignMateAccessToken()).toBeNull();
    expect(() =>
      setDesignMateAccessTokenProvider(
        "not-a-function" as unknown as () => string,
      ),
    ).toThrow(TypeError);
  });
});

describe("Design Mate transcript helpers", () => {
  it("keeps a bounded proposal outcome ledger for follow-up turns", () => {
    let state = startState();
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "message-start",
        messageId: "assistant-turn-1",
        role: "assistant",
        createdAt: CREATED_AT,
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "proposal-rejected",
        messageId: "assistant-turn-1",
        index: 0,
        proposalId: "proposal-1",
        error: {
          _tag: "DesignMateProposalError",
          code: "precondition-failed",
          message: "The target changed.",
        },
      },
    });
    const answer = message(
      "assistant-turn-1",
      "assistant",
      "That suggestion is no longer safe.",
    );
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: { type: "message-end", message: answer },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: { type: "completed", message: answer },
    });

    expect(designMateConversationMemoryFromTranscript(state.entries)).toEqual([
      {
        id: "turn-1:rejected:0",
        proposalId: "proposal-1",
        label: "Rejected suggestion",
        status: "rejected",
        summary: "The target changed.",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("records applied and dismissed outcomes on the originating assistant turn", () => {
    const prepared = {
      id: "memory-prepared",
      proposalId: "proposal-outcome",
      label: "Refine spacing",
      status: "prepared" as const,
      summary: "Adjust the spacing.",
      createdAt: CREATED_AT,
    };
    let state = reduceDesignMateChatTranscript(
      EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
      {
        type: "restore",
        entries: [
          {
            ...message("assistant-outcome", "assistant", "Try this."),
            status: "complete",
            memory: [prepared],
          },
        ],
      },
    );
    state = reduceDesignMateChatTranscript(state, {
      type: "proposal-outcome",
      event: {
        ...prepared,
        id: "memory-applied",
        status: "applied",
        createdAt: "2026-07-10T20:00:01.000Z",
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "proposal-outcome",
      event: {
        ...prepared,
        id: "memory-dismissed",
        status: "dismissed",
        createdAt: "2026-07-10T20:00:02.000Z",
      },
    });

    expect(
      designMateConversationMemoryFromTranscript(state.entries).map(
        (event) => event.status,
      ),
    ).toEqual(["prepared", "applied", "dismissed"]);
  });

  it("retains a bounded outcome when its prepared event is unavailable", () => {
    const complete = appendCompleteTurn(
      EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
      "fallback-outcome",
    );
    const event = {
      id: "memory-fallback-applied",
      proposalId: "proposal-fallback",
      label: "Refine spacing",
      status: "applied" as const,
      summary: "Adjusted spacing.",
      createdAt: "2026-07-10T20:00:01.000Z",
    };
    const recorded = reduceDesignMateChatTranscript(complete, {
      type: "proposal-outcome",
      event,
    });

    expect(recorded.entries.at(-1)?.memory).toEqual([event]);
    expect(
      reduceDesignMateChatTranscript(recorded, {
        type: "proposal-outcome",
        event,
      }),
    ).toBe(recorded);
  });

  it("does not attribute a proposal outcome while another turn is active", () => {
    const active = startState();
    expect(
      reduceDesignMateChatTranscript(active, {
        type: "proposal-outcome",
        event: {
          id: "memory-active-applied",
          proposalId: "proposal-active",
          label: "Refine spacing",
          status: "applied",
          summary: "Adjusted spacing.",
          createdAt: "2026-07-10T20:00:01.000Z",
        },
      }),
    ).toBe(active);
  });

  it("bounds history in complete pairs and drops duplicate ids", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      message(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
      ),
    );
    const bounded = boundDesignMateChatHistory([
      ...messages,
      message("message-28", "user", "duplicate"),
      message("duplicate-assistant", "assistant"),
    ]);
    expect(bounded).toHaveLength(24);
    expect(bounded[0]!.id).toBe("message-6");
    expect(new Set(bounded.map((item) => item.id)).size).toBe(24);
    expect(
      bounded.every(
        (item, index) => item.role === (index % 2 === 0 ? "user" : "assistant"),
      ),
    ).toBe(true);
  });

  it("excludes both messages in trailing failed or cancelled retry turns", () => {
    let state = appendCompleteTurn(
      EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
      "complete",
    );
    state = reduceDesignMateChatTranscript(state, {
      type: "start-turn",
      turnId: "retry",
      userMessage: message("user-retry", "user", "Try this again."),
      assistantMessage: message("assistant-retry", "assistant", ""),
      providerLabel: "AI + local fallback",
      answerContext: context(),
    });
    const failed = reduceDesignMateChatTranscript(startState(), {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "failed",
        error: makeDesignMateProviderError("remote", "offline", {
          code: "provider-failed",
          retryable: true,
        }),
      },
    });
    expect(designMateChatHistoryFromTranscript(failed.entries, context())).toEqual(
      [],
    );

    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "retry",
      event: {
        type: "failed",
        error: makeDesignMateProviderError("remote", "offline", {
          code: "provider-failed",
          retryable: true,
        }),
      },
    });
    expect(designMateChatHistoryFromTranscript(state.entries, context())).toEqual([
      expect.objectContaining({ id: "user-complete", role: "user" }),
      expect.objectContaining({
        id: "assistant-complete",
        role: "assistant",
      }),
    ]);

    let cancelled = reduceDesignMateChatTranscript(
      appendCompleteTurn(EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT, "before-cancel"),
      {
        type: "start-turn",
        turnId: "cancelled-retry",
        userMessage: message("user-cancelled-retry", "user", "Try again."),
        assistantMessage: message(
          "assistant-cancelled-retry",
          "assistant",
          "",
        ),
        providerLabel: "AI + local fallback",
        answerContext: context(),
      },
    );
    cancelled = reduceDesignMateChatTranscript(cancelled, {
      type: "stream-event",
      turnId: "cancelled-retry",
      event: {
        type: "cancelled",
        error: makeDesignMateProviderError("remote", "cancelled", {
          code: "cancelled",
        }),
      },
    });
    expect(
      designMateChatHistoryFromTranscript(cancelled.entries, context()).map(
        (entry) => entry.id,
      ),
    ).toEqual(["user-before-cancel", "assistant-before-cancel"]);
  });

  it("keeps only the contiguous recent suffix for the exact current context", () => {
    const staleIdentity = { ...IDENTITY, revision: IDENTITY.revision - 1 };
    let state = appendCompleteTurn(
      EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
      "old",
      context(),
    );
    state = appendCompleteTurn(
      state,
      "stale-divider",
      context(staleIdentity),
    );
    state = appendCompleteTurn(state, "current", context());

    expect(
      designMateChatHistoryFromTranscript(state.entries, context()).map(
        (entry) => entry.id,
      ),
    ).toEqual(["user-current", "assistant-current"]);
    expect(
      designMateChatHistoryFromTranscript(
        state.entries,
        context({ ...IDENTITY, revision: IDENTITY.revision + 1 }),
      ),
    ).toEqual([]);
    expect(
      designMateChatHistoryFromTranscript(
        state.entries,
        context(IDENTITY, ["node-2"]),
      ),
    ).toEqual([]);
    expect(
      designMateChatHistoryFromTranscript(state.entries, {
        identity: IDENTITY,
        request: createDesignMateRequestSignature("active-artboard", {
          selectedNodeIds: ["node-1"],
        }),
      }),
    ).toEqual([]);
  });

  it("keeps ordered partial text on failure and ignores out-of-order deltas", () => {
    let state = startState();
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "message-start",
        messageId: "assistant-turn-1",
        role: "assistant",
        createdAt: CREATED_AT,
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "text-delta",
        messageId: "assistant-turn-1",
        index: 1,
        delta: "ignored",
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "text-delta",
        messageId: "assistant-turn-1",
        index: 0,
        delta: "Partial answer",
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "failed",
        error: makeDesignMateProviderError("remote", "disconnected", {
          code: "provider-failed",
          retryable: true,
        }),
      },
    });

    expect(state.activeTurn).toBeNull();
    expect(state.entries.at(-1)).toMatchObject({
      text: "Partial answer",
      status: "failed",
      errorLabel: "Design Mate could not finish this response. Try again.",
    });
  });

  it("handles cancellation and finalizes message-end/completed idempotently", () => {
    const cancelled = reduceDesignMateChatTranscript(startState(), {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "cancelled",
        error: makeDesignMateProviderError("remote", "cancelled", {
          code: "cancelled",
        }),
      },
    });
    expect(cancelled.entries.at(-1)).toMatchObject({
      status: "cancelled",
      errorLabel: "Response stopped.",
    });

    let state = startState();
    const completeMessage = message(
      "assistant-turn-1",
      "assistant",
      "Complete answer.",
    );
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: {
        type: "message-start",
        messageId: "assistant-turn-1",
        role: "assistant",
        createdAt: CREATED_AT,
      },
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: { type: "message-end", message: completeMessage },
    });
    expect(state.activeTurn).not.toBeNull();
    expect(state.entries.at(-1)).toMatchObject({
      status: "complete",
      text: "Complete answer.",
    });
    state = reduceDesignMateChatTranscript(state, {
      type: "stream-event",
      turnId: "turn-1",
      event: { type: "completed", message: completeMessage },
    });
    expect(state.activeTurn).toBeNull();
    expect(state.entries.at(-1)?.text).toBe("Complete answer.");
  });

  it("bounds the visible transcript while retaining whole turn pairs", () => {
    let state = EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT;
    for (let index = 0; index < 30; index += 1) {
      const turnId = `turn-${index}`;
      state = reduceDesignMateChatTranscript(state, {
        type: "start-turn",
        turnId,
        userMessage: message(`user-${index}`, "user"),
        assistantMessage: message(`assistant-${index}`, "assistant", ""),
        providerLabel: "Local guidance",
        answerContext: {
          identity: IDENTITY,
          request: createDesignMateRequestSignature("active-artboard", {
            selectedNodeIds: [],
          }),
        },
      });
      state = reduceDesignMateChatTranscript(state, {
        type: "stream-event",
        turnId,
        event: {
          type: "message-start",
          messageId: `assistant-${index}`,
          role: "assistant",
          createdAt: CREATED_AT,
        },
      });
      state = reduceDesignMateChatTranscript(state, {
        type: "stream-event",
        turnId,
        event: {
          type: "message-end",
          message: message(`assistant-${index}`, "assistant", "Done."),
        },
      });
      state = reduceDesignMateChatTranscript(state, {
        type: "stream-event",
        turnId,
        event: {
          type: "completed",
          message: message(`assistant-${index}`, "assistant", "Done."),
        },
      });
    }
    expect(state.entries).toHaveLength(DESIGN_MATE_TRANSCRIPT_LIMIT);
    expect(state.entries[0]!.id).toBe("user-6");
    expect(state.entries.at(-1)!.id).toBe("assistant-29");
  });

  it("uses full identity and request signatures for staleness", () => {
    const answer = {
      identity: IDENTITY,
      request: createDesignMateRequestSignature("selection", {
        selectedNodeIds: ["node-1"],
      }),
    };
    expect(
      isDesignMateChatAnswerStale(
        answer,
        { ...IDENTITY },
        createDesignMateRequestSignature("selection", {
          selectedNodeIds: ["node-1"],
        }),
      ),
    ).toBe(false);
    expect(
      isDesignMateChatAnswerStale(
        answer,
        { ...IDENTITY, contentFingerprint: "different" },
        answer.request,
      ),
    ).toBe(true);
    expect(
      isDesignMateChatAnswerStale(
        answer,
        IDENTITY,
        createDesignMateRequestSignature("selection", {
          selectedNodeIds: ["node-2"],
        }),
      ),
    ).toBe(true);
  });

  it("generates bounded unique ids", () => {
    const first = createDesignMateChatId("User message");
    const second = createDesignMateChatId("User message");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^user-message-/);
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it("sticks only while the transcript is near its bottom", () => {
    expect(
      isDesignMateTranscriptNearBottom({
        scrollHeight: 500,
        clientHeight: 200,
        scrollTop: 265,
      }),
    ).toBe(true);
    expect(
      isDesignMateTranscriptNearBottom({
        scrollHeight: 500,
        clientHeight: 200,
        scrollTop: 200,
      }),
    ).toBe(false);
    expect(
      isDesignMateTranscriptNearBottom({
        scrollHeight: 120,
        clientHeight: 200,
        scrollTop: 0,
      }),
    ).toBe(true);
  });
});
