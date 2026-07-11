import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInitialDocument } from "@openlogo/core";
import {
  createRemoteDesignMateChatProvider,
  prepareDesignMateChatRequest,
  type DesignMateChatProviderChunk,
} from "@openlogo/design-mate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_MATE_SERVICE_DEFAULTS,
  createFakeDesignMateModelTransport,
  startDesignMateService,
  type DesignMateServiceConfig,
} from "./index";

const SERVICE_TOKEN = "integration-service-token";
const servers: Server[] = [];

function config(): DesignMateServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowAnonymousLoopback: false,
    allowedOrigins: [],
    maxBodyBytes: DESIGN_MATE_SERVICE_DEFAULTS.maxBodyBytes,
    maxJsonDepth: DESIGN_MATE_SERVICE_DEFAULTS.maxJsonDepth,
    rateLimitRequestsPerMinute: 10,
    maxConcurrentRequests: 2,
    maxConcurrentRequestsPerSubject: 1,
    requestTimeoutMs: 5_000,
    upstreamTimeoutMs: 2_000,
    upstreamRetryAttempts: 0,
    serviceToken: SERVICE_TOKEN,
  };
}

afterEach(async () => {
  const active = servers.splice(0);
  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("remote provider and HTTP service integration", () => {
  it("authenticates and streams a wire-only chat turn through real HTTP", async () => {
    const transport = createFakeDesignMateModelTransport({
      chunks: [
        { type: "text-delta", delta: "Inspect " },
        { type: "text-delta", delta: "the spacing." },
      ],
    });
    const server = await startDesignMateService({
      config: config(),
      transport,
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const getAccessToken = vi.fn(async () => SERVICE_TOKEN);
    const provider = createRemoteDesignMateChatProvider({
      endpoint: `http://127.0.0.1:${address.port}/v1/design-mate/chat`,
      getAccessToken,
    });
    const document = createInitialDocument();
    const request = prepareDesignMateChatRequest(
      document,
      { selectedNodeIds: [] },
      {
        conversationId: "integration-conversation",
        turnId: "integration-turn",
        assistantMessageId: "integration-assistant",
        history: [],
        userMessage: {
          id: "integration-user",
          role: "user",
          text: "What should I refine?",
          createdAt: "2026-07-10T20:00:00.000Z",
        },
        attachments: [],
      },
      { generation: 0, revision: 0 },
    );
    const chunks: DesignMateChatProviderChunk[] = [];

    for await (const chunk of provider.stream(request)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "text-delta", delta: "Inspect " },
      { type: "text-delta", delta: "the spacing." },
    ]);
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]?.messages.at(-1)?.text).toBe(
      "What should I refine?",
    );
  });
});
