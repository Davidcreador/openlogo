import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatPrompt,
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
    fetch: fetchImplementation,
  });
}

async function collect(
  modelTransport: DesignMateModelTransport,
  signal?: AbortSignal,
): Promise<string> {
  const deltas: string[] = [];
  for await (const chunk of modelTransport.stream(prompt(), signal)) {
    deltas.push(chunk.delta);
  }
  return deltas.join("");
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
      readonly input: readonly {
        readonly role: string;
        readonly content: readonly Record<string, unknown>[];
      }[];
      readonly stream: boolean;
      readonly store: boolean;
    };
    expect(body).toMatchObject({
      model: "required-model",
      instructions: "INSTRUCTIONS_CONTEXT_SENTINEL",
      stream: true,
      store: false,
    });
    expect(body.input.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(body.input[0]?.content).toEqual([
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

  it.each(["response.failed", "error"] as const)(
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
        frame("response.completed", {}),
        frame("response.output_text.delta", { delta: "Too late" }),
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
