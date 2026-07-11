import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { LogoDocument } from "@openlogo/core";
import {
  MessageCircle,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import {
  DESIGN_MATE_CHAT_LIMITS,
  buildDocumentIdentity,
  createFallbackDesignMateChatProvider,
  createHeuristicDesignMateChatProvider,
  createRemoteDesignMateChatProvider,
  makeDesignMateChatCancelledError,
  makeDesignMateProviderError,
  streamDesignMateChat,
  type DesignMateChatMessage,
  type DesignMateChatProvider,
  type DesignMateSelection,
  type DesignMateVisualAttachment,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import {
  DESIGN_MATE_CHAT_ENDPOINT,
  EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
  createDesignMateChatId,
  createDesignMateChatProviderSetup,
  designMateChatHistoryFromTranscript,
  designMateConversationMemoryFromTranscript,
  designMateChatModeLabel,
  getDesignMateAccessToken,
  isDesignMateTranscriptNearBottom,
  isDesignMateChatAnswerStale,
  reduceDesignMateChatTranscript,
  type DesignMateChatAnswerContext,
} from "../lib/design-mate-chat";
import {
  createDesignMateRequestSignature,
  resolveEffectiveDesignMateScope,
} from "../lib/design-mate-review";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const STARTER_PROMPTS = [
  "Be honest—what should I refine first?",
  "Will this still feel clear at 16 px?",
  "Does this actually feel like the brief?",
] as const;

const PROVIDER_FACTORIES = {
  createRemote: createRemoteDesignMateChatProvider,
  createLocal: createHeuristicDesignMateChatProvider,
  createFallback: createFallbackDesignMateChatProvider,
};

const SECONDARY =
  "inline-flex items-center justify-center gap-4 rounded-field border border-field-border bg-card px-8 py-5 text-[10.5px] font-[600] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY =
  "inline-flex items-center justify-center gap-5 rounded-field bg-accent px-9 py-6 text-[10.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_3px_rgb(79_107_246/0.3)] transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-45";

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
  readonly onRunningChange?: (running: boolean) => void;
  readonly onProposalsClear?: () => void;
  readonly onProposalsReady?: (batch: DesignMateChatProposalBatch) => void;
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
  onRunningChange,
  onProposalsClear,
  onProposalsReady,
}: DesignMateChatPanelProps) {
  const document = useDocument();
  const documentGeneration = documentStore.documentGeneration;
  const committedRevision = documentStore.committedRevision;
  const headingId = useId();
  const statusId = useId();
  const [prompt, setPrompt] = useState("");
  const [visualNote, setVisualNote] = useState<string | null>(null);
  const [transcript, dispatch] = useReducer(
    reduceDesignMateChatTranscript,
    EMPTY_DESIGN_MATE_CHAT_TRANSCRIPT,
  );
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
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

  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const activeGroupId = useEditorStore((state) => state.activeGroupId);
  const requestedScope = useEditorStore((state) => state.designMateScope);

  const providerSetup = useMemo(
    () =>
      createDesignMateChatProviderSetup(
        DESIGN_MATE_CHAT_ENDPOINT,
        PROVIDER_FACTORIES,
        { getAccessToken: getDesignMateAccessToken },
      ),
    [],
  );
  const modeLabel = designMateChatModeLabel(providerSetup.mode);
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
    stickTranscriptToBottomRef.current = true;
    dispatch({ type: "clear" });
    setPrompt("");
    setVisualNote(null);
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
    dispatch({ type: "clear" });
    setVisualNote(null);
    onProposalsClear?.();
  }

  async function sendPrompt(text = prompt): Promise<void> {
    const userText = text.trim().slice(
      0,
      DESIGN_MATE_CHAT_LIMITS.userTextLength,
    );
    if (
      disabled ||
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
      provider: providerSetup.provider,
    };
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
    if (providerSetup.mode === "remote-with-fallback") {
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
    } else {
      setVisualNote(
        "Local guidance uses bounded document context without uploading a preview.",
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
          provider: providerSetup.provider,
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
      dispatch({
        type: "stream-event",
        turnId,
        event: {
          type: "failed",
          error: makeDesignMateProviderError(
            providerSetup.provider.id,
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

  return (
    <section
      className="rounded-[9px] border border-[rgb(79_107_246/0.22)] bg-card p-9"
      aria-labelledby={headingId}
      aria-busy={running}
    >
      <div className="flex items-start justify-between gap-8">
        <div>
          <h3
            id={headingId}
            className="m-0 flex items-center gap-5 text-[10.5px] font-[650] uppercase tracking-[0.07em] text-ink"
          >
            <MessageCircle size={12} className="text-accent" aria-hidden="true" />
            Chat with Design Mate
          </h3>
          <p className="m-0 mt-2 text-[9.5px] leading-[1.4] text-ink-dim">
            I’ll explain my thinking. Nothing changes unless you say so.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-accent-soft px-6 py-2 text-[8px] font-[650] uppercase tracking-[0.05em] text-accent">
          {modeLabel}
        </span>
      </div>

      <div
        ref={transcriptLogRef}
        className="mt-8 grid max-h-280 min-h-96 gap-7 overflow-y-auto rounded-[7px] border border-panel-hairline bg-field p-7"
        role="log"
        tabIndex={0}
        aria-relevant="additions"
        aria-label="Design Mate conversation"
        onScroll={(event) => {
          stickTranscriptToBottomRef.current =
            isDesignMateTranscriptNearBottom(event.currentTarget);
        }}
      >
        {transcript.entries.length === 0 ? (
          <div className="grid content-start gap-5">
            <p className="m-0 text-[10px] leading-[1.45] text-ink-dim">
              What are you wrestling with? Pick a prompt or ask me directly.
            </p>
            {STARTER_PROMPTS.map((starter) => (
              <button
                key={starter}
                type="button"
                className="rounded-[6px] border border-panel-hairline bg-card px-7 py-5 text-left text-[10px] leading-[1.35] text-ink transition-colors hover:border-accent hover:text-accent"
                onClick={() => void sendPrompt(starter)}
                disabled={running || disabled}
              >
                {starter}
              </button>
            ))}
          </div>
        ) : (
          transcript.entries.map((entry) => (
            <article
              key={entry.id}
              className={`max-w-[92%] rounded-[8px] px-8 py-6 ${
                entry.role === "user"
                  ? "ml-auto bg-accent text-white"
                  : "mr-auto border border-panel-hairline bg-card text-ink"
              }`}
            >
              <span
                className={`block text-[8px] font-[650] uppercase tracking-[0.07em] ${
                  entry.role === "user"
                    ? "text-[rgb(255_255_255/0.72)]"
                    : "text-ink-faint"
                }`}
              >
                {entry.role === "user"
                  ? "You"
                  : entry.providerLabel ?? "Design Mate"}
              </span>
              <p className="m-0 mt-3 whitespace-pre-wrap break-words text-[10.5px] leading-[1.5]">
                {entry.text ||
                  (entry.status === "streaming"
                    ? "Thinking…"
                    : "No response was produced.")}
              </p>
              {entry.role === "assistant" && entry.status !== "complete" && (
                <span
                  className={`mt-4 block text-[9px] ${
                    entry.status === "failed"
                      ? "text-danger"
                      : entry.status === "cancelled"
                        ? "text-ink-dim"
                        : "text-accent"
                  }`}
                >
                  {entry.status === "streaming"
                    ? "Responding…"
                    : entry.errorLabel}
                </span>
              )}
            </article>
          ))
        )}
      </div>

      {stale && (
        <p
          role="status"
          className="mx-0 mb-0 mt-7 rounded-[6px] border border-[#e7c883] bg-[#fff8e8] px-7 py-5 text-[9.5px] leading-[1.4] text-[#73551f]"
        >
          The canvas or request scope changed after this answer. Ask again for
          current guidance.
        </p>
      )}

      {visualNote && (
        <p
          id={statusId}
          role="status"
          className="mx-0 mb-0 mt-6 flex items-start gap-4 text-[9px] leading-[1.4] text-ink-dim"
        >
          <Paperclip size={10} className="mt-1 shrink-0" aria-hidden="true" />
          {visualNote}
        </p>
      )}

      <div className="mt-8 grid gap-6">
        <label className="sr-only" htmlFor={`${headingId}-composer`}>
          Message Design Mate
        </label>
        <textarea
          id={`${headingId}-composer`}
          className="min-h-64 w-full resize-y rounded-field border border-field-border bg-field px-8 py-7 text-[11px] leading-[1.45] text-ink outline-none transition-[border-color,box-shadow,background-color] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent focus:bg-card focus:shadow-ring"
          value={prompt}
          maxLength={DESIGN_MATE_CHAT_LIMITS.userTextLength}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="Ask me about hierarchy, character, scale, or the brief…"
          aria-describedby={visualNote ? statusId : undefined}
          disabled={running || disabled}
        />
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-5">
            <button
              type="button"
              className={SECONDARY}
              onClick={clear}
              disabled={
                disabled ||
                (transcript.entries.length === 0 && !running)
              }
            >
              <Trash2 size={11} aria-hidden="true" />
              Clear
            </button>
            {retryPrompt && (
              <button
                type="button"
                className={SECONDARY}
                onClick={() => void sendPrompt(retryPrompt)}
                disabled={running || disabled}
              >
                <RotateCcw size={11} aria-hidden="true" />
                Retry
              </button>
            )}
          </div>
          <div className="flex items-center gap-5">
            <button
              type="button"
              className={SECONDARY}
              onClick={stop}
              disabled={!running}
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
              Stop
            </button>
            <button
              type="button"
              className={PRIMARY}
              onClick={() => void sendPrompt()}
              disabled={
                running || disabled || prompt.trim().length === 0
              }
            >
              <Send size={11} aria-hidden="true" />
              Send
            </button>
          </div>
        </div>
        <p className="m-0 text-right text-[8.5px] tabular-nums text-ink-faint">
          {prompt.length}/{DESIGN_MATE_CHAT_LIMITS.userTextLength} · Enter to
          send, Shift+Enter for a new line
        </p>
      </div>
    </section>
  );
}
