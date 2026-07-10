import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_CHAT_LIMITS,
  buildDocumentIdentity,
  isValidDesignMateChatProviderChunk,
  isValidDesignMateChatWireRequest,
  prepareDesignMateChatRequest,
  snapshotValidDesignMateChatWireRequest,
  snapshotValidDesignMateChatProviderChunk,
  toDesignMateChatWireRequest,
  type DesignMateChatTurnInput,
  type DesignMateVisualAttachment,
} from "./index";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=";
const CREATED_AT = "2026-07-10T20:00:00.000Z";

function base64ByteLength(value: string): number {
  return (
    (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  );
}

function pngBase64WithByteLength(byteLength: number): string {
  const headerBytes = 33;
  const headerBase64 = PNG_BASE64.slice(0, 44);
  const remaining = byteLength - headerBytes;
  const groups = Math.floor(remaining / 3);
  const remainder = remaining % 3;
  return (
    headerBase64 +
    "AAAA".repeat(groups) +
    (remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "")
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen(Reflect.get(value, key), seen);
  }
}

function makeFixture() {
  const document = createInitialDocument();
  const options = { generation: 4, revision: 9 } as const;
  const identity = buildDocumentIdentity(document, options);
  const attachment: DesignMateVisualAttachment = {
    id: "attachment-1",
    kind: "active-artboard",
    mimeType: "image/png",
    dataBase64: PNG_BASE64,
    width: 32,
    height: 32,
    byteLength: base64ByteLength(PNG_BASE64),
    identity,
    label: "Active artboard",
  };
  const input: DesignMateChatTurnInput = {
    conversationId: "conversation-1",
    turnId: "turn-1",
    assistantMessageId: "message-assistant-2",
    history: [
      {
        id: "message-user-1",
        role: "user",
        text: "Review the current direction.",
        createdAt: CREATED_AT,
      },
      {
        id: "message-assistant-1",
        role: "assistant",
        text: "The mark has a clear geometric base.",
        createdAt: "2026-07-10T20:00:01.000Z",
      },
    ],
    userMessage: {
      id: "message-user-2",
      role: "user",
      text: "How can I improve the balance?",
      createdAt: "2026-07-10T20:00:02.000Z",
    },
    attachments: [attachment],
  };
  const request = prepareDesignMateChatRequest(
    document,
    { selectedNodeIds: [] },
    input,
    options,
  );
  return { document, input, attachment, request };
}

describe("chat request preparation", () => {
  it("detaches and deeply freezes every provider-bound value", () => {
    const { document, input, attachment, request } = makeFixture();
    const originalName = request.document.name;

    expect(request.document).not.toBe(document);
    expect(request.history).not.toBe(input.history);
    expect(request.attachments).not.toBe(input.attachments);
    expect(request.attachments[0]).not.toBe(attachment);
    expectDeepFrozen(request);

    document.name = "Mutated live document";
    (input.history as unknown as { text: string }[])[0]!.text =
      "Mutated history";
    (attachment as { label?: string }).label = "Mutated attachment";

    expect(request.document.name).toBe(originalName);
    expect(request.history[0]!.text).toBe("Review the current direction.");
    expect(request.attachments[0]!.label).toBe("Active artboard");
  });

  it("creates a detached frozen wire snapshot with no document field", () => {
    const { request } = makeFixture();
    const wire = toDesignMateChatWireRequest(request);

    expect(wire).not.toHaveProperty("document");
    expect(wire.context).not.toBe(request.context);
    expect(isValidDesignMateChatWireRequest(wire)).toBe(true);
    expectDeepFrozen(wire);
  });

  it("rejects invalid counters and empty text-only turns", () => {
    const { document, input } = makeFixture();
    expect(() =>
      prepareDesignMateChatRequest(
        document,
        { selectedNodeIds: [] },
        input,
        { generation: -1, revision: 0 },
      ),
    ).toThrow(TypeError);
    expect(() =>
      prepareDesignMateChatRequest(
        document,
        { selectedNodeIds: [] },
        {
          ...input,
          userMessage: { ...input.userMessage, text: "" },
          attachments: [],
        },
        { generation: 0, revision: 0 },
      ),
    ).toThrow(TypeError);
  });
});

describe("Design Mate chat provider chunk validation", () => {
  const candidate = {
    type: "proposal-candidate" as const,
    proposal: {
      id: "validated-proposal",
      label: "Create icon variant",
      risk: "low" as const,
      actions: [
        {
          type: "create-logo-variant" as const,
          sourceArtboardId: "artboard-1",
          purpose: "icon" as const,
        },
      ],
    },
  };

  it("accepts, snapshots, and freezes closed proposal candidates", () => {
    expect(isValidDesignMateChatProviderChunk(candidate)).toBe(true);
    const snapshot = snapshotValidDesignMateChatProviderChunk(candidate);
    expect(snapshot).toEqual(candidate);
    expectDeepFrozen(snapshot);
  });

  it("rejects extra keys, arbitrary commands, and oversized candidates", () => {
    expect(
      isValidDesignMateChatProviderChunk({ ...candidate, command: {} }),
    ).toBe(false);
    expect(
      isValidDesignMateChatProviderChunk({
        ...candidate,
        proposal: {
          ...candidate.proposal,
          actions: [{ type: "batch", commands: [] }],
        },
      }),
    ).toBe(false);
    expect(
      isValidDesignMateChatProviderChunk({
        ...candidate,
        proposal: {
          ...candidate.proposal,
          rationale: "x".repeat(
            DESIGN_MATE_CHAT_LIMITS.proposalSerializedBytes,
          ),
        },
      }),
    ).toBe(false);
  });
});

describe("untrusted chat wire validation", () => {
  it("requires exact top-level, message, and attachment keys", () => {
    const wire = toDesignMateChatWireRequest(makeFixture().request);
    expect(
      isValidDesignMateChatWireRequest({ ...wire, document: {} }),
    ).toBe(false);
    expect(isValidDesignMateChatWireRequest({ ...wire, extra: true })).toBe(
      false,
    );
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        userMessage: { ...wire.userMessage, extra: true },
      }),
    ).toBe(false);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        attachments: [{ ...wire.attachments[0]!, extra: true }],
      }),
    ).toBe(false);
  });

  it("rejects sparse arrays, duplicate ids, bad timestamps, and hostile values", () => {
    const wire = toDesignMateChatWireRequest(makeFixture().request);
    const sparse = new Array(1);
    expect(
      isValidDesignMateChatWireRequest({ ...wire, history: sparse }),
    ).toBe(false);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        userMessage: {
          ...wire.userMessage,
          id: wire.assistantMessageId,
        },
      }),
    ).toBe(false);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        userMessage: {
          ...wire.userMessage,
          createdAt: "2026-02-31T00:00:00.000Z",
        },
      }),
    ).toBe(false);

    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile");
        },
      },
    );
    expect(() => isValidDesignMateChatWireRequest(hostile)).not.toThrow();
    expect(isValidDesignMateChatWireRequest(hostile)).toBe(false);
    expect(snapshotValidDesignMateChatWireRequest(hostile)).toBeNull();
  });

  it("enforces chat id, history, text, and attachment-count limits", () => {
    const wire = toDesignMateChatWireRequest(makeFixture().request);
    const maximumHistory = Array.from(
      { length: DESIGN_MATE_CHAT_LIMITS.historyMessages },
      (_, index) => ({
        id: `bounded-history-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: "Bounded history message.",
        createdAt: CREATED_AT,
      }),
    );
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        history: maximumHistory,
      }),
    ).toBe(true);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        history: [
          ...maximumHistory,
          {
            id: "history-over-limit",
            role: "user",
            text: "One too many.",
            createdAt: CREATED_AT,
          },
        ],
      }),
    ).toBe(false);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        conversationId: "i".repeat(
          DESIGN_MATE_CHAT_LIMITS.chatIdLength + 1,
        ),
      }),
    ).toBe(false);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        userMessage: {
          ...wire.userMessage,
          text: "u".repeat(DESIGN_MATE_CHAT_LIMITS.userTextLength + 1),
        },
      }),
    ).toBe(false);

    const attachments = Array.from(
      { length: DESIGN_MATE_CHAT_LIMITS.attachments },
      (_, index) => ({ ...wire.attachments[0]!, id: `visual-${index}` }),
    );
    expect(
      isValidDesignMateChatWireRequest({ ...wire, attachments }),
    ).toBe(true);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        attachments: [
          ...attachments,
          { ...wire.attachments[0]!, id: "visual-over-limit" },
        ],
      }),
    ).toBe(false);
  });

  it("validates base64, PNG signature, payload size, dimensions, and identity", () => {
    const wire = toDesignMateChatWireRequest(makeFixture().request);
    const attachment = wire.attachments[0]!;
    const invalidAttachments: readonly unknown[] = [
      { ...attachment, dataBase64: `${attachment.dataBase64.slice(0, -1)}*` },
      { ...attachment, dataBase64: attachment.dataBase64.slice(0, -1) },
      { ...attachment, dataBase64: "AAAAAAAAAAAA", byteLength: 9 },
      { ...attachment, byteLength: attachment.byteLength + 1 },
      { ...attachment, width: 31 },
      { ...attachment, width: 33 },
      { ...attachment, height: 1_025 },
      { ...attachment, width: 1_024, height: 1_024 },
      {
        ...attachment,
        byteLength: DESIGN_MATE_CHAT_LIMITS.attachmentBytes + 1,
      },
      {
        ...attachment,
        identity: {
          ...attachment.identity,
          revision: attachment.identity.revision + 1,
        },
      },
    ];

    for (const invalid of invalidAttachments) {
      expect(
        isValidDesignMateChatWireRequest({
          ...wire,
          attachments: [invalid],
        }),
      ).toBe(false);
    }
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        attachments: [attachment, attachment],
      }),
    ).toBe(false);
  });

  it("rejects identity/context mismatches and oversized serialized context", () => {
    const wire = toDesignMateChatWireRequest(makeFixture().request);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        context: {
          ...wire.context,
          document: {
            ...wire.context.document,
            id: "different-document",
          },
        },
      }),
    ).toBe(false);

    const oversizedContext = {
      ...wire.context,
      paletteColors: Array.from(
        { length: 48 },
        () => "x".repeat(DESIGN_MATE_CHAT_LIMITS.contextStringLength),
      ),
    };
    expect(
      JSON.stringify(oversizedContext).length,
    ).toBeGreaterThan(DESIGN_MATE_CHAT_LIMITS.contextSerializedBytes);
    expect(
      isValidDesignMateChatWireRequest({
        ...wire,
        context: oversizedContext,
      }),
    ).toBe(false);
  });

  it("accepts the total wire-byte boundary and rejects one byte over it", () => {
    const baseWire = structuredClone(
      toDesignMateChatWireRequest(makeFixture().request),
    );
    const maximumAttachment = {
      ...baseWire.attachments[0]!,
      dataBase64: pngBase64WithByteLength(
        DESIGN_MATE_CHAT_LIMITS.attachmentBytes,
      ),
      byteLength: DESIGN_MATE_CHAT_LIMITS.attachmentBytes,
    };
    const suffixes = Array.from(
      { length: DESIGN_MATE_CHAT_LIMITS.selectionIds },
      (_, index) => `-${index}`,
    );
    const fillerLengths = suffixes.map(
      (suffix) =>
        DESIGN_MATE_CHAT_LIMITS.referenceIdLength - suffix.length,
    );
    let wire = {
      ...baseWire,
      attachments: Array.from(
        { length: DESIGN_MATE_CHAT_LIMITS.attachments },
        (_, index) => ({
          ...maximumAttachment,
          id: `maximum-attachment-${index}`,
        }),
      ),
      history: Array.from(
        { length: DESIGN_MATE_CHAT_LIMITS.historyMessages },
        (_, index) => ({
          id: `maximum-history-${index}`,
          role: "assistant" as const,
          text: "h".repeat(DESIGN_MATE_CHAT_LIMITS.assistantTextLength),
          createdAt: CREATED_AT,
        }),
      ),
      selection: {
        ...baseWire.selection,
        selectedNodeIds: suffixes.map(
          (suffix, index) =>
            `${"a".repeat(fillerLengths[index]!)}${suffix}`,
        ),
      },
    };

    const asciiBytes = utf8Bytes(JSON.stringify(wire));
    let bytesToAdd =
      DESIGN_MATE_CHAT_LIMITS.wireSerializedBytes - asciiBytes;
    expect(bytesToAdd).toBeGreaterThan(0);
    expect(bytesToAdd).toBeLessThanOrEqual(
      fillerLengths.reduce((total, length) => total + length, 0),
    );
    wire = {
      ...wire,
      selection: {
        ...wire.selection,
        selectedNodeIds: suffixes.map((suffix, index) => {
          const replacements = Math.min(
            fillerLengths[index]!,
            bytesToAdd,
          );
          bytesToAdd -= replacements;
          return `${"é".repeat(replacements)}${"a".repeat(
            fillerLengths[index]! - replacements,
          )}${suffix}`;
        }),
      },
    };
    expect(bytesToAdd).toBe(0);
    expect(utf8Bytes(JSON.stringify(wire))).toBe(
      DESIGN_MATE_CHAT_LIMITS.wireSerializedBytes,
    );
    expect(isValidDesignMateChatWireRequest(wire)).toBe(true);

    const oneByteOver = {
      ...wire,
      userMessage: {
        ...wire.userMessage,
        text: `é${wire.userMessage.text.slice(1)}`,
      },
    };
    expect(utf8Bytes(JSON.stringify(oneByteOver))).toBe(
      DESIGN_MATE_CHAT_LIMITS.wireSerializedBytes + 1,
    );
    expect(isValidDesignMateChatWireRequest(oneByteOver)).toBe(false);
  });

  it("snapshots valid input and isolates subsequent mutation", () => {
    const mutable = structuredClone(
      toDesignMateChatWireRequest(makeFixture().request),
    );
    const snapshot = snapshotValidDesignMateChatWireRequest(mutable);
    expect(snapshot).not.toBeNull();
    (
      mutable.userMessage as unknown as { text: string }
    ).text = "Changed after validation";

    expect(snapshot?.userMessage.text).toBe("How can I improve the balance?");
    expectDeepFrozen(snapshot);
  });
});
