import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatEvent,
  type DesignMateChatMessage,
  type DesignMateChatProvider,
  type DesignMateConversationMemoryEvent,
  type DesignMateProviderError,
  type DocumentIdentity,
} from "@openlogo/design-mate";
import {
  designMateRequestSignaturesEqual,
  type DesignMateRequestSignature,
} from "./design-mate-review";

const SERVICE_URL_LIMIT = 2_048;
const CHAT_ROUTE = "/v1/design-mate/chat";
const RELATIVE_URL_BASE = "https://openlogo.invalid";

export const DESIGN_MATE_TRANSCRIPT_LIMIT = 48;

export type DesignMateChatMode = "remote-with-fallback" | "local";
export type DesignMateAccessTokenProvider = (
  signal?: AbortSignal,
) => string | null | Promise<string | null>;

let accessTokenProvider: DesignMateAccessTokenProvider | null = null;

/**
 * Host applications may install a short-lived token callback before opening
 * Design Mate. The callback, rather than a credential, is retained in memory.
 */
export function setDesignMateAccessTokenProvider(
  provider: DesignMateAccessTokenProvider | null,
): void {
  if (provider !== null && typeof provider !== "function") {
    throw new TypeError("The Design Mate access-token provider is invalid.");
  }
  accessTokenProvider = provider;
}

export function getDesignMateAccessToken(
  signal?: AbortSignal,
): string | null | Promise<string | null> {
  return accessTokenProvider?.(signal) ?? null;
}

export type DesignMateChatEntryStatus =
  | "complete"
  | "streaming"
  | "failed"
  | "cancelled";

export type DesignMateChatAnswerContext = {
  readonly identity: DocumentIdentity;
  readonly request: DesignMateRequestSignature;
};

export type DesignMateChatTranscriptEntry = DesignMateChatMessage & {
  readonly status: DesignMateChatEntryStatus;
  readonly providerLabel?: string;
  readonly errorLabel?: string;
  readonly answerContext?: DesignMateChatAnswerContext;
  readonly memory?: readonly DesignMateConversationMemoryEvent[];
};

type ActiveDesignMateChatTurn = {
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly nextDeltaIndex: number;
  readonly messageStarted: boolean;
  readonly messageEnded: boolean;
};

export type DesignMateChatTranscriptState = {
  readonly entries: readonly DesignMateChatTranscriptEntry[];
  readonly activeTurn: ActiveDesignMateChatTurn | null;
};

export type DesignMateChatTranscriptAction =
  | {
      readonly type: "start-turn";
      readonly turnId: string;
      readonly userMessage: DesignMateChatMessage;
      readonly assistantMessage: DesignMateChatMessage;
      readonly providerLabel: string;
      readonly answerContext: DesignMateChatAnswerContext;
    }
  | {
      readonly type: "stream-event";
      readonly turnId: string;
      readonly event: DesignMateChatEvent;
    }
  | {
      readonly type: "restore";
      readonly entries: readonly DesignMateChatTranscriptEntry[];
    }
  | {
      readonly type: "proposal-outcome";
      readonly event: DesignMateConversationMemoryEvent;
    }
  | { readonly type: "clear" };

export const EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT: DesignMateChatTranscriptState =
  Object.freeze({
    entries: Object.freeze([]),
    activeTurn: null,
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/.test(octet) &&
        Number(octet) >= 0 &&
        Number(octet) <= 255,
    )
  );
}

/**
 * Validate the browser-facing service setting without needing window.location.
 * Relative values are normalized to root-relative, same-origin paths.
 */
export function normalizeDesignMateServiceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > SERVICE_URL_LIMIT ||
    candidate.includes("#") ||
    candidate.includes("\\") ||
    /[\s\u0000-\u001f\u007f]/.test(candidate) ||
    candidate.startsWith("//")
  ) {
    return null;
  }

  const absolute = /^[a-z][a-z\d+.-]*:/i.test(candidate);
  let parsed: URL;
  try {
    parsed = new URL(candidate, `${RELATIVE_URL_BASE}/`);
  } catch {
    return null;
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    return null;
  }

  if (!absolute) {
    const normalized =
      parsed.origin === RELATIVE_URL_BASE
        ? `${parsed.pathname}${parsed.search}`
        : null;
    return normalized && normalized.length <= SERVICE_URL_LIMIT
      ? normalized
      : null;
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    return null;
  }
  const normalized = parsed.toString();
  return normalized.length <= SERVICE_URL_LIMIT ? normalized : null;
}

