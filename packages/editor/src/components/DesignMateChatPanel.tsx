import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LogoDocument } from "@openlogo/core";
import { Send, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import {
  DESIGN_MATE_CHAT_LIMITS,
  buildDocumentIdentity,
  createDirectDesignMateChatProvider,
  createOpenAIResponsesTransport,
  createRemoteDesignMateChatProvider,
  makeDesignMateChatCancelledError,
  makeDesignMateProviderError,
  streamDesignMateChat,
  type DesignMateChatMessage,
  type DesignMateChatProvider,
  type DesignMateConversationMemoryEvent,
  type DesignMateSelection,
  type DesignMateVisualAttachment,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import {
  DESIGN_MATE_CHAT_ENDPOINT,
  createDesignMateChatId,
  designMateChatHistoryFromTranscript,
  designMateConversationMemoryFromTranscript,
  getDesignMateAccessToken,
  isDesignMateTranscriptNearBottom,
  isDesignMateChatAnswerStale,
  reduceDesignMateChatTranscript,
  type DesignMateChatAnswerContext,
} from "../lib/design-mate-chat";
import {
  clearDesignMateChatSession,
  loadDesignMateChatSession,
  saveDesignMateChatSession,
} from "../lib/design-mate-session";
import {
  createDesignMateRequestSignature,
  resolveEffectiveDesignMateScope,
} from "../lib/design-mate-review";
import {
  loadDesignMateProviderSettings,
  subscribeDesignMateProviderSettings,
} from "../lib/design-mate-settings";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const STARTER_PROMPTS = [
  "Be honest—what should I refine first?",
  "Will this still feel clear at 16 px?",
  "Does this actually feel like the brief?",
] as const;

const META_ACTION =
  "font-[650] text-ink-dim transition-colors duration-140 ease-studio hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-40";

type ActiveRun = {
  readonly runId: number;
  readonly turnId: string;
  readonly provider: DesignMateChatProvider;
};

export type DesignMateChatProposalBatch = {
  readonly baseDocument: LogoDocument;
  readonly answerContext: DesignMateChatAnswerContext;
  readonly proposals: readonly PreparedDesignMateProposal[];
  readonly rejectedCount: number;
};

export type DesignMateChatPanelProps = {
  readonly disabled?: boolean;
  readonly controls?: ReactNode;
  readonly onRunningChange?: (running: boolean) => void;
  readonly onProposalsClear?: () => void;
  readonly onProposalsReady?: (batch: DesignMateChatProposalBatch) => void;
  readonly onProposalOutcomeConsumed?: (eventId: string) => void;
  readonly proposalOutcome?: DesignMateConversationMemoryEvent | null;
};

function isoNow(): string {
  return new Date().toISOString();
}

function visualCaptureNote(
  count: number,
  failed: number,
): string {
  if (count === 0) {
    return "Visual preview unavailable; continuing with bounded document context.";
  }
  if (failed > 0) {
    return `${count} bounded ${count === 1 ? "preview" : "previews"} attached; some visual context was unavailable.`;
  }
  return `${count} bounded ${count === 1 ? "preview" : "previews"} attached.`;
}

export function DesignMateChatPanel({
  disabled = false,
  controls,
  onRunningChange,
  onProposalsClear,
  onProposalsReady,
  onProposalOutcomeConsumed,
  proposalOutcome = null,
}: DesignMateChatPanelProps) {
  const document = useDocument();
  const documentGeneration = documentStore.documentGeneration;
  const committedRevision = documentStore.committedRevision;
  const headingId = useId();
  const statusId = useId();
  const [prompt, setPrompt] = useState("");
  const [visualNote, setVisualNote] = useState<string | null>(null);
  const [chipsDismissed, setChipsDismissed] = useState(false);
  const [transcript, dispatch] = useReducer(
    reduceDesignMateChatTranscript,
    document.id,
    loadDesignMateChatSession,
  );
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const onProposalsClearRef = useRef(onProposalsClear);
  onProposalsClearRef.current = onProposalsClear;
  const conversationId = useRef(createDesignMateChatId("conversation"));
  const runSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const transcriptLogRef = useRef<HTMLDivElement | null>(null);
  const stickTranscriptToBottomRef = useRef(true);
  const previousHead = useRef({
    documentId: document.id,
    generation: documentGeneration,
  });
  const persistenceDocumentIdRef = useRef(document.id);
  const consumedProposalOutcomeIdRef = useRef<string | null>(null);

  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const activeGroupId = useEditorStore((state) => state.activeGroupId);
  const requestedScope = useEditorStore((state) => state.designMateScope);
  const remoteEnabled = useEditorStore(
    (state) => state.designMateRemoteEnabled,
  );
  const setRemoteEnabled = useEditorStore(
    (state) => state.setDesignMateRemoteEnabled,
  );

  const providerSettings = useSyncExternalStore(
    subscribeDesignMateProviderSettings,
    loadDesignMateProviderSettings,
  );

  const chatProvider = useMemo(() => {
    if (!remoteEnabled) {
      return null;
    }
    if (providerSettings) {
      return createDirectDesignMateChatProvider(
        createOpenAIResponsesTransport({
          apiKey: providerSettings.apiKey,
          model: providerSettings.model,
          baseUrl: providerSettings.baseUrl,
          id: "openai-direct",
        }),
      );
    }
    return DESIGN_MATE_CHAT_ENDPOINT
      ? createRemoteDesignMateChatProvider({
          endpoint: DESIGN_MATE_CHAT_ENDPOINT,
          getAccessToken: getDesignMateAccessToken,
        })
      : null;
  }, [providerSettings, remoteEnabled]);
  const providerConfigured =
    providerSettings !== null || DESIGN_MATE_CHAT_ENDPOINT !== null;
  const modeLabel = !providerConfigured
    ? "AI not configured"
    : !remoteEnabled
      ? "AI off"
      : providerSettings
        ? "AI (your API key)"
        : "AI (service)";
  const chatAvailable = chatProvider !== null;
  const effectiveScope = resolveEffectiveDesignMateScope(
    requestedScope,
    document,
    selectedNodeIds,
  );
  const currentRequest = createDesignMateRequestSignature(effectiveScope, {
    selectedNodeIds,
    ...(keyObjectId ? { keyObjectId } : {}),
    ...(activeGroupId ? { activeGroupId } : {}),
  });
  const latestAnswer = [...transcript.entries]
    .reverse()
    .find(
      (entry) => entry.role === "assistant" && entry.answerContext !== undefined,
    );
  const hasAnswer = latestAnswer !== undefined;
  const currentIdentity = useMemo(
    () =>
      hasAnswer
        ? buildDocumentIdentity(document, {
            generation: documentGeneration,
            revision: committedRevision,
          })
        : null,
    [committedRevision, document, documentGeneration, hasAnswer],
  );

  useEffect(() => {
    if (persistenceDocumentIdRef.current === document.id) {
      saveDesignMateChatSession(document.id, transcript.entries);
    }
  }, [document.id, transcript.entries]);

  useEffect(() => {
    if (
      !proposalOutcome ||
      consumedProposalOutcomeIdRef.current === proposalOutcome.id
    ) {
      return;
    }
    consumedProposalOutcomeIdRef.current = proposalOutcome.id;
    dispatch({ type: "proposal-outcome", event: proposalOutcome });
    onProposalOutcomeConsumed?.(proposalOutcome.id);
  }, [onProposalOutcomeConsumed, proposalOutcome]);

  useEffect(() => {
    const changed =
      previousHead.current.documentId !== document.id ||
      previousHead.current.generation !== documentGeneration;
    if (!changed) {
      return;
    }
    previousHead.current = {
      documentId: document.id,
      generation: documentGeneration,
    };
    runSequence.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeRunRef.current = null;
    conversationId.current = createDesignMateChatId("conversation");
    persistenceDocumentIdRef.current = document.id;
    stickTranscriptToBottomRef.current = true;
    dispatch({
      type: "restore",
      entries: loadDesignMateChatSession(document.id).entries,
    });
    setPrompt("");
    setVisualNote(null);
    onProposalsClearRef.current?.();
  }, [document.id, documentGeneration]);

  useEffect(
    () => () => {
      runSequence.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      activeRunRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const log = transcriptLogRef.current;
    if (log && stickTranscriptToBottomRef.current) {
      log.scrollTop = log.scrollHeight;
    }
  }, [transcript.entries]);

  const stale =
    latestAnswer?.answerContext !== undefined &&
    currentIdentity !== null &&
    isDesignMateChatAnswerStale(
      latestAnswer.answerContext,
      currentIdentity,
      currentRequest,
    );
  const retryPrompt =
    latestAnswer &&
    (latestAnswer.status === "failed" ||
      latestAnswer.status === "cancelled")
      ? [...transcript.entries]
          .reverse()
          .find((entry) => entry.role === "user")?.text
      : undefined;
  const running = transcript.activeTurn !== null;

  useEffect(() => {
    onRunningChange?.(running);
    return () => {
      if (running) {
        onRunningChange?.(false);
      }
    };
  }, [onRunningChange, running]);

  function isCurrentRun(runId: number, controller: AbortController): boolean {
    return (
      runSequence.current === runId &&
      controllerRef.current === controller &&
      !controller.signal.aborted
    );
  }

  function stop(): void {
    const active = activeRunRef.current;
    const controller = controllerRef.current;
    if (!active || !controller) {
      return;
    }
    runSequence.current += 1;
    controller.abort();
    controllerRef.current = null;
    activeRunRef.current = null;
    dispatch({
      type: "stream-event",
      turnId: active.turnId,
      event: {
        type: "cancelled",
        error: makeDesignMateChatCancelledError(active.provider.id),
      },
    });
    onProposalsClear?.();
    setVisualNote("Response stopped. Partial text was kept.");
  }

  function clear(): void {
    if (disabled) {
      return;
    }
    runSequence.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeRunRef.current = null;
    conversationId.current = createDesignMateChatId("conversation");
    stickTranscriptToBottomRef.current = true;
    clearDesignMateChatSession(document.id);
    dispatch({ type: "clear" });
    setVisualNote(null);
    onProposalsClear?.();
  }

  async function sendPrompt(text = prompt): Promise<void> {
    const provider = chatProvider;
    const userText = text.trim().slice(
      0,
      DESIGN_MATE_CHAT_LIMITS.userTextLength,
    );
    if (
      disabled ||
      !provider ||
      userText.length === 0 ||
      controllerRef.current !== null
    ) {
      return;
    }

    // These committed values are read exactly once and retained for the turn.
    const committedDocument = documentStore.committedDocument;
    const generation = documentStore.documentGeneration;
    const revision = documentStore.committedRevision;
    const editorState = useEditorStore.getState();
    const selection: DesignMateSelection = {
      selectedNodeIds: [...editorState.selectedNodeIds],
      ...(editorState.keyObjectId
        ? { keyObjectId: editorState.keyObjectId }
        : {}),
      ...(editorState.activeGroupId
        ? { activeGroupId: editorState.activeGroupId }
        : {}),
    };
    const scope = resolveEffectiveDesignMateScope(
      editorState.designMateScope,
      committedDocument,
      selection.selectedNodeIds,
    );
    const request = createDesignMateRequestSignature(scope, selection);
    const identity = buildDocumentIdentity(committedDocument, {
      generation,
      revision,
    });
    const turnId = createDesignMateChatId("turn");
    const userMessage: DesignMateChatMessage = {
      id: createDesignMateChatId("user"),
      role: "user",
      text: userText,
      createdAt: isoNow(),
    };
    const assistantMessage: DesignMateChatMessage = {
      id: createDesignMateChatId("assistant"),
      role: "assistant",
      text: "",
      createdAt: isoNow(),
    };
    const history = designMateChatHistoryFromTranscript(
      transcriptRef.current.entries,
      { identity, request },
    );
    const memory = designMateConversationMemoryFromTranscript(
      transcriptRef.current.entries,
    );
    const controller = new AbortController();
    const runId = runSequence.current + 1;
    runSequence.current = runId;
    controllerRef.current = controller;
    activeRunRef.current = {
      runId,
      turnId,
      provider,
    };
    onProposalsClear?.();
    dispatch({
      type: "start-turn",
      turnId,
      userMessage,
      assistantMessage,
      providerLabel: modeLabel,
      answerContext: { identity, request },
    });
    setPrompt("");

    let attachments: readonly DesignMateVisualAttachment[] = [];
    setVisualNote("Preparing a bounded visual preview…");
    try {
      const visual = await import("../lib/design-mate-visual-context");
      if (!isCurrentRun(runId, controller)) {
        return;
      }
      const capture = await visual.captureDesignMateVisualContext(
        committedDocument,
        selection,
        {
          scope,
          generation,
          revision,
          signal: controller.signal,
        },
      );
      if (!isCurrentRun(runId, controller)) {
        return;
      }
      attachments = capture.attachments;
      setVisualNote(
        visualCaptureNote(
          capture.attachments.length,
          capture.failedTargets,
        ),
      );
    } catch {
      if (!isCurrentRun(runId, controller)) {
        return;
      }
      setVisualNote(
        "Visual preview unavailable; continuing with bounded document context.",
      );
    }

    if (!isCurrentRun(runId, controller)) {
      return;
    }
    try {
      const preparedProposals: PreparedDesignMateProposal[] = [];
      let rejectedCount = 0;
      let completed = false;
      const stream = streamDesignMateChat(
        committedDocument,
        selection,
        {
          conversationId: conversationId.current,
          turnId,
          assistantMessageId: assistantMessage.id,
          history,
          memory,
          userMessage,
          attachments,
        },
        {
          scope,
          generation,
          revision,
          provider,
          signal: controller.signal,
        },
      );
      for await (const event of stream) {
        if (!isCurrentRun(runId, controller)) {
          return;
        }
        if (event.type === "proposal-prepared") {
          preparedProposals.push(event.prepared);
          onProposalsReady?.({
            baseDocument: committedDocument,
            answerContext: { identity, request },
            proposals: [...preparedProposals],
            rejectedCount,
          });
        } else if (event.type === "proposal-rejected") {
          rejectedCount += 1;
        } else if (event.type === "completed") {
          completed = true;
        } else if (event.type === "failed" || event.type === "cancelled") {
          onProposalsClear?.();
        }
        dispatch({ type: "stream-event", turnId, event });
      }
      if (completed && isCurrentRun(runId, controller)) {
        onProposalsReady?.({
          baseDocument: committedDocument,
          answerContext: { identity, request },
          proposals: preparedProposals,
          rejectedCount,
        });
      }
    } catch {
      if (!isCurrentRun(runId, controller)) {
        return;
      }
      onProposalsClear?.();
      dispatch({
        type: "stream-event",
        turnId,
        event: {
          type: "failed",
          error: makeDesignMateProviderError(
            provider.id,
            "Design Mate could not start this response.",
            { code: "invalid-request", retryable: false },
          ),
        },
      });
    } finally {
      if (runSequence.current === runId) {
        controllerRef.current = null;
        activeRunRef.current = null;
      }
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void sendPrompt();
    }
  }

  const characterLimit = DESIGN_MATE_CHAT_LIMITS.userTextLength;
  const nearLimit = prompt.length >= Math.floor(characterLimit * 0.85);
  const showChips =
    chatAvailable && transcript.entries.length === 0 && !chipsDismissed;

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Chat with Design Mate"
      aria-busy={running}
    >
      <div
        ref={transcriptLogRef}
        className="min-h-0 flex-1 overflow-y-auto px-13 py-11"
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Design Mate conversation"
        onScroll={(event) => {
          stickTranscriptToBottomRef.current =
            isDesignMateTranscriptNearBottom(event.currentTarget);
        }}
      >
        {transcript.entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-16 text-center">
            <Sparkles
              size={16}
              className="text-ink-faint"
              aria-hidden="true"
            />
            <p className="m-0 mt-3 text-[11px] font-[600] text-ink-dim">
              {providerConfigured
                ? "Ask me anything about this logo"
                : "Connect a model provider"}
            </p>
            <p className="m-0 text-[10px] leading-[1.5] text-ink-faint">
              {providerConfigured
                ? "Hierarchy, character, scale, or the brief — nothing changes unless you say so."
                : "Open Settings (gear) and add your API key to use chat."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {transcript.entries.map((entry) => (
              <article
                key={entry.id}
                className={`max-w-[88%] px-9 py-7 text-ink ${
                  entry.role === "user"
                    ? "ml-auto rounded-[12px] rounded-br-[4px] bg-accent/20"
                    : "mr-auto rounded-[12px] rounded-bl-[4px] border border-panel-hairline bg-card"
                }`}
              >
                <p className="m-0 whitespace-pre-wrap break-words text-[11px] leading-[1.55]">
                  {entry.text ? (
                    entry.text
                  ) : entry.status === "streaming" ? (
                    <span className="inline-flex items-center gap-3 py-2">
                      {[0, 1, 2].map((dot) => (
                        <span
                          key={dot}
                          className="h-4 w-4 animate-pulse rounded-full bg-ink-dim"
                          style={{ animationDelay: `${dot * 160}ms` }}
                          aria-hidden="true"
                        />
                      ))}
                      <span className="sr-only">
                        Design Mate is thinking
                      </span>
                    </span>
                  ) : (
                    "No response was produced."
                  )}
                </p>
                {entry.role === "assistant" &&
                  (entry.status === "failed" ||
                    entry.status === "cancelled") && (
                    <span
                      className={`mt-4 block text-[9px] ${
                        entry.status === "failed"
                          ? "text-danger"
                          : "text-ink-dim"
                      }`}
                    >
                      {entry.errorLabel}
                    </span>
                  )}
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-panel-hairline px-13 pb-10 pt-9">
        {providerConfigured && (
          <div className="mb-8 flex items-start gap-6 rounded-[8px] bg-field px-9 py-7">
            <ShieldCheck
              size={12}
              className="mt-1 shrink-0 text-accent"
              aria-hidden="true"
            />
            <p className="m-0 min-w-0 flex-1 text-[9px] leading-[1.5] text-ink-dim">
              {remoteEnabled
                ? "AI is on — messages, bounded design context, review findings, and up to three PNG previews go to the configured model provider. The raw OpenLogo document is never uploaded. "
                : "AI is off — no chat data leaves this browser. Enabling AI sends messages, bounded design context, review findings, and up to three PNG previews to the configured model provider. "}
              <button
                type="button"
                className="font-[650] text-accent disabled:opacity-40"
                onClick={() => {
                  setVisualNote(null);
                  setRemoteEnabled(!remoteEnabled);
                }}
                disabled={running}
              >
                {remoteEnabled ? "Disable AI" : "Enable AI"}
              </button>
            </p>
          </div>
        )}

        {stale && (
          <p
            role="status"
            className="mx-0 mb-7 mt-0 text-[9px] leading-[1.4] text-warn-ink"
          >
            The canvas or request scope changed after this answer. Ask again
            for current guidance.
          </p>
        )}

        {showChips && (
          <div className="mb-8 flex flex-wrap items-center gap-5">
            {STARTER_PROMPTS.map((starter) => (
              <button
                key={starter}
                type="button"
                className="rounded-full border border-panel-hairline bg-card px-9 py-4 text-[9.5px] leading-[1.35] text-ink-dim transition-colors duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:opacity-40"
                onClick={() => void sendPrompt(starter)}
                disabled={running || disabled}
              >
                {starter}
              </button>
            ))}
            <button
              type="button"
              className="grid h-16 w-16 place-items-center rounded-full text-ink-faint transition-colors duration-140 ease-studio hover:text-ink"
              onClick={() => setChipsDismissed(true)}
              aria-label="Dismiss suggested prompts"
            >
              <X size={10} aria-hidden="true" />
            </button>
          </div>
        )}

        {controls && <div className="mb-8">{controls}</div>}

        <div className="relative">
          <label className="sr-only" htmlFor={`${headingId}-composer`}>
            Message Design Mate
          </label>
          <textarea
            id={`${headingId}-composer`}
            className="min-h-44 w-full resize-none rounded-[10px] border border-field-border bg-field py-8 pl-9 pr-40 text-[11px] leading-[1.45] text-ink outline-none transition-[border-color,box-shadow,background-color] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent focus:bg-card focus:shadow-ring"
            value={prompt}
            maxLength={characterLimit}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={
              chatAvailable
                ? "Ask about hierarchy, character, scale…"
                : "Configure and enable a model provider to chat…"
            }
            title="Enter to send · Shift+Enter for a new line"
            aria-describedby={statusId}
            disabled={running || disabled || !chatAvailable}
          />
          <button
            type="button"
            className={`absolute bottom-8 right-7 grid h-26 w-26 place-items-center rounded-[8px] transition-[background-color,filter,opacity] duration-140 ease-studio ${
              running
                ? "bg-chrome-raised text-ink hover:bg-chrome-active"
                : "bg-accent text-white hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-35"
            }`}
            onClick={running ? stop : () => void sendPrompt()}
            disabled={
              !running &&
              (disabled || !chatAvailable || prompt.trim().length === 0)
            }
            aria-label={running ? "Stop response" : "Send message"}
          >
            {running ? (
              <Square size={10} fill="currentColor" aria-hidden="true" />
            ) : (
              <Send size={12} aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="mt-6 flex items-center justify-between gap-8 text-[8.5px] text-ink-faint">
          <span
            id={statusId}
            role="status"
            className="min-w-0 truncate"
            title={visualNote ?? undefined}
          >
            {visualNote ?? `${modeLabel} · Conversation stays in this tab`}
          </span>
          <span className="flex shrink-0 items-center gap-8">
            {retryPrompt && (
              <button
                type="button"
                className={META_ACTION}
                onClick={() => void sendPrompt(retryPrompt)}
                disabled={running || disabled || !chatAvailable}
              >
                Retry
              </button>
            )}
            {transcript.entries.length > 0 && (
              <button
                type="button"
                className={META_ACTION}
                onClick={clear}
                disabled={disabled}
              >
                Clear
              </button>
            )}
            {nearLimit && (
              <span className="tabular-nums">
                {prompt.length}/{characterLimit}
              </span>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}
