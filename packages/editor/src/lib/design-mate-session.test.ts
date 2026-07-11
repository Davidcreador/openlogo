import { describe, expect, it } from "vitest";
import type { DesignMateChatTranscriptEntry } from "./design-mate-chat";
import {
  clearDesignMateChatSession,
  loadDesignMateChatSession,
  saveDesignMateChatSession,
  type DesignMateSessionStorage,
} from "./design-mate-session";

function memoryStorage(): DesignMateSessionStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function assistantEntry(): DesignMateChatTranscriptEntry {
  return {
    id: "assistant-session",
    role: "assistant",
    text: "Refine the spacing first.",
    createdAt: "2026-07-10T20:00:00.000Z",
    status: "complete",
    providerLabel: "Local guidance",
    answerContext: {
      identity: {
        documentId: "document-session",
        schemaVersion: 5,
        generation: 1,
        revision: 2,
        contentFingerprint: "fnv1a64-v1:1234567890abcdef",
      },
      request: {
        scope: "active-artboard",
        selectedNodeIds: [],
      },
    },
    memory: [
      {
        id: "memory-session",
        proposalId: "proposal-session",
        label: "Refine spacing",
        status: "applied",
        summary: "Adjusted spacing.",
        createdAt: "2026-07-10T20:00:01.000Z",
      },
    ],
  };
}

describe("Design Mate tab-session persistence", () => {
  it("restores bounded display history without reviving stale answer context", () => {
    const storage = memoryStorage();
    saveDesignMateChatSession(
      "document-session",
      [assistantEntry()],
      storage,
    );

    const restored = loadDesignMateChatSession(
      "document-session",
      storage,
    );
    expect(restored.activeTurn).toBeNull();
    expect(restored.entries).toEqual([
      {
        id: "assistant-session",
        role: "assistant",
        text: "Refine the spacing first.",
        createdAt: "2026-07-10T20:00:00.000Z",
        status: "complete",
        providerLabel: "Local guidance",
        memory: [assistantEntry().memory![0]],
      },
    ]);
    expect(restored.entries[0]).not.toHaveProperty("answerContext");
  });

  it("isolates documents, rejects malformed storage, and clears explicitly", () => {
    const storage = memoryStorage();
    saveDesignMateChatSession("document-a", [assistantEntry()], storage);
    expect(loadDesignMateChatSession("document-b", storage).entries).toEqual(
      [],
    );

    const key = [...storage.values.keys()][0]!;
    storage.values.set(key, JSON.stringify([{ role: "assistant" }]));
    expect(loadDesignMateChatSession("document-a", storage).entries).toEqual(
      [],
    );

    saveDesignMateChatSession("document-a", [assistantEntry()], storage);
    clearDesignMateChatSession("document-a", storage);
    expect(loadDesignMateChatSession("document-a", storage).entries).toEqual(
      [],
    );
  });

  it("never throws when storage is unavailable", () => {
    const hostile: DesignMateSessionStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() =>
      saveDesignMateChatSession("document", [assistantEntry()], hostile),
    ).not.toThrow();
    expect(loadDesignMateChatSession("document", hostile).entries).toEqual([]);
    expect(() =>
      clearDesignMateChatSession("document", hostile),
    ).not.toThrow();
  });
});
