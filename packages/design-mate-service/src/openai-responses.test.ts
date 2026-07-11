import {
  DESIGN_MATE_CHAT_LIMITS,
  DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
  DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  type DesignMateChatPrompt,
  type DesignMateChatProviderChunk,
  type DesignMateProviderError,
} from "@openlogo/design-mate";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIResponsesTransport,
  type DesignMateModelTransport,
} from "./index";

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function prompt(): DesignMateChatPrompt {
  return Object.freeze({
    system: "INSTRUCTIONS_CONTEXT_SENTINEL",
    contextMessage: Object.freeze({
      role: "user" as const,
      text: "UNTRUSTED_CONTEXT_SENTINEL",
    }),
    messages: Object.freeze([
      Object.freeze({ role: "user" as const, text: "Earlier question" }),
      Object.freeze({
        role: "assistant" as const,
        text: "Earlier answer",
      }),
      Object.freeze({ role: "user" as const, text: "Current question" }),
    ]),
    images: Object.freeze([
      Object.freeze({
        id: "image-1",
        role: "user" as const,
        kind: "selection" as const,
        mimeType: "image/png" as const,
        dataUrl: IMAGE_DATA_URL,
        width: 32,
        height: 32,
      }),
    ]),
    review: {
      summary: "Review summary",
      findings: [],
    },
  });
}