/**
 * The environment setting names the service root. A setting that already
 * includes the versioned chat route is also accepted for proxy deployments.
 */
export function resolveDesignMateChatEndpoint(value: unknown): string | null {
  const normalized = normalizeDesignMateServiceUrl(value);
  if (!normalized) {
    return null;
  }
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(normalized);
  const url = new URL(normalized, `${RELATIVE_URL_BASE}/`);
  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, "");
  if (!pathWithoutTrailingSlash.endsWith(CHAT_ROUTE)) {
    url.pathname = `${pathWithoutTrailingSlash}${CHAT_ROUTE}`;
  } else {
    url.pathname = pathWithoutTrailingSlash;
  }
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

export const DESIGN_MATE_CHAT_ENDPOINT = resolveDesignMateChatEndpoint(
  import.meta.env.VITE_DESIGN_MATE_SERVICE_URL,
);

export type DesignMateChatProviderFactories = {
  readonly createRemote: (options: {
    readonly endpoint: string;
    readonly getAccessToken?: DesignMateAccessTokenProvider;
    readonly credentials?: RequestCredentials;
  }) => DesignMateChatProvider;
  readonly createLocal: () => DesignMateChatProvider;
  readonly createFallback: (
    primary: DesignMateChatProvider,
    fallback: DesignMateChatProvider,
  ) => DesignMateChatProvider;
};

export type DesignMateChatProviderSetup = {
  readonly mode: DesignMateChatMode;
  readonly provider: DesignMateChatProvider;
};

/**
 * Provider fallback behavior is delegated to @openlogo/design-mate. Factories
 * are injected so this pure helper stays out of the initial chat UI chunk.
 */
export function createDesignMateChatProviderSetup(
  endpoint: string | null,
  factories: DesignMateChatProviderFactories,
  remoteOptions: {
    readonly getAccessToken?: DesignMateAccessTokenProvider;
    readonly credentials?: RequestCredentials;
  } = {},
): DesignMateChatProviderSetup {
  const local = factories.createLocal();
  if (!endpoint) {
    return { mode: "local", provider: local };
  }
  const remote = factories.createRemote({ endpoint, ...remoteOptions });
  return {
    mode: "remote-with-fallback",
    provider: factories.createFallback(remote, local),
  };
}

export function designMateChatModeLabel(mode: DesignMateChatMode): string {
  return mode === "remote-with-fallback"
    ? "AI + local fallback"
    : "Local guidance";
}
export type DesignMateTranscriptScrollMetrics = {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
};

export function isDesignMateTranscriptNearBottom(
  metrics: DesignMateTranscriptScrollMetrics,
  threshold = 40,
): boolean {
  if (
    ![metrics.scrollHeight, metrics.scrollTop, metrics.clientHeight, threshold].every(
      Number.isFinite,
    ) ||
    metrics.scrollHeight < 0 ||
    metrics.clientHeight < 0 ||
    threshold < 0
  ) {
    return false;
  }
  const distance =
    metrics.scrollHeight -
    metrics.clientHeight -
    Math.max(0, metrics.scrollTop);
  return distance <= threshold;
}

function designMateChatErrorLabel(
  error: DesignMateProviderError,
): string {
  switch (error.code) {
    case "cancelled":
      return "Response stopped.";
    case "rate-limited":
      return "The AI service is busy. Try again.";
    case "invalid-request":
      return "This request could not be sent. Try a shorter prompt.";
    case "authentication-required":
      return "The AI service needs a valid sign-in or access token.";
    case "origin-not-allowed":
      return "This OpenLogo address is not allowed by the AI service.";
    case "request-too-large":
      return "The request is too large. Try a smaller scope or fewer previews.";
    case "request-timeout":
      return "The AI service timed out. Try again.";
    case "invalid-chat-response":
    case "invalid-review":
      return "Design Mate returned an unusable response. Try again.";
    case "provider-failed":
      return "Design Mate could not finish this response. Try again.";
  }
}

