import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateConversationMemoryEvent,
} from "@openlogo/design-mate";
import {
  DESIGN_MATE_TRANSCRIPT_LIMIT,
  type DesignMateChatTranscriptEntry,
  type DesignMateChatTranscriptState,
} from "./design-mate-chat";

const SESSION_PREFIX = "openlogo:design-mate:transcript:";
const SESSION_BYTES = 128 * 1_024;
const MEMORY_STATUSES = new Set(["prepared", "applied", "dismissed", "rejected"]);
const ENTRY_STATUSES = new Set(["complete", "failed", "cancelled"]);

export type DesignMateSessionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function currentSessionStorage(): DesignMateSessionStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function storageKey(documentId: string): string | null {
  return typeof documentId === "string" &&
    documentId.trim().length > 0 &&
    documentId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(documentId)
    ? `${SESSION_PREFIX}${encodeURIComponent(documentId)}`
    : null;
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function memoryEvent(
  value: unknown,
): DesignMateConversationMemoryEvent | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const candidate = value as Partial<DesignMateConversationMemoryEvent>;
  if (
    !boundedString(candidate.id, 256) ||
    !boundedString(candidate.proposalId, 256) ||
    !boundedString(candidate.label, 256) ||
    typeof candidate.status !== "string" ||
    !MEMORY_STATUSES.has(candidate.status) ||
    !boundedString(
      candidate.summary,
      DESIGN_MATE_CHAT_LIMITS.memorySummaryLength,
      true,
    ) ||
    !boundedString(
      candidate.createdAt,
      DESIGN_MATE_CHAT_LIMITS.timestampLength,
    ) ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    return null;
  }
  return {
    id: candidate.id,
    proposalId: candidate.proposalId,
    label: candidate.label,
    status: candidate.status as DesignMateConversationMemoryEvent["status"],
    summary: candidate.summary,
    createdAt: candidate.createdAt,
  };
}

function transcriptEntry(
  value: unknown,
): DesignMateChatTranscriptEntry | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const candidate = value as Partial<DesignMateChatTranscriptEntry>;
  if (
    !boundedString(candidate.id, 256) ||
    (candidate.role !== "user" && candidate.role !== "assistant") ||
    typeof candidate.status !== "string" ||
    !ENTRY_STATUSES.has(candidate.status) ||
    !boundedString(
      candidate.text,
      candidate.role === "user"
        ? DESIGN_MATE_CHAT_LIMITS.userTextLength
        : DESIGN_MATE_CHAT_LIMITS.assistantTextLength,
      true,
    ) ||
    !boundedString(
      candidate.createdAt,
      DESIGN_MATE_CHAT_LIMITS.timestampLength,
    ) ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    (candidate.providerLabel !== undefined &&
      !boundedString(candidate.providerLabel, 256)) ||
    (candidate.errorLabel !== undefined &&
      !boundedString(
        candidate.errorLabel,
        DESIGN_MATE_CHAT_LIMITS.errorMessageLength,
      ))
  ) {
    return null;
  }
  const memory = Array.isArray(candidate.memory)
    ? candidate.memory
        .slice(-DESIGN_MATE_CHAT_LIMITS.memoryEvents)
        .map(memoryEvent)
    : [];
  if (memory.some((event) => event === null)) {
    return null;
  }
  return {
    id: candidate.id,
    role: candidate.role,
    text: candidate.text,
    createdAt: candidate.createdAt,
    status: candidate.status as DesignMateChatTranscriptEntry["status"],
    ...(candidate.providerLabel
      ? { providerLabel: candidate.providerLabel }
      : {}),
    ...(candidate.errorLabel ? { errorLabel: candidate.errorLabel } : {}),
    ...(memory.length > 0
      ? {
          memory: memory as DesignMateConversationMemoryEvent[],
        }
      : {}),
  };
}

function serializedEntries(
  entries: readonly DesignMateChatTranscriptEntry[],
): string {
  const safe = entries
    .filter((entry) => entry.status !== "streaming")
    .slice(-DESIGN_MATE_TRANSCRIPT_LIMIT)
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      createdAt: entry.createdAt,
      status: entry.status,
      ...(entry.providerLabel ? { providerLabel: entry.providerLabel } : {}),
      ...(entry.errorLabel ? { errorLabel: entry.errorLabel } : {}),
      ...(entry.memory ? { memory: entry.memory } : {}),
    }));
  while (safe.length > 0) {
    const serialized = JSON.stringify(safe);
    if (new TextEncoder().encode(serialized).byteLength <= SESSION_BYTES) {
      return serialized;
    }
    safe.shift();
  }
  return "[]";
}

export function loadDesignMateChatSession(
  documentId: string,
  storage: DesignMateSessionStorage | null = currentSessionStorage(),
): DesignMateChatTranscriptState {
  const key = storageKey(documentId);
  if (!key || !storage) {
    return { entries: [], activeTurn: null };
  }
  try {
    const raw = storage.getItem(key);
    if (
      !raw ||
      new TextEncoder().encode(raw).byteLength > SESSION_BYTES
    ) {
      return { entries: [], activeTurn: null };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > DESIGN_MATE_TRANSCRIPT_LIMIT
    ) {
      return { entries: [], activeTurn: null };
    }
    const entries = parsed.map(transcriptEntry);
    if (entries.some((entry) => entry === null)) {
      return { entries: [], activeTurn: null };
    }
    return {
      entries: entries as DesignMateChatTranscriptEntry[],
      activeTurn: null,
    };
  } catch {
    return { entries: [], activeTurn: null };
  }
}

export function saveDesignMateChatSession(
  documentId: string,
  entries: readonly DesignMateChatTranscriptEntry[],
  storage: DesignMateSessionStorage | null = currentSessionStorage(),
): void {
  const key = storageKey(documentId);
  if (!key || !storage) {
    return;
  }
  try {
    storage.setItem(key, serializedEntries(entries));
  } catch {
    // Session persistence is optional and never blocks editing.
  }
}

export function clearDesignMateChatSession(
  documentId: string,
  storage: DesignMateSessionStorage | null = currentSessionStorage(),
): void {
  const key = storageKey(documentId);
  if (!key || !storage) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}
