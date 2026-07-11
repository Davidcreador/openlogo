import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  LocateFixed,
  RefreshCw,
  Save,
  Sparkles,
  Square,
} from "lucide-react";
import {
  collectLeafNodeIds,
  type LogoDocument,
  type ReviewFinding,
  type ReviewScope,
} from "@openlogo/core";
import {
  buildDocumentIdentity,
  buildHeuristicDesignMateProposals,
  collectDesignMateReview,
  isDesignMateProposalStale,
  prepareDesignMateProposal,
  type DesignMateConversationMemoryEvent,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import { fitBounds } from "@openlogo/renderer";
import {
  designBriefFromDraft,
  designBriefToDraft,
  type DesignBriefDraft,
} from "../lib/design-mate-form";
import {
  createDesignMateRequestSignature,
  designMateRequestSignaturesEqual,
  isDesignMateReviewStale,
  resolveEffectiveDesignMateScope,
  resolveDesignMateFocus,
} from "../lib/design-mate-review";
import {
  createDesignMateChatId,
  isDesignMateChatAnswerStale,
  type DesignMateChatAnswerContext,
} from "../lib/design-mate-chat";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";
import type { DesignMateChatProposalBatch } from "./DesignMateChatPanel";

const DesignMateChatPanel = lazy(() =>
  import("./DesignMateChatPanel").then((module) => ({
    default: module.DesignMateChatPanel,
  })),
);

const DesignMateProposalPanel = lazy(() =>
  import("./DesignMateProposalPanel").then((module) => ({
    default: module.DesignMateProposalPanel,
  })),
);

class DesignMateProposalErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Design Mate suggestions failed to load.", error, info);
  }

  componentDidUpdate(previous: { children: ReactNode; resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="rounded-[7px] bg-[rgb(240_86_77/0.1)] px-9 py-7 text-[10.5px] leading-[1.45] text-danger"
        >
          Suggested changes are unavailable. The other Design Mate tools are
          still available.
        </div>
      );
    }
    return this.props.children;
  }
}

class DesignMateChatErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Design Mate chat failed to load.", error, info);
  }

  componentDidUpdate(previous: { children: ReactNode; resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="m-13 rounded-[7px] bg-[rgb(240_86_77/0.1)] px-9 py-7 text-[10.5px] leading-[1.45] text-danger"
        >
          <p className="m-0">
            Conversation is unavailable. The brief, feedback, and suggested
            changes are still available.
          </p>
          <button
            type="button"
            className={`${SECONDARY} mt-6`}
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={11} aria-hidden="true" />
            Reload editor
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const LABEL = "grid gap-4 text-[10.5px] font-[600] text-ink-dim";
const FIELD =
  "min-h-28 w-full rounded-field border border-field-border bg-field px-8 py-6 text-[12px] leading-[1.4] text-ink outline-none transition-[border-color,box-shadow,background-color] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent focus:bg-card focus:shadow-ring";
const TAB =
  "rounded-[5px] px-7 py-3 text-[10px] transition-[background-color,color,box-shadow] duration-120 ease-studio disabled:cursor-default disabled:opacity-35";
const SECONDARY =
  "inline-flex items-center justify-center gap-5 rounded-field border border-field-border bg-card px-9 py-6 text-[11px] font-[600] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY =
  "inline-flex shrink-0 items-center justify-center gap-5 rounded-[7px] bg-accent px-9 py-5 text-[10.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_3px_rgb(124_92_255/0.3)] transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-45";

const SCOPES: ReadonlyArray<{
  id: ReviewScope;
  label: string;
  title: string;
}> = [
  {
    id: "selection",
    label: "Selection",
    title: "Keep Design Mate focused on the selected logo objects",
  },
  {
    id: "active-artboard",
    label: "Artboard",
    title: "Keep Design Mate focused on the active logo artboard",
  },
  {
    id: "document",
    label: "System",
    title: "Let Design Mate consider the full logo system",
  },
];

type ProposalSource = "review" | "chat";

type ApplyingProposal = {
  readonly source: ProposalSource;
  readonly id: string;
};

function applyingProposalsEqual(
  left: ApplyingProposal | null,
  right: ApplyingProposal,
): boolean {
  return left?.source === right.source && left.id === right.id;
}

function providerErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "I couldn’t finish that pass. Give me another try.";
}

function severityLabel(finding: ReviewFinding): string {
  return finding.severity === "strong"
    ? "Important"
    : finding.severity === "warning"
      ? "Warning"
      : "Note";
}

function FindingCard({
  finding,
  onFocus,
  canFocus,
  focused,
  relatedProposal,
  onViewProposal,
}: {
  finding: ReviewFinding;
  onFocus: () => void;
  canFocus: boolean;
  focused: boolean;
  relatedProposal?: PreparedDesignMateProposal;
  onViewProposal?: () => void;
}) {
  return (
    <li
      data-severity={finding.severity}
      aria-current={focused ? "true" : undefined}
      className={`-mx-6 grid gap-4 rounded-[8px] px-6 py-8 transition-[background-color] duration-140 ease-studio ${
        focused ? "bg-[rgb(124_92_255/0.09)]" : ""
      }`}
    >
      <div className="flex items-start gap-6">
        <span
          className={`mt-4 h-5 w-5 shrink-0 rounded-full ${
            finding.severity === "warning"
              ? "bg-[#e4c07a]"
              : finding.severity === "strong"
                ? "bg-danger"
                : "bg-accent"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 text-[11px] font-[650] leading-[1.35] text-ink">
          <span className="sr-only">{severityLabel(finding)}: </span>
          {finding.title}
        </span>
        <span className="shrink-0 text-[8.5px] font-[650] uppercase tracking-[0.06em] text-ink-faint">
          {finding.category}
        </span>
      </div>
      <p className="m-0 pl-11 text-[10.5px] leading-[1.5] text-ink-dim">
        {finding.detail}
      </p>
      {finding.evidence.length > 0 && (
        <p className="m-0 pl-11 text-[9.5px] leading-[1.45] text-ink-faint">
          {finding.evidence
            .slice(0, 2)
            .map(
              (item) =>
                `${item.label}: ${item.value}${item.unit ? ` ${item.unit}` : ""}`,
            )
            .join(" · ")}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-8 pl-11">
        <em className="min-w-0 flex-1 text-[10px] leading-[1.4] text-ink-dim">
          {finding.action}
        </em>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-8">
          {relatedProposal && onViewProposal && (
            <button
              type="button"
              className="text-[10px] font-[650] text-ink-dim transition-colors duration-140 ease-studio hover:text-accent"
              onClick={onViewProposal}
              aria-label={`Review suggested change: ${relatedProposal.proposal.label}`}
            >
              Review fix
            </button>
          )}
          {canFocus && (
            <button
              type="button"
              className="inline-flex items-center gap-4 text-[10px] font-[650] text-accent transition-[filter] duration-140 ease-studio hover:brightness-[1.15]"
              onClick={onFocus}
              aria-label={`${focused ? "Hide" : "Show"} ${finding.title} on canvas`}
              aria-pressed={focused}
            >
              <LocateFixed size={11} aria-hidden="true" />
              {focused ? "Hide" : "Show"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function DesignMateSection() {
  const document = useDocument();
  const documentGeneration = documentStore.documentGeneration;
  const previousDocumentHead = useRef({
    documentId: document.id,
    generation: documentGeneration,
  });
  const latestRun = useRef(0);
  const reviewControllerRef = useRef<AbortController | null>(null);
  const latestProposalAction = useRef(0);
  const applyingProposalRef = useRef<ApplyingProposal | null>(null);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [draft, setDraft] = useState<DesignBriefDraft>(() =>
    designBriefToDraft(document.designBrief),
  );
  const [briefDirty, setBriefDirty] = useState(false);
  const [preparedProposals, setPreparedProposals] = useState<
    readonly PreparedDesignMateProposal[]
  >([]);
  const [proposalBaseDocument, setProposalBaseDocument] =
    useState<LogoDocument | null>(null);
  const [chatPreparedProposals, setChatPreparedProposals] = useState<
    readonly PreparedDesignMateProposal[]
  >([]);
  const [chatProposalBaseDocument, setChatProposalBaseDocument] =
    useState<LogoDocument | null>(null);
  const [chatProposalContext, setChatProposalContext] =
    useState<DesignMateChatAnswerContext | null>(null);
  const [applyingProposal, setApplyingProposal] =
    useState<ApplyingProposal | null>(null);
  const [chatRunning, setChatRunning] = useState(false);
  const [chatMemoryEvent, setChatMemoryEvent] =
    useState<DesignMateConversationMemoryEvent | null>(null);
  const [createdVariantId, setCreatedVariantId] = useState<string | null>(null);

  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const activeGroupId = useEditorStore((state) => state.activeGroupId);
  const scope = useEditorStore((state) => state.designMateScope);
  const reviewSnapshot = useEditorStore((state) => state.designMateReview);
  const canvasFocus = useEditorStore(
    (state) => state.designMateCanvasFocus,
  );
  const status = useEditorStore((state) => state.designMateStatus);
  const error = useEditorStore((state) => state.designMateError);
  const setScope = useEditorStore((state) => state.setDesignMateScope);
  const setReview = useEditorStore((state) => state.setDesignMateReview);
  const setCanvasFocus = useEditorStore(
    (state) => state.setDesignMateCanvasFocus,
  );
  const setStatus = useEditorStore((state) => state.setDesignMateStatus);
  const setError = useEditorStore((state) => state.setDesignMateError);
  const setToast = useEditorStore((state) => state.setToast);

  useEffect(() => {
    setDraft(designBriefToDraft(document.designBrief));
    setBriefDirty(false);

    if (
      previousDocumentHead.current.documentId !== document.id ||
      previousDocumentHead.current.generation !== documentGeneration
    ) {
      previousDocumentHead.current = {
        documentId: document.id,
        generation: documentGeneration,
      };
      latestRun.current += 1;
      reviewControllerRef.current?.abort();
      reviewControllerRef.current = null;
      setReview(null);
      setCanvasFocus(null);
      setStatus("idle");
      setError(null);
      latestProposalAction.current += 1;
      applyingProposalRef.current = null;
      setPreparedProposals([]);
      setProposalBaseDocument(null);
      setChatPreparedProposals([]);
      setChatProposalBaseDocument(null);
      setChatProposalContext(null);
      setApplyingProposal(null);
      setChatRunning(false);
      setChatMemoryEvent(null);
      setCreatedVariantId(null);
    }
  }, [
    document.designBrief,
    document.id,
    documentGeneration,
    setError,
    setCanvasFocus,
    setReview,
    setStatus,
  ]);

  useEffect(
    () => () => {
      latestRun.current += 1;
      reviewControllerRef.current?.abort();
      reviewControllerRef.current = null;
    },
    [],
  );

  const hasSelection =
    collectLeafNodeIds(document, selectedNodeIds).length > 0;
  const effectiveScope = resolveEffectiveDesignMateScope(
    scope,
    document,
    selectedNodeIds,
  );
  const currentRequest = createDesignMateRequestSignature(effectiveScope, {
    selectedNodeIds,
    ...(keyObjectId ? { keyObjectId } : {}),
    ...(activeGroupId ? { activeGroupId } : {}),
  });
  const stale =
    reviewSnapshot !== null &&
    (isDesignMateReviewStale(reviewSnapshot.identity, {
      documentId: document.id,
      generation: documentGeneration,
      revision: documentStore.committedRevision,
    }) ||
      !designMateRequestSignaturesEqual(
        reviewSnapshot.request,
        currentRequest,
      ));
  const chatProposalIdentity =
    chatProposalContext === null
      ? null
      : buildDocumentIdentity(document, {
          generation: documentGeneration,
          revision: documentStore.committedRevision,
        });
  const chatProposalsStale =
    chatProposalContext !== null &&
    chatProposalIdentity !== null &&
    isDesignMateChatAnswerStale(
      chatProposalContext,
      chatProposalIdentity,
      currentRequest,
    );

  useEffect(() => {
    if (stale) {
      setCanvasFocus(null);
    }
  }, [setCanvasFocus, stale]);

  function updateDraft(field: keyof DesignBriefDraft, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setBriefDirty(true);
  }

  function saveBrief(): void {
    const brief = designBriefFromDraft(draft);
    documentStore.apply(
      brief === undefined
        ? { type: "update-brief" }
        : { type: "update-brief", brief },
    );
    setDraft(
      designBriefToDraft(documentStore.committedDocument.designBrief),
    );
    setBriefDirty(false);
  }

  async function runReview(): Promise<void> {
    reviewControllerRef.current?.abort();
    latestProposalAction.current += 1;
    applyingProposalRef.current = null;
    setPreparedProposals([]);
    setProposalBaseDocument(null);
    setApplyingProposal(null);

    if (briefDirty) {
      saveBrief();
    }

    const runId = latestRun.current + 1;
    latestRun.current = runId;
    const controller = new AbortController();
    reviewControllerRef.current = controller;
    setCanvasFocus(null);
    const committedDocument = documentStore.committedDocument;
    const generation = documentStore.documentGeneration;
    const revision = documentStore.committedRevision;
    const requestSelection = {
      selectedNodeIds: [...selectedNodeIds],
      ...(keyObjectId ? { keyObjectId } : {}),
      ...(activeGroupId ? { activeGroupId } : {}),
    };
    const requestSignature = createDesignMateRequestSignature(
      effectiveScope,
      requestSelection,
    );
    setStatus("reviewing");
    setError(null);

    try {
      const result = await collectDesignMateReview(
        committedDocument,
        requestSelection,
        {
          scope: effectiveScope,
          generation,
          revision,
          signal: controller.signal,
        },
      );
      if (latestRun.current !== runId) {
        return;
      }
      const currentState = useEditorStore.getState();
      const currentDocument = documentStore.committedDocument;
      const currentScope = resolveEffectiveDesignMateScope(
        currentState.designMateScope,
        currentDocument,
        currentState.selectedNodeIds,
      );
      const currentSignature = createDesignMateRequestSignature(currentScope, {
        selectedNodeIds: currentState.selectedNodeIds,
        ...(currentState.keyObjectId
          ? { keyObjectId: currentState.keyObjectId }
          : {}),
        ...(currentState.activeGroupId
          ? { activeGroupId: currentState.activeGroupId }
          : {}),
      });
      if (
        currentDocument.id !== committedDocument.id ||
        documentStore.documentGeneration !== generation ||
        documentStore.committedRevision !== revision ||
        !designMateRequestSignaturesEqual(
          requestSignature,
          currentSignature,
        )
      ) {
        setStatus("idle");
        return;
      }
      const nextPreparedProposals: PreparedDesignMateProposal[] = [];
      for (const proposal of buildHeuristicDesignMateProposals(
        committedDocument,
        result.review.findings,
        result.scope,
      )) {
        const preparation = prepareDesignMateProposal(
          committedDocument,
          proposal,
          { generation, revision },
        );
        if (preparation.ok) {
          nextPreparedProposals.push(preparation.prepared);
        }
      }
      setReview({
        review: result.review,
        identity: result.identity,
        scope: result.scope,
        request: requestSignature,
      });
      setPreparedProposals(nextPreparedProposals);
      setProposalBaseDocument(committedDocument);
      setApplyingProposal(null);
      setStatus("complete");
    } catch (cause) {
      if (latestRun.current !== runId || controller.signal.aborted) {
        return;
      }
      setPreparedProposals([]);
      setProposalBaseDocument(null);
      setApplyingProposal(null);
      setReview(null);
      setError(providerErrorMessage(cause));
      setStatus("error");
    } finally {
      if (
        latestRun.current === runId &&
        reviewControllerRef.current === controller
      ) {
        reviewControllerRef.current = null;
      }
    }
  }

  function stopReview(): void {
    if (status !== "reviewing") {
      return;
    }
    latestRun.current += 1;
    reviewControllerRef.current?.abort();
    reviewControllerRef.current = null;
    setStatus(reviewSnapshot ? "complete" : "idle");
    setError(null);
  }

  function clearChatProposals(): void {
    setChatPreparedProposals([]);
    setChatProposalBaseDocument(null);
    setChatProposalContext(null);
  }

  function recordChatProposalOutcome(
    prepared: PreparedDesignMateProposal,
    status: "applied" | "dismissed",
  ): void {
    setChatMemoryEvent({
      id: createDesignMateChatId("outcome"),
      proposalId: prepared.proposal.id,
      label: prepared.proposal.label,
      status,
      summary: prepared.impact.summaries.join(" · ").slice(0, 240),
      createdAt: new Date().toISOString(),
    });
  }

  function consumeChatProposalOutcome(eventId: string): void {
    setChatMemoryEvent((current) =>
      current?.id === eventId ? null : current,
    );
  }

  function receiveChatProposals(batch: DesignMateChatProposalBatch): void {
    const currentDocument = documentStore.committedDocument;
    const currentEditorState = useEditorStore.getState();
    if (
      batch.answerContext.identity.documentId !==
        currentDocument.id ||
      batch.answerContext.identity.generation !==
        documentStore.documentGeneration
    ) {
      return;
    }
    const discardOutdatedBatch = (): void => {
      clearChatProposals();
      if (batch.proposals.length > 0 || batch.rejectedCount > 0) {
        setToast(
          "The canvas or request scope changed before these suggestions could be shown. Ask Design Mate again.",
        );
      }
    };
    const currentScope = resolveEffectiveDesignMateScope(
      currentEditorState.designMateScope,
      currentDocument,
      currentEditorState.selectedNodeIds,
    );
    const latestRequest = createDesignMateRequestSignature(currentScope, {
      selectedNodeIds: currentEditorState.selectedNodeIds,
      ...(currentEditorState.keyObjectId
        ? { keyObjectId: currentEditorState.keyObjectId }
        : {}),
      ...(currentEditorState.activeGroupId
        ? { activeGroupId: currentEditorState.activeGroupId }
        : {}),
    });
    const currentIdentity = buildDocumentIdentity(currentDocument, {
      generation: documentStore.documentGeneration,
      revision: documentStore.committedRevision,
    });
    if (
      isDesignMateChatAnswerStale(
        batch.answerContext,
        currentIdentity,
        latestRequest,
      )
    ) {
      discardOutdatedBatch();
      return;
    }
    const options = {
      generation: batch.answerContext.identity.generation,
      revision: batch.answerContext.identity.revision,
    };
    const baseIdentity = buildDocumentIdentity(batch.baseDocument, options);
    if (
      isDesignMateChatAnswerStale(
        batch.answerContext,
        baseIdentity,
        batch.answerContext.request,
      )
    ) {
      discardOutdatedBatch();
      return;
    }
    const proposals = batch.proposals.filter(
      (prepared) =>
        !isDesignMateProposalStale(
          prepared,
          batch.baseDocument,
          options,
        ),
    );
    setChatPreparedProposals(proposals);
    setChatProposalBaseDocument(
      proposals.length > 0 ? batch.baseDocument : null,
    );
    setChatProposalContext(
      proposals.length > 0 ? batch.answerContext : null,
    );
    if (batch.rejectedCount > 0) {
      setToast(
        `${batch.rejectedCount} Design Mate ${
          batch.rejectedCount === 1 ? "suggestion" : "suggestions"
        } could not be prepared safely.`,
      );
    }
  }

  async function applyProposal(
    prepared: PreparedDesignMateProposal,
    source: ProposalSource,
  ): Promise<void> {
    if (chatRunning || applyingProposalRef.current !== null) {
      return;
    }

    const proposalId = prepared.proposal.id;
    const pending = { source, id: proposalId } as const;
    const actionId = latestProposalAction.current + 1;
    latestProposalAction.current = actionId;
    applyingProposalRef.current = pending;
    setApplyingProposal(pending);
    try {
      const {
        applyPreparedDesignMateProposal,
        prepareDesignMateProposalFonts,
      } = await import(
        "../lib/design-mate-proposal"
      );
      if (latestProposalAction.current !== actionId) {
        return;
      }
      const fontsReady = await prepareDesignMateProposalFonts(prepared);
      if (latestProposalAction.current !== actionId) {
        return;
      }
      if (!fontsReady) {
        setToast(
          "The requested font face could not be loaded exactly, so the proposal was not applied.",
        );
        return;
      }
      const outcome = applyPreparedDesignMateProposal(documentStore, prepared);
      if (outcome.status === "applied") {
        const removeApplied = (
          current: readonly PreparedDesignMateProposal[],
        ): readonly PreparedDesignMateProposal[] =>
          current.filter((item) => item.proposal.id !== proposalId);
        if (source === "review") {
          setPreparedProposals(removeApplied);
        } else {
          setChatPreparedProposals(removeApplied);
          recordChatProposalOutcome(prepared, "applied");
        }
        const createdArtboardId = prepared.impact.createdArtboardIds[0];
        if (createdArtboardId) {
          setCreatedVariantId(createdArtboardId);
        }
        setToast(
          "Proposal applied as one undoable step. Press Ctrl/Cmd+Z to undo.",
        );
      } else if (outcome.status === "stale") {
        setToast(
          source === "review"
            ? "This suggestion is out of date and was not applied. Ask Design Mate to look again."
            : "This proposal is out of date and was not applied. Ask Design Mate again.",
        );
      } else {
        setToast(
          source === "review"
            ? "This suggestion could not be applied safely. Ask Design Mate to look again."
            : "This proposal could not be applied safely. Ask Design Mate again.",
        );
      }
    } catch {
      if (latestProposalAction.current !== actionId) {
        return;
      }
      setToast(
        source === "review"
          ? "This suggestion could not be applied safely. Ask Design Mate to look again."
          : "This proposal could not be applied safely. Ask Design Mate again.",
      );
    } finally {
      if (latestProposalAction.current === actionId) {
        applyingProposalRef.current = null;
        setApplyingProposal((current) =>
          applyingProposalsEqual(current, pending) ? null : current,
        );
      }
    }
  }

  function dismissProposal(
    source: ProposalSource,
    proposalId: string,
  ): void {
    const dismissed =
      source === "review"
        ? preparedProposals.find(
            (item) => item.proposal.id === proposalId,
          )
        : chatPreparedProposals.find(
            (item) => item.proposal.id === proposalId,
          );
    const removeDismissed = (
      current: readonly PreparedDesignMateProposal[],
    ): readonly PreparedDesignMateProposal[] =>
      current.filter((item) => item.proposal.id !== proposalId);
    if (source === "review") {
      setPreparedProposals(removeDismissed);
    } else {
      setChatPreparedProposals(removeDismissed);
      if (dismissed) {
        recordChatProposalOutcome(dismissed, "dismissed");
      }
    }
  }

  function viewProposal(proposalId: string): void {
    const card = Array.from(
      window.document.querySelectorAll<HTMLElement>(
        "[data-design-mate-proposal-id]",
      ),
    ).find(
      (element) =>
        element.dataset.designMateProposalId === proposalId,
    );
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card?.focus({ preventScroll: true });
  }

  function viewCreatedVariant(): void {
    if (!createdVariantId) {
      return;
    }
    const artboard = documentStore.committedDocument.artboards.find(
      (item) => item.id === createdVariantId,
    );
    if (!artboard) {
      setCreatedVariantId(null);
      return;
    }
    documentStore.apply({
      type: "set-active-artboard",
      artboardId: artboard.id,
    });
    const state = useEditorStore.getState();
    state.setSelection([]);
    state.setDesignMateCanvasFocus(null);
    if (state.viewport.width > 0 && state.viewport.height > 0) {
      state.setCamera(
        fitBounds(
          {
            x: artboard.x,
            y: artboard.y,
            width: artboard.width,
            height: artboard.height,
          },
          state.viewport.width,
          state.viewport.height,
          48,
        ),
      );
    }
    setCreatedVariantId(null);
  }

  function focusFinding(finding: ReviewFinding): void {
    if (canvasFocus?.findingId === finding.id) {
      setCanvasFocus(null);
      return;
    }
    const target = resolveDesignMateFocus(
      documentStore.committedDocument,
      finding,
    );
    if (!target) {
      setCanvasFocus(null);
      return;
    }

    const state = useEditorStore.getState();
    if (
      target.type === "nodes" &&
      (!target.artboardId ||
        target.artboardId === documentStore.committedDocument.activeArtboardId)
    ) {
      state.setSelection(target.nodeIds);
      state.setTool("select");
    } else {
      state.setSelection([]);
    }
    if (state.viewport.width > 0 && state.viewport.height > 0) {
      state.setCamera(
        fitBounds(
          target.bounds,
          state.viewport.width,
          state.viewport.height,
          target.type === "nodes" ? 96 : 48,
        ),
      );
    }
    state.setDesignMateCanvasFocus({
      ...target,
      findingId: finding.id,
      label: finding.title,
    });
  }

  const findings = reviewSnapshot?.review.findings ?? [];
  const hasReviewContent =
    stale ||
    error !== null ||
    reviewSnapshot !== null ||
    createdVariantId !== null ||
    (chatProposalBaseDocument !== null && chatPreparedProposals.length > 0);

  const scopeControls = (
    <div className="flex items-center justify-between gap-8">
      <div
        className="flex shrink-0 rounded-[7px] border border-field-border bg-field p-2"
        role="group"
        aria-label="Design Mate focus"
      >
        {SCOPES.map((item) => {
          const disabled = item.id === "selection" && !hasSelection;
          const active = effectiveScope === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`${TAB} ${
                active
                  ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(0_0_0/0.3)]"
                  : "text-ink-dim"
              }`}
              onClick={() => setScope(item.id)}
              aria-pressed={active}
              disabled={disabled}
              title={
                disabled
                  ? "Select one or more logo objects first"
                  : item.title
              }
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={PRIMARY}
        onClick={() =>
          status === "reviewing" ? stopReview() : void runReview()
        }
        disabled={chatRunning}
        title={
          chatRunning
            ? "Wait for the current Design Mate answer to finish"
            : status === "reviewing"
              ? "Stop the current review"
              : "Ask Design Mate to review the current focus"
        }
      >
        {status === "reviewing" ? (
          <Square size={10} fill="currentColor" aria-hidden="true" />
        ) : (
          <Sparkles size={12} aria-hidden="true" />
        )}
        {status === "reviewing"
          ? "Stop"
          : reviewSnapshot
            ? "Look again"
            : "Take a look"}
      </button>
    </div>
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Design Mate workspace"
    >
      <div className="shrink-0 border-b border-panel-hairline">
            <div className="flex w-full items-center gap-7 px-13 py-8">
              <span className="shrink-0 text-[10.5px] font-[650] text-ink">
                Brief
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
                {draft.brandName.trim() || "Context I should keep in mind"}
              </span>
              <button
                type="button"
                className="shrink-0 text-[10px] font-[650] text-accent"
                onClick={() => setBriefExpanded((value) => !value)}
                aria-expanded={briefExpanded}
              >
                {briefExpanded ? "Hide" : document.designBrief ? "Edit" : "Add"}
              </button>
            </div>

            {briefExpanded && (
              <div className="max-h-300 overflow-y-auto px-13 pb-10">
              <fieldset className="grid gap-7 border-0 p-0">
                <legend className="sr-only">Brand brief</legend>
                <label className={LABEL}>
                  Brand name
                  <input
                    className={FIELD}
                    value={draft.brandName}
                    onChange={(event) =>
                      updateDraft("brandName", event.currentTarget.value)
                    }
                    placeholder="Northstar"
                  />
                </label>
                <label className={LABEL}>
                  What does the brand offer?
                  <textarea
                    className={`${FIELD} min-h-52 resize-y`}
                    value={draft.offering}
                    onChange={(event) =>
                      updateDraft("offering", event.currentTarget.value)
                    }
                    placeholder="A concise description of the product or service"
                  />
                </label>
                <label className={LABEL}>
                  Audience
                  <textarea
                    className={`${FIELD} min-h-44 resize-y`}
                    value={draft.audience}
                    onChange={(event) =>
                      updateDraft("audience", event.currentTarget.value)
                    }
                    placeholder="Who should this identity connect with?"
                  />
                </label>
                <label className={LABEL}>
                  Brand attributes
                  <textarea
                    className={`${FIELD} min-h-44 resize-y`}
                    value={draft.attributes}
                    onChange={(event) =>
                      updateDraft("attributes", event.currentTarget.value)
                    }
                    placeholder="Precise, warm, independent"
                  />
                  <span className="font-normal text-[9.5px]">
                    Separate ideas with commas or new lines.
                  </span>
                </label>
                <label className={LABEL}>
                  Avoid
                  <textarea
                    className={`${FIELD} min-h-44 resize-y`}
                    value={draft.avoid}
                    onChange={(event) =>
                      updateDraft("avoid", event.currentTarget.value)
                    }
                    placeholder="Visual clichés, tones, or motifs to avoid"
                  />
                </label>

                <details className="rounded-[7px] border border-panel-hairline bg-card px-8 py-6">
                  <summary className="cursor-pointer text-[10.5px] font-[650] text-ink-dim">
                    More context
                  </summary>
                  <div className="mt-8 grid gap-7">
                    {(
                      [
                        ["competitors", "Competitors or peers"],
                        ["primaryUseCases", "Primary use cases"],
                        ["mustKeep", "Elements that must stay"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className={LABEL}>
                        {label}
                        <textarea
                          className={`${FIELD} min-h-44 resize-y`}
                          value={draft[field]}
                          onChange={(event) =>
                            updateDraft(field, event.currentTarget.value)
                          }
                          placeholder="One item per line"
                        />
                      </label>
                    ))}
                    <label className={LABEL}>
                      Constraints
                      <textarea
                        className={`${FIELD} min-h-52 resize-y`}
                        value={draft.constraints}
                        onChange={(event) =>
                          updateDraft("constraints", event.currentTarget.value)
                        }
                        placeholder="Production, legal, or style constraints"
                      />
                    </label>
                    <label className={LABEL}>
                      Notes
                      <textarea
                        className={`${FIELD} min-h-52 resize-y`}
                        value={draft.notes}
                        onChange={(event) =>
                          updateDraft("notes", event.currentTarget.value)
                        }
                        placeholder="Anything else Design Mate should know"
                      />
                    </label>
                  </div>
                </details>

                <button
                  type="button"
                  className={`${SECONDARY} justify-self-end`}
                  onClick={saveBrief}
                  disabled={!briefDirty}
                >
                  <Save size={12} aria-hidden="true" />
                  Save brief
                </button>
              </fieldset>
              </div>
            )}
          </div>

          {hasReviewContent && (
          <div
            className="max-h-[50%] min-h-0 overflow-y-auto border-b border-panel-hairline"
            style={{ flex: "0 1 auto" }}
          >
          <div className="grid gap-11 px-13 py-11">

          {stale && (
            <div
              role="status"
              className="rounded-[7px] bg-[rgb(232_195_126/0.08)] px-9 py-6 text-[10px] leading-[1.45] text-[#e4c07a]"
            >
              You’ve changed the canvas since I last looked. Let me take
              another pass before you use these notes.
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-[7px] bg-[rgb(240_86_77/0.1)] px-9 py-6 text-[10px] leading-[1.45] text-danger"
            >
              {error}
            </div>
          )}

          {reviewSnapshot && (
            <div aria-live="polite" aria-atomic="false">
              <div className="flex items-baseline justify-between gap-8">
                <h3 className="m-0 text-[9.5px] font-[680] uppercase tracking-[0.08em] text-ink-dim">
                  What I noticed
                </h3>
                <span className="shrink-0 text-[9px] tabular-nums text-ink-faint">
                  {findings.length} {findings.length === 1 ? "finding" : "findings"}
                </span>
              </div>
              <p className="mx-0 mb-0 mt-5 text-[10.5px] leading-[1.5] text-ink-dim">
                {reviewSnapshot.review.summary}
              </p>
              {findings.length === 0 ? (
                <p className="m-0 mt-7 text-[10.5px] leading-[1.5] text-[#7fd6a0]">
                  Nothing is fighting for attention in this pass. Nice work.
                </p>
              ) : (
                <ul className="m-0 mt-6 grid list-none gap-2 p-0">
                  {findings.map((finding) => {
                    const relatedProposal = preparedProposals.find(
                      (prepared) =>
                        prepared.proposal.sourceFindingIds?.includes(
                          finding.id,
                        ),
                    );
                    return (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        focused={canvasFocus?.findingId === finding.id}
                        canFocus={
                          resolveDesignMateFocus(
                            documentStore.committedDocument,
                            finding,
                          ) !== null
                        }
                        onFocus={() => focusFinding(finding)}
                        {...(relatedProposal
                          ? {
                              relatedProposal,
                              onViewProposal: () =>
                                viewProposal(
                                  relatedProposal.proposal.id,
                                ),
                            }
                          : {})}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {reviewSnapshot &&
            proposalBaseDocument &&
            preparedProposals.length > 0 && (
              <DesignMateProposalErrorBoundary
                resetKey={preparedProposals
                  .map((item) => item.proposal.id)
                  .join("\u0000")}
              >
                <Suspense
                  fallback={
                    <div
                      role="status"
                      aria-live="polite"
                      className="rounded-[7px] border border-panel-hairline bg-field px-9 py-7 text-[10.5px] text-ink-dim"
                    >
                      Loading suggested changes…
                    </div>
                  }
                >
                  <DesignMateProposalPanel
                    baseDocument={proposalBaseDocument}
                    proposals={preparedProposals}
                    stale={stale}
                    applyingId={
                      applyingProposal?.source === "review"
                        ? applyingProposal.id
                        : null
                    }
                    busy={applyingProposal !== null || chatRunning}
                    onApply={(prepared) =>
                      applyProposal(prepared, "review")
                    }
                    onDismiss={(proposalId) =>
                      dismissProposal("review", proposalId)
                    }
                  />
                </Suspense>
              </DesignMateProposalErrorBoundary>
            )}

          {createdVariantId && (
            <div
              className="flex items-center justify-between gap-8 rounded-[8px] bg-[rgb(84_196_130/0.1)] px-9 py-7 text-[10px] leading-[1.45] text-[#7fd6a0]"
              role="status"
            >
              <span>
                The new logo variant is ready. Review and simplify it for its
                intended size before export.
              </span>
              <button
                type="button"
                className="shrink-0 font-[650] text-[#7fd6a0] underline-offset-2 hover:underline"
                onClick={viewCreatedVariant}
              >
                View variant
              </button>
            </div>
          )}

          {chatProposalBaseDocument &&
            chatPreparedProposals.length > 0 && (
              <DesignMateProposalErrorBoundary
                resetKey={`chat\u0000${chatPreparedProposals
                  .map((item) => item.proposal.id)
                  .join("\u0000")}`}
              >
                <Suspense
                  fallback={
                    <div
                      role="status"
                      aria-live="polite"
                      className="text-[10px] text-ink-dim"
                    >
                      Loading conversation suggestions…
                    </div>
                  }
                >
                  <DesignMateProposalPanel
                    baseDocument={chatProposalBaseDocument}
                    proposals={chatPreparedProposals}
                    stale={chatProposalsStale}
                    applyingId={
                      applyingProposal?.source === "chat"
                        ? applyingProposal.id
                        : null
                    }
                    busy={applyingProposal !== null || chatRunning}
                    heading="Ideas from our chat"
                    description="A few concrete moves from our latest conversation."
                    staleMessage="The canvas or conversation scope changed. Ask Design Mate again to refresh these suggestions."
                    defaultRationale="A suggested change from your latest Design Mate conversation."
                    onApply={(prepared) =>
                      applyProposal(prepared, "chat")
                    }
                    onDismiss={(proposalId) =>
                      dismissProposal("chat", proposalId)
                    }
                  />
                </Suspense>
              </DesignMateProposalErrorBoundary>
            )}
          </div>
          </div>
          )}

          <DesignMateChatErrorBoundary
            resetKey={`${document.id} ${documentGeneration}`}
          >
            <Suspense
              fallback={
                <div
                  role="status"
                  aria-live="polite"
                  className="flex min-h-160 flex-1 items-center justify-center text-[10.5px] text-ink-dim"
                >
                  Loading conversation…
                </div>
              }
            >
              <DesignMateChatPanel
                disabled={applyingProposal !== null}
                controls={scopeControls}
                onRunningChange={setChatRunning}
                onProposalsClear={clearChatProposals}
                onProposalsReady={receiveChatProposals}
                onProposalOutcomeConsumed={consumeChatProposalOutcome}
                proposalOutcome={chatMemoryEvent}
              />
            </Suspense>
          </DesignMateChatErrorBoundary>
    </section>
  );
}