function sseResponse(
  frames: string,
  options: { readonly splitEveryByte?: boolean } = {},
): Response {
  const bytes = new TextEncoder().encode(frames);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.splitEveryByte) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function frame(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function transport(
  fetchImplementation: typeof fetch,
): DesignMateModelTransport {
  return createOpenAIResponsesTransport({
    apiKey: "API_KEY_SECRET_SENTINEL",
    baseUrl: "https://provider.example/v1/",
    model: "required-model",
    imageDetail: "low",
    maxOutputTokens: 1_234,
    fetch: fetchImplementation,
  });
}

async function collect(
  modelTransport: DesignMateModelTransport,
  signal?: AbortSignal,
): Promise<string> {
  const deltas: string[] = [];
  for await (const chunk of modelTransport.stream(prompt(), signal)) {
    if (chunk.type === "text-delta") {
      deltas.push(chunk.delta);
    }
  }
  return deltas.join("");
}

async function collectChunks(
  modelTransport: DesignMateModelTransport,
): Promise<readonly DesignMateChatProviderChunk[]> {
  const chunks: DesignMateChatProviderChunk[] = [];
  for await (const chunk of modelTransport.stream(prompt())) {
    chunks.push(chunk);
  }
  return chunks;
}

function proposalArguments(): Record<string, unknown> {
  return {
    label: "Create an icon variant",
    rationale: "A square variant improves small-size usage.",
    sourceFindingIds: null,
    actions: [
      {
        type: "create-logo-variant",
        sourceArtboardId: "artboard-primary",
        purpose: "icon",
      },
    ],
  };
}

async function captureError(
  modelTransport: DesignMateModelTransport,
  signal?: AbortSignal,
): Promise<DesignMateProviderError> {
  try {
    await collect(modelTransport, signal);
  } catch (cause) {
    return cause as DesignMateProviderError;
  }
  throw new Error("Expected transport failure.");
}

describe("OpenAI Responses model transport", () => {
  it("sends the required multimodal schema without a raw wire request", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return sseResponse(
          [
            frame("response.output_text.delta", { delta: "Guidance." }),
            frame("response.completed", { response: { status: "completed" } }),
          ].join(""),
        );
      },
    ) as unknown as typeof fetch;

    await expect(collect(transport(fetchMock))).resolves.toBe("Guidance.");
    expect(capturedUrl).toBe("https://provider.example/v1/responses");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(
      "Bearer API_KEY_SECRET_SENTINEL",
    );
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String(capturedInit?.body)) as {
      readonly model: string;
      readonly instructions: string;
      readonly max_output_tokens: number;
      readonly input: readonly {
        readonly role: string;
        readonly content: readonly Record<string, unknown>[];
      }[];
      readonly stream: boolean;
      readonly store: boolean;
      readonly tool_choice: string;
      readonly parallel_tool_calls: boolean;
      readonly tools: readonly {
        readonly type: string;
        readonly name: string;
        readonly strict: boolean;
      }[];
    };
    expect(body).toMatchObject({
      model: "required-model",
      instructions: "INSTRUCTIONS_CONTEXT_SENTINEL",
      max_output_tokens: 1_234,
      stream: true,
      store: false,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body.tools.map((tool) => tool.name)).toEqual([
      DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
      DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
      DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
    ]);
    expect(
      body.tools.every(
        (tool) => tool.type === "function" && tool.strict === true,
      ),
    ).toBe(true);
    expect(capturedInit?.redirect).toBe("error");
    expect(body.input.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.input[0]?.content).toEqual([
      { type: "input_text", text: "UNTRUSTED_CONTEXT_SENTINEL" },
    ]);
    expect(body.input[1]?.content).toEqual([
      { type: "input_text", text: "Earlier question" },
    ]);
    expect(body.input.at(-1)?.content).toEqual([
      { type: "input_text", text: "Current question" },
      {
        type: "input_image",
        image_url: IMAGE_DATA_URL,
        detail: "low",
      },
    ]);
    expect(body).not.toHaveProperty("context");
    expect(body).not.toHaveProperty("identity");
    expect(body).not.toHaveProperty("selection");
    expect(body).not.toHaveProperty("attachments");
  });

  it("handles official Responses events split at arbitrary byte boundaries", async () => {
    const payload = [
      frame("response.created", { response: { status: "in_progress" } }),
      frame("response.output_text.delta", { delta: "Balance ✨" }),
      frame("response.output_text.delta", { delta: " and rhythm." }),
      frame("response.completed", { response: { status: "completed" } }),
    ].join("");
    const fetchMock = vi.fn(
      async () => sseResponse(payload, { splitEveryByte: true }),
    ) as unknown as typeof fetch;

    await expect(collect(transport(fetchMock))).resolves.toBe(
      "Balance ✨ and rhythm.",
    );
  });

  it("streams a validated proposal from official function-call events without text", async () => {
    const argumentsJson = JSON.stringify(proposalArguments());
    const payload = [
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "function-call-1",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.delta", {
        item_id: "function-call-1",
        output_index: 0,
        delta: argumentsJson,
      }),
      frame("response.function_call_arguments.done", {
        item_id: "function-call-1",
        output_index: 0,
        arguments: argumentsJson,
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: "function-call-1",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: argumentsJson,
        },
      }),
      frame("response.completed", {
        response: { status: "completed" },
      }),
    ].join("");
    const fetchMock = vi.fn(
      async () => sseResponse(payload),
    ) as unknown as typeof fetch;

    const chunks = await collectChunks(transport(fetchMock));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "proposal-candidate",
      proposal: {
        id: expect.stringMatching(/^chat-proposal-/),
        label: "Create an icon variant",
        actions: [
          {
            type: "create-logo-variant",
            sourceArtboardId: "artboard-primary",
            purpose: "icon",
          },
        ],
      },
    });
    expect(
      chunks[0]?.type === "proposal-candidate" &&
        Object.isFrozen(chunks[0].proposal),
    ).toBe(true);
  });

  it("accepts item-wrapped final arguments and optional output-item names", async () => {
    const argumentsJson = JSON.stringify(proposalArguments());
    const payload = [
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "function-call-wrapped",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.done", {
        output_index: 0,
        item: {
          id: "function-call-wrapped",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: argumentsJson,
        },
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: "function-call-wrapped",
          type: "function_call",
          arguments: argumentsJson,
        },
      }),
      frame("response.completed", {
        response: { status: "completed" },
      }),
    ].join("");
    const candidate = transport(
      vi.fn(async () => sseResponse(payload)) as unknown as typeof fetch,
    );
    await expect(collectChunks(candidate)).resolves.toEqual([
      expect.objectContaining({ type: "proposal-candidate" }),
    ]);
  });

  it("keeps useful text when runtime validation rejects tool arguments", async () => {
    const argumentsJson = JSON.stringify({
      ...proposalArguments(),
      actions: [],
    });
    const payload = [
      frame("response.output_text.delta", {
        delta: "Keep the optical spacing subtle.",
      }),
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "function-call-rejected",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.done", {
        item_id: "function-call-rejected",
        output_index: 0,
        arguments: argumentsJson,
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: "function-call-rejected",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: argumentsJson,
        },
      }),
      frame("response.completed", {
        response: { status: "completed" },
      }),
    ].join("");
    const candidate = transport(
      vi.fn(async () => sseResponse(payload)) as unknown as typeof fetch,
    );

    await expect(collectChunks(candidate)).resolves.toEqual([
      {
        type: "text-delta",
        delta: "Keep the optical spacing subtle.",
      },
    ]);
  });

  it("executes a bounded read-only review tool before continuing the answer", async () => {
    const argumentsJson = JSON.stringify({
      findingIds: null,
      severity: null,
    });
    const firstStep = [
      frame("response.output_text.delta", { delta: "Checking the review. " }),
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "review-call-item",
          call_id: "review-call",
          type: "function_call",
          name: DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.done", {
        item_id: "review-call-item",
        output_index: 0,
        name: DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
        arguments: argumentsJson,
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: "review-call-item",
          call_id: "review-call",
          type: "function_call",
          name: DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
          arguments: argumentsJson,
        },
      }),
      frame("response.completed", { response: { status: "completed" } }),
    ].join("");
    const secondStep = [
      frame("response.output_text.delta", { delta: "The structure is clean." }),
      frame("response.completed", { response: { status: "completed" } }),
    ].join("");
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return sseResponse(
          requestBodies.length === 1 ? firstStep : secondStep,
        );
      },
    ) as unknown as typeof fetch;

    await expect(collect(transport(fetchMock))).resolves.toBe(
      "Checking the review. The structure is clean.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInput = requestBodies[1]?.input as readonly Record<
      string,
      unknown
    >[];
    expect(secondInput.slice(-2)).toEqual([
      {
        type: "function_call",
        call_id: "review-call",
        name: DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
        arguments: argumentsJson,
      },
      expect.objectContaining({
        type: "function_call_output",
        call_id: "review-call",
        output: expect.stringContaining('"summary":"Review summary"'),
      }),
    ]);
  });

  it("turns a rejected proposal-only call into safe user guidance", async () => {
    const argumentsJson = JSON.stringify({
      ...proposalArguments(),
      actions: [],
    });
    const payload = [
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "rejected-only",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.done", {
        item_id: "rejected-only",
        output_index: 0,
        arguments: argumentsJson,
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: "rejected-only",
          type: "function_call",
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: argumentsJson,
        },
      }),
      frame("response.completed", { response: { status: "completed" } }),
    ].join("");
    const candidate = transport(
      vi.fn(async () => sseResponse(payload)) as unknown as typeof fetch,
    );

    await expect(collect(candidate)).resolves.toContain(
      "could not prepare that suggestion safely",
    );
  });

  it("fails closed on unknown, malformed, mismatched, and incomplete function calls", async () => {
    const argumentsJson = JSON.stringify(proposalArguments());
    const added = (name = DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME) =>
      frame("response.output_item.added", {
        output_index: 0,
        item: {
          id: "function-call-invalid",
          type: "function_call",
          name,
          arguments: "",
        },
      });
    const cases = [
      added("arbitrary_command"),
      [
        added(),
        frame("response.function_call_arguments.done", {
          item_id: "function-call-invalid",
          output_index: 0,
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: "{",
        }),
      ].join(""),
      [
        added(),
        frame("response.function_call_arguments.delta", {
          item_id: "function-call-invalid",
          output_index: 0,
          delta: argumentsJson,
        }),
        frame("response.function_call_arguments.done", {
          item_id: "function-call-invalid",
          output_index: 0,
          name: DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
          arguments: JSON.stringify({
            ...proposalArguments(),
            label: "Mismatched final arguments",
          }),
        }),
      ].join(""),
      [
        added(),
        frame("response.completed", {
          response: { status: "completed" },
        }),
      ].join(""),
      [
        added(),
        frame("response.function_call_arguments.delta", {
          item_id: "function-call-invalid",
          output_index: 0,
          delta: "x".repeat(
            DESIGN_MATE_CHAT_LIMITS.proposalSerializedBytes + 1,
          ),
        }),
      ].join(""),
    ];

    for (const payload of cases) {
      const candidate = transport(
        vi.fn(async () => sseResponse(payload)) as unknown as typeof fetch,
      );
      await expect(captureError(candidate)).resolves.toMatchObject({
        code: "invalid-chat-response",
        retryable: false,
      });
    }
  });

  it.each([
    "response.failed",
    "response.incomplete",
    "response.cancelled",
    "error",
  ] as const)(
    "sanitizes %s events without exposing provider content",
    async (eventType) => {
      const fetchMock = vi.fn(async () =>
        sseResponse(
          frame(eventType, {
            error: { message: "RAW_PROVIDER_SECRET_SENTINEL" },
          }),
        ),
      ) as unknown as typeof fetch;
      const error = await captureError(transport(fetchMock));

      expect(error).toMatchObject({
        code: "provider-failed",
        retryable: true,
      });
      expect(JSON.stringify(error)).not.toContain(
        "RAW_PROVIDER_SECRET_SENTINEL",
      );
    },
  );

  it("rejects missing terminals, malformed deltas, and post-terminal data", async () => {
    const cases = [
      frame("response.output_text.delta", { delta: "No terminal" }),
      frame("response.output_text.delta", {
        delta: "x".repeat(DESIGN_MATE_CHAT_LIMITS.deltaTextLength + 1),
      }),
      [
        frame("response.output_text.delta", { delta: "Before terminal" }),
        frame("response.completed", {
          response: { status: "completed" },
        }),
        frame("response.output_text.delta", { delta: "Too late" }),
      ].join(""),
      frame("response.completed", {
        response: { status: "completed" },
      }),
      [
        frame("response.output_text.delta", { delta: "Invalid terminal" }),
        frame("response.completed", {}),
      ].join(""),
      [
        frame("response.output_text.delta", { delta: "Invalid status" }),
        frame("response.completed", {
          response: { status: "in_progress" },
        }),
      ].join(""),
    ];
    for (const payload of cases) {
      const fetchMock = vi.fn(
        async () => sseResponse(payload),
      ) as unknown as typeof fetch;
      await expect(
        captureError(transport(fetchMock)),
      ).resolves.toMatchObject({
        code: "invalid-chat-response",
        retryable: false,
      });
    }
  });

  it("enforces cumulative OpenAI stream bytes and comment-frame counts", async () => {
    const tooManyComments = transport(
      vi.fn(async () =>
        sseResponse(
          ": heartbeat\n\n".repeat(
            DESIGN_MATE_CHAT_LIMITS.sseFrames + 1,
          ),
        ),
      ) as unknown as typeof fetch,
    );
    await expect(captureError(tooManyComments)).resolves.toMatchObject({
      code: "invalid-chat-response",
      retryable: false,
    });

    const commentFrame = `:${"x".repeat(60 * 1_024)}\n\n`;
    const count =
      Math.floor(
        (4 * 1_024 * 1_024) /
          new TextEncoder().encode(commentFrame).byteLength,
      ) + 1;
    expect(count).toBeLessThan(DESIGN_MATE_CHAT_LIMITS.sseFrames);
    const tooManyBytes = transport(
      vi.fn(async () => sseResponse(commentFrame.repeat(count))) as
        unknown as typeof fetch,
    );
    await expect(captureError(tooManyBytes)).resolves.toMatchObject({
      code: "invalid-chat-response",
      retryable: false,
    });
  });

  it("rejects output-token settings outside the bounded policy", () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    for (const maxOutputTokens of [15, 16_001, 1.5]) {
      expect(() =>
        createOpenAIResponsesTransport({
          apiKey: "test-key",
          baseUrl: "https://provider.example/v1",
          model: "test-model",
          maxOutputTokens,
          fetch: fetchMock,
        }),
      ).toThrow(/output token limit/i);
    }
  });

  it("sanitizes non-SSE, HTTP, network, and abort failures", async () => {
    const nonSse = transport(
      vi.fn(
        async () =>
          new Response("RAW_PROVIDER_SECRET_SENTINEL", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    );
    expect(await captureError(nonSse)).toMatchObject({
      code: "invalid-chat-response",
      retryable: false,
    });

    const limited = transport(
      vi.fn(
        async () =>
          new Response("RAW_PROVIDER_SECRET_SENTINEL", { status: 429 }),
      ) as unknown as typeof fetch,
    );
    expect(await captureError(limited)).toMatchObject({
      code: "rate-limited",
      retryable: true,
    });

    const network = transport(
      vi.fn(async () => {
        throw new Error("NETWORK_SECRET_SENTINEL");
      }) as unknown as typeof fetch,
    );
    const networkError = await captureError(network);
    expect(networkError).toMatchObject({
      code: "provider-failed",
      retryable: true,
    });
    expect(JSON.stringify(networkError)).not.toContain(
      "NETWORK_SECRET_SENTINEL",
    );

    const fetchMock = vi.fn(
      async () => sseResponse(frame("response.completed", {})),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const abortError = await captureError(
      transport(fetchMock),
      controller.signal,
    );
    expect(abortError).toMatchObject({
      code: "cancelled",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
