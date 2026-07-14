import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  buildDocumentIdentity,
  createDirectDesignMateChatProvider,
  createFakeDesignMateModelTransport,
  isDesignMateProviderError,
  prepareDesignMateChatRequest,
  type DesignMateChatTurnRequest,
} from "./index";

function makeRequest(): DesignMateChatTurnRequest {
  const document = createInitialDocument();
  const nodeId = document.artboards[0]!.nodeIds[0]!;
  const options = { generation: 1, revision: 1 } as const;
  buildDocumentIdentity(document, options);
  return prepareDesignMateChatRequest(
    document,
    { selectedNodeIds: [nodeId] },
    {
      conversationId: "conversation-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      history: [],
      userMessage: {
        id: "user-1",
        role: "user",
        text: "Review the balance.",
        createdAt: "2026-07-10T20:00:00.000Z",
      },
      attachments: [],
    },
    { ...options, scope: "selection" },
  );
}

describe("createDirectDesignMateChatProvider", () => {
  it("assembles the prompt and forwards transport chunks", async () => {
    const transport = createFakeDesignMateModelTransport({
      id: "openai-direct",
      chunks: [{ type: "text-delta", delta: "Balanced." }],
    });
    const provider = createDirectDesignMateChatProvider(transport);
    expect(provider.id).toBe("openai-direct");

    const chunks = [];
    for await (const chunk of provider.stream(makeRequest())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: "text-delta", delta: "Balanced." }]);
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]!.messages.at(-1)?.text).toBe(
      "Review the balance.",
    );
  });

  it("normalizes transport failures into provider errors", async () => {
    const transport = createFakeDesignMateModelTransport({
      id: "openai-direct",
      error: new Error("upstream exploded"),
    });
    const provider = createDirectDesignMateChatProvider(transport);

    let caught: unknown;
    try {
      for await (const _ of provider.stream(makeRequest())) {
        // drain
      }
    } catch (cause) {
      caught = cause;
    }
    expect(isDesignMateProviderError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("provider-failed");
  });

  it("cancels before assembling when the signal is already aborted", async () => {
    const transport = createFakeDesignMateModelTransport({
      id: "openai-direct",
    });
    const provider = createDirectDesignMateChatProvider(transport);
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      for await (const _ of provider.stream(
        makeRequest(),
        controller.signal,
      )) {
        // drain
      }
    } catch (cause) {
      caught = cause;
    }
    expect((caught as { code: string }).code).toBe("cancelled");
    expect(transport.prompts).toHaveLength(0);
  });
});
