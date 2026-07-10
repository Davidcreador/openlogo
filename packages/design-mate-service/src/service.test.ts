import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInitialDocument } from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  buildDocumentIdentity,
  decodeDesignMateChatSse,
  prepareDesignMateChatRequest,
  toDesignMateChatWireRequest,
  type DesignMateChatTransportEvent,
  type DesignMateChatWireRequest,
  type DesignMateVisualAttachment,
} from "@openlogo/design-mate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_MATE_SERVICE_DEFAULTS,
  createDesignMateService,
  createFakeDesignMateModelTransport,
  type DesignMateServiceConfig,
  type DesignMateServiceLogEntry,
  type FakeDesignMateModelTransportOptions,
  type RequestAuth,
} from "./index";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=";
const ALLOWED_ORIGIN = "https://design.example";
const SERVICE_TOKEN = "AUTH_SECRET_SENTINEL";

const servers: Server[] = [];

function base64ByteLength(value: string): number {
  return (
    (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  );
}

function makeWire(withImage = false): DesignMateChatWireRequest {
  const document = createInitialDocument();
  const options = { generation: 3, revision: 8 } as const;
  const identity = buildDocumentIdentity(document, options);
  const attachment: DesignMateVisualAttachment = {
    id: "image-1",
    kind: "active-artboard",
    mimeType: "image/png",
    dataBase64: PNG_BASE64,
    width: 32,
    height: 32,
    byteLength: base64ByteLength(PNG_BASE64),
    identity,
    label: "Rendered artboard",
  };
  const request = prepareDesignMateChatRequest(
    document,
    { selectedNodeIds: [] },
    {
      conversationId: "conversation-service",
      turnId: "turn-service",
      assistantMessageId: "assistant-service",
      history: [
        {
          id: "history-user",
          role: "user",
          text: "What is strongest?",
          createdAt: "2026-07-10T20:00:00.000Z",
        },
        {
          id: "history-assistant",
          role: "assistant",
          text: "The geometric silhouette.",
          createdAt: "2026-07-10T20:00:01.000Z",
        },
      ],
      userMessage: {
        id: "current-user",
        role: "user",
        text: "How should I refine the balance?",
        createdAt: "2026-07-10T20:00:02.000Z",
      },
      attachments: withImage ? [attachment] : [],
    },
    options,
  );
  return toDesignMateChatWireRequest(request);
}

function config(
  overrides: Partial<DesignMateServiceConfig> = {},
): DesignMateServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    maxBodyBytes: DESIGN_MATE_SERVICE_DEFAULTS.maxBodyBytes,
    maxJsonDepth: 32,
    rateLimitRequestsPerMinute: 100,
    requestTimeoutMs: 5_000,
    upstreamTimeoutMs: 2_000,
    ...overrides,
  };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function postWire(
  baseUrl: string,
  wire: unknown,
  options: {
    readonly origin?: string;
    readonly token?: string;
    readonly contentType?: string;
  } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/design-mate/chat`, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.origin === undefined
        ? {}
        : { origin: options.origin }),
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify(wire),
  });
}

async function transportEvents(
  response: Response,
): Promise<readonly DesignMateChatTransportEvent[]> {
  const body = new Uint8Array(await response.arrayBuffer());
  const events: DesignMateChatTransportEvent[] = [];
  for await (const event of decodeDesignMateChatSse([body])) {
    events.push(event);
  }
  return events;
}

afterEach(async () => {
  const active = servers.splice(0);
  await Promise.all(active.map(closeServer));
});

describe("Design Mate HTTP service", () => {
  it("serves bounded health without auth or transport work", async () => {
    const authenticate = vi.fn(() => null);
    const auth: RequestAuth = { authenticate };
    const transport = createFakeDesignMateModelTransport();
    const baseUrl = await listen(
      createDesignMateService({ config: config(), auth, transport }),
    );

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual({
      status: "ok",
      version: "0.1.0",
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(transport.prompts).toHaveLength(0);
  });

  it("requires the configured bearer token using fail-closed auth", async () => {
    const transport = createFakeDesignMateModelTransport({
      chunks: [{ type: "text-delta", delta: "Authenticated." }],
    });
    const baseUrl = await listen(
      createDesignMateService({
        config: config({ serviceToken: SERVICE_TOKEN }),
        transport,
      }),
    );
    expect((await postWire(baseUrl, makeWire())).status).toBe(401);
    expect(
      (await postWire(baseUrl, makeWire(), { token: "wrong-token" }))
        .status,
    ).toBe(401);

    const accepted = await postWire(baseUrl, makeWire(), {
      token: SERVICE_TOKEN,
    });
    expect(accepted.status).toBe(200);
    expect(await transportEvents(accepted)).toEqual([
      { type: "text-delta", delta: "Authenticated." },
      { type: "completed" },
    ]);
    expect(transport.prompts).toHaveLength(1);
  });

  it("enforces the CORS allowlist and validates preflight", async () => {
    const transport = createFakeDesignMateModelTransport();
    const baseUrl = await listen(
      createDesignMateService({ config: config(), transport }),
    );

    const preflight = await fetch(
      `${baseUrl}/v1/design-mate/chat`,
      {
        method: "OPTIONS",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "Content-Type, Authorization",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      ALLOWED_ORIGIN,
    );
    expect(preflight.headers.get("access-control-allow-methods")).toBe(
      "POST",
    );

    const forbidden = await postWire(baseUrl, makeWire(), {
      origin: "https://attacker.example",
    });
    expect(forbidden.status).toBe(403);
    expect(
      forbidden.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const badHeaders = await fetch(
      `${baseUrl}/v1/design-mate/chat`,
      {
        method: "OPTIONS",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "X-Untrusted",
        },
      },
    );
    expect(badHeaders.status).toBe(400);
    expect(transport.prompts).toHaveLength(0);
  });

  it("rejects route, method, media, body, depth, and size violations", async () => {
    const transport = createFakeDesignMateModelTransport();
    const baseUrl = await listen(
      createDesignMateService({
        config: config({ maxBodyBytes: 1_024 }),
        transport,
      }),
    );

    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/v1/design-mate/chat`)).status,
    ).toBe(405);
    expect(
      (
        await fetch(`${baseUrl}/v1/design-mate/chat`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${baseUrl}/v1/design-mate/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/v1/design-mate/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${"[".repeat(33)}0${"]".repeat(33)}`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/v1/design-mate/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "x".repeat(1_100) }),
        })
      ).status,
    ).toBe(413);
    expect(transport.prompts).toHaveLength(0);
  });

  it("streams a realistic validated wire request with SSE and CORS", async () => {
    const transport = createFakeDesignMateModelTransport({
      chunks: [
        { type: "text-delta", delta: "Improve " },
        { type: "text-delta", delta: "the spacing." },
      ],
    });
    const baseUrl = await listen(
      createDesignMateService({ config: config(), transport }),
    );
    const response = await postWire(baseUrl, makeWire(true), {
      origin: ALLOWED_ORIGIN,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      ALLOWED_ORIGIN,
    );
    expect(await transportEvents(response)).toEqual([
      { type: "text-delta", delta: "Improve " },
      { type: "text-delta", delta: "the spacing." },
      { type: "completed" },
    ]);
    expect(transport.prompts[0]?.images).toHaveLength(1);
    expect(transport.prompts[0]?.system).toContain(
      "Bounded DesignContext JSON",
    );
  });

  it("fails closed on empty and cumulatively oversized model output", async () => {
    for (const chunks of [
      [],
      Array.from({ length: 5 }, () => ({
        type: "text-delta" as const,
        delta: "x".repeat(DESIGN_MATE_CHAT_LIMITS.deltaTextLength),
      })),
    ]) {
      const transport = createFakeDesignMateModelTransport({ chunks });
      const baseUrl = await listen(
        createDesignMateService({ config: config(), transport }),
      );
      const events = await transportEvents(
        await postWire(baseUrl, makeWire()),
      );
      expect(events.at(-1)).toMatchObject({
        type: "failed",
        error: { code: "invalid-chat-response" },
      });
      expect(events.some((event) => event.type === "completed")).toBe(
        false,
      );
    }
  });

  it("rejects document keys and invalid identity before transport", async () => {
    const transport = createFakeDesignMateModelTransport();
    const baseUrl = await listen(
      createDesignMateService({ config: config(), transport }),
    );
    const wire = makeWire(true);

    expect(
      (await postWire(baseUrl, { ...wire, document: {} })).status,
    ).toBe(400);
    expect(
      (
        await postWire(baseUrl, {
          ...wire,
          identity: { ...wire.identity, contentFingerprint: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postWire(baseUrl, {
          ...wire,
          attachments: [{ ...wire.attachments[0]!, width: 33 }],
        })
      ).status,
    ).toBe(400);
    expect(transport.prompts).toHaveLength(0);
  });

  it("rate limits an authenticated subject before provider work", async () => {
    const transport = createFakeDesignMateModelTransport();
    const baseUrl = await listen(
      createDesignMateService({
        config: config({ rateLimitRequestsPerMinute: 1 }),
        transport,
      }),
    );

    expect((await postWire(baseUrl, makeWire())).status).toBe(200);
    const limited = await postWire(baseUrl, makeWire());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(transport.prompts).toHaveLength(1);
  });

  it("propagates client disconnect to the model transport", async () => {
    let observeAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    const respond: NonNullable<
      FakeDesignMateModelTransportOptions["respond"]
    > = async function* (_prompt, _index, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      observeAbort?.();
      throw new Error("disconnect sentinel");
    };
    const transport = createFakeDesignMateModelTransport({ respond });
    const baseUrl = await listen(
      createDesignMateService({ config: config(), transport }),
    );
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/design-mate/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeWire()),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    controller.abort();

    await expect(
      Promise.race([
        aborted.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 1_000),
        ),
      ]),
    ).resolves.toBe(true);
  });

  it("turns an upstream timeout into one sanitized failed event", async () => {
    const transport = createFakeDesignMateModelTransport({
      respond: async function* () {
        await new Promise<never>(() => undefined);
      },
    });
    const baseUrl = await listen(
      createDesignMateService({
        config: config({ upstreamTimeoutMs: 20 }),
        transport,
      }),
    );
    const response = await postWire(baseUrl, makeWire());
    const events = await transportEvents(response);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "failed",
      error: {
        code: "provider-failed",
        message: "The Design Mate model request timed out.",
      },
    });
  });

  it("logs metadata only and sanitizes arbitrary transport failures", async () => {
    const logs: DesignMateServiceLogEntry[] = [];
    const mutable = structuredClone(makeWire(true)) as unknown as {
      identity: { contentFingerprint: string };
      context: { designBrief: { notes: string } | null };
      userMessage: { text: string };
      attachments: Array<{
        identity: { contentFingerprint: string };
      }>;
    };
    mutable.identity.contentFingerprint = "FINGERPRINT_SECRET_SENTINEL";
    mutable.context.designBrief = {
      notes: "BRIEF_SECRET_SENTINEL",
    };
    mutable.userMessage.text = "MESSAGE_SECRET_SENTINEL";
    mutable.attachments[0]!.identity.contentFingerprint =
      "FINGERPRINT_SECRET_SENTINEL";
    const transport = createFakeDesignMateModelTransport({
      error: new Error("PROVIDER_SECRET_SENTINEL"),
    });
    const baseUrl = await listen(
      createDesignMateService({
        config: config({ serviceToken: SERVICE_TOKEN }),
        transport,
        logger: (entry) => logs.push(entry),
      }),
    );

    const response = await postWire(baseUrl, mutable, {
      token: SERVICE_TOKEN,
    });
    const payload = await response.text();
    expect(payload).not.toContain("PROVIDER_SECRET_SENTINEL");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const serializedLogs = JSON.stringify(logs);
    for (const secret of [
      SERVICE_TOKEN,
      "FINGERPRINT_SECRET_SENTINEL",
      "BRIEF_SECRET_SENTINEL",
      "MESSAGE_SECRET_SENTINEL",
      "PROVIDER_SECRET_SENTINEL",
      PNG_BASE64,
    ]) {
      expect(serializedLogs).not.toContain(secret);
    }
    expect(logs.at(-1)).toMatchObject({
      route: "/v1/design-mate/chat",
      status: 200,
      providerId: "fake-design-mate-model",
      errorCode: "provider-failed",
    });
  });
});