let fallbackIdSequence = 0;

export function createDesignMateChatId(prefix = "chat"): string {
  const safePrefix =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "chat";
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `${safePrefix}-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // Restricted webviews can expose crypto while denying randomUUID.
  }
  fallbackIdSequence = (fallbackIdSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${safePrefix}-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
}

export function boundDesignMateChatHistory(
  messages: readonly DesignMateChatMessage[],
): readonly DesignMateChatMessage[] {
  const pairs: Array<
    readonly [DesignMateChatMessage, DesignMateChatMessage]
  > = [];
  const ids = new Set<string>();
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const user = messages[index]!;
    const assistant = messages[index + 1]!;
    if (
      user.role !== "user" ||
      assistant.role !== "assistant" ||
      user.text.trim().length === 0 ||
      assistant.text.trim().length === 0 ||
      user.id === assistant.id ||
      ids.has(user.id) ||
      ids.has(assistant.id)
    ) {
      continue;
    }
    ids.add(user.id);
    ids.add(assistant.id);
    pairs.push([
      {
        id: user.id,
        role: "user",
        text: user.text.slice(0, DESIGN_MATE_CHAT_LIMITS.userTextLength),
        createdAt: user.createdAt,
      },
      {
        id: assistant.id,
        role: "assistant",
        text: assistant.text.slice(
          0,
          DESIGN_MATE_CHAT_LIMITS.assistantTextLength,
        ),
        createdAt: assistant.createdAt,
      },
    ]);
  }
  const maximumPairs = Math.floor(
    DESIGN_MATE_CHAT_LIMITS.historyMessages / 2,
  );
  return pairs.slice(-maximumPairs).flatMap((pair) => pair);
}

export function designMateChatHistoryFromTranscript(
  entries: readonly DesignMateChatTranscriptEntry[],
  currentAnswerContext: DesignMateChatAnswerContext,
): readonly DesignMateChatMessage[] {
  const pairs: Array<
    readonly [DesignMateChatTranscriptEntry, DesignMateChatTranscriptEntry]
  > = [];
  const ids = new Set<string>();
  let cursor = entries.length - 1;

  // Failed attempts remain visible, but retrying should resume from the last
  // successful turn instead of sending the failed user message as an orphan.
  while (cursor >= 1) {
    const assistant = entries[cursor]!;
    const user = entries[cursor - 1]!;
    if (
      assistant.role !== "assistant" ||
      user.role !== "user" ||
      (assistant.status !== "failed" && assistant.status !== "cancelled")
    ) {
      break;
    }
    cursor -= 2;
  }

  // History is one contiguous suffix. Crossing an incomplete, malformed, or
  // stale turn could make an old answer look applicable to the current canvas.
  while (cursor >= 1) {
    const assistant = entries[cursor]!;
    const user = entries[cursor - 1]!;
    if (
      assistant.role !== "assistant" ||
      user.role !== "user" ||
      assistant.status !== "complete" ||
      user.status !== "complete" ||
      assistant.text.trim().length === 0 ||
      user.text.trim().length === 0 ||
      !assistant.answerContext ||
      !designMateDocumentIdentitiesEqual(
        assistant.answerContext.identity,
        currentAnswerContext.identity,
      ) ||
      !designMateRequestSignaturesEqual(
        assistant.answerContext.request,
        currentAnswerContext.request,
      ) ||
      assistant.id === user.id ||
      ids.has(assistant.id) ||
      ids.has(user.id)
    ) {
      break;
    }
    ids.add(assistant.id);
    ids.add(user.id);
    pairs.unshift([user, assistant]);
    cursor -= 2;
  }

  return boundDesignMateChatHistory(
    pairs.flatMap(([user, assistant]) => [
      {
        id: user.id,
        role: user.role,
        text: user.text,
        createdAt: user.createdAt,
      },
      {
        id: assistant.id,
        role: assistant.role,
        text: assistant.text,
        createdAt: assistant.createdAt,
      },
    ]),
  );
}

export function designMateConversationMemoryFromTranscript(
  entries: readonly DesignMateChatTranscriptEntry[],
): readonly DesignMateConversationMemoryEvent[] {
  const seen = new Set<string>();
  const events: DesignMateConversationMemoryEvent[] = [];
  for (const entry of entries) {
    for (const event of entry.memory ?? []) {
      if (seen.has(event.id)) {
        continue;
      }
      seen.add(event.id);
      events.push(event);
    }
  }
  return events.slice(-DESIGN_MATE_CHAT_LIMITS.memoryEvents);
}

function updateAssistantEntry(
  state: DesignMateChatTranscriptState,
  update: (
    entry: DesignMateChatTranscriptEntry,
  ) => DesignMateChatTranscriptEntry,
): readonly DesignMateChatTranscriptEntry[] {
  const assistantId = state.activeTurn?.assistantMessageId;
  if (!assistantId) {
    return state.entries;
  }
  return state.entries.map((entry) =>
    entry.id === assistantId && entry.role === "assistant"
      ? update(entry)
      : entry,
  );
}

function boundedAssistantText(text: string): string {
  return text.slice(0, DESIGN_MATE_CHAT_LIMITS.assistantTextLength);
}

export function reduceDesignMateChatTranscript(
  state: DesignMateChatTranscriptState,
  action: DesignMateChatTranscriptAction,
): DesignMateChatTranscriptState {
  if (action.type === "clear") {
    return EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT;
  }
  if (action.type === "restore") {
    if (state.activeTurn !== null) {
      return state;
    }
    return {
      entries: action.entries.slice(-DESIGN_MATE_TRANSCRIPT_LIMIT),
      activeTurn: null,
    };
  }
  if (action.type === "proposal-outcome") {
    if (
      state.entries.some((entry) =>
        entry.memory?.some((memory) => memory.id === action.event.id),
      )
    ) {
      return state;
    }
    if (state.activeTurn !== null) {
      return state;
    }
    let targetIndex = -1;
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index]!;
      if (
        entry.role === "assistant" &&
        entry.memory?.some(
          (memory) => memory.proposalId === action.event.proposalId,
        )
      ) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex < 0) {
      for (let index = state.entries.length - 1; index >= 0; index -= 1) {
        const entry = state.entries[index]!;
        if (entry.role === "assistant" && entry.status === "complete") {
          targetIndex = index;
          break;
        }
      }
      if (targetIndex < 0) {
        return state;
      }
    }
    return {
      entries: state.entries.map((entry, index) =>
        index === targetIndex
          ? {
              ...entry,
              memory: [...(entry.memory ?? []), action.event].slice(
                -DESIGN_MATE_CHAT_LIMITS.memoryEvents,
              ),
            }
          : entry,
      ),
      activeTurn: null,
    };
  }
  if (action.type === "start-turn") {
    if (
      state.activeTurn !== null ||
      action.userMessage.role !== "user" ||
      action.assistantMessage.role !== "assistant"
    ) {
      return state;
    }
    const entries = [
      ...state.entries,
      { ...action.userMessage, status: "complete" as const },
      {
        ...action.assistantMessage,
        status: "streaming" as const,
        providerLabel: action.providerLabel,
        answerContext: action.answerContext,
      },
    ].slice(-DESIGN_MATE_TRANSCRIPT_LIMIT);
    return {
      entries,
      activeTurn: {
        turnId: action.turnId,
        assistantMessageId: action.assistantMessage.id,
        nextDeltaIndex: 0,
        messageStarted: false,
        messageEnded: false,
      },
    };
  }

  const active = state.activeTurn;
  if (!active || active.turnId !== action.turnId) {
    return state;
  }
  const event = action.event;
  if (event.type === "started") {
    return state;
  }
  if (event.type === "context") {
    return state;
  }
  if (event.type === "message-start") {
    if (
      active.messageStarted ||
      active.messageEnded ||
      event.messageId !== active.assistantMessageId
    ) {
      return state;
    }
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        ...entry,
        createdAt: event.createdAt,
      })),
      activeTurn: { ...active, messageStarted: true },
    };
  }
  if (event.type === "text-delta") {
    if (
      !active.messageStarted ||
      active.messageEnded ||
      event.messageId !== active.assistantMessageId ||
      event.index !== active.nextDeltaIndex
    ) {
      return state;
    }
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        ...entry,
        text: boundedAssistantText(`${entry.text}${event.delta}`),
      })),
      activeTurn: {
        ...active,
        nextDeltaIndex: active.nextDeltaIndex + 1,
      },
    };
  }
  if (
    event.type === "proposal-prepared" ||
    event.type === "proposal-rejected"
  ) {
    if (
      !active.messageStarted ||
      active.messageEnded ||
      event.messageId !== active.assistantMessageId
    ) {
      return state;
    }
    const memoryEvent: Omit<DesignMateConversationMemoryEvent, "createdAt"> =
      event.type === "proposal-prepared"
        ? {
            id: `${active.turnId}:proposal:${event.index}`,
            proposalId: event.prepared.proposal.id,
            label: event.prepared.proposal.label,
            status: "prepared",
            summary: event.prepared.impact.summaries.join(" · ").slice(
              0,
              DESIGN_MATE_CHAT_LIMITS.memorySummaryLength,
            ),
          }
        : {
            id: `${active.turnId}:rejected:${event.index}`,
            proposalId: event.proposalId,
            label: "Rejected suggestion",
            status: "rejected",
            summary: event.error.message.slice(
              0,
              DESIGN_MATE_CHAT_LIMITS.memorySummaryLength,
            ),
          };
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        ...entry,
        memory: [
          ...(entry.memory ?? []),
          { ...memoryEvent, createdAt: entry.createdAt },
        ].slice(-DESIGN_MATE_CHAT_LIMITS.memoryEvents),
      })),
      activeTurn: active,
    };
  }
  if (event.type === "message-end") {
    if (
      !active.messageStarted ||
      active.messageEnded ||
      event.message.id !== active.assistantMessageId
    ) {
      return state;
    }
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        id: entry.id,
        role: entry.role,
        text: boundedAssistantText(event.message.text),
        createdAt: event.message.createdAt,
        status: "complete",
        ...(entry.providerLabel
          ? { providerLabel: entry.providerLabel }
          : {}),
        ...(entry.answerContext
          ? { answerContext: entry.answerContext }
          : {}),
        ...(entry.memory ? { memory: entry.memory } : {}),
      })),
      activeTurn: { ...active, messageEnded: true },
    };
  }
  if (event.type === "completed") {
    if (
      !active.messageEnded ||
      event.message.id !== active.assistantMessageId
    ) {
      return state;
    }
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        ...entry,
        text: boundedAssistantText(event.message.text),
        createdAt: event.message.createdAt,
        status: "complete",
      })),
      activeTurn: null,
    };
  }
  if (event.type === "failed" || event.type === "cancelled") {
    return {
      entries: updateAssistantEntry(state, (entry) => ({
        ...entry,
        status: event.type === "failed" ? "failed" : "cancelled",
        errorLabel: designMateChatErrorLabel(event.error),
      })),
      activeTurn: null,
    };
  }
  return state;
}

function designMateDocumentIdentitiesEqual(
  left: DocumentIdentity,
  right: DocumentIdentity,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.revision === right.revision &&
    left.contentFingerprint === right.contentFingerprint
  );
}

export function isDesignMateChatAnswerStale(
  answer: DesignMateChatAnswerContext,
  currentIdentity: DocumentIdentity,
  currentRequest: DesignMateRequestSignature,
): boolean {
  return (
    !designMateDocumentIdentitiesEqual(answer.identity, currentIdentity) ||
    !designMateRequestSignaturesEqual(answer.request, currentRequest)
  );
}
