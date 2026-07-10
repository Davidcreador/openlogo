import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  RefreshCw,
  Save,
  Sparkles,
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
  DESIGN_MATE_CHAT_ENDPOINT,
  designMateChatHeaderLabel,
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
          className="rounded-[7px] border border-[rgb(194_70_62/0.28)] bg-[#fdf1f0] px-9 py-7 text-[10.5px] leading-[1.45] text-danger"
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
          className="rounded-[7px] border border-[rgb(194_70_62/0.28)] bg-[#fdf1f0] px-9 py-7 text-[10.5px] leading-[1.45] text-danger"
        >
          <p className="m-0">
            Conversation is unavailable. The brief, review, and suggested
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

const SECTION =
  "inspector-section shrink-0 rounded-card border border-panel-hairline bg-card p-12 shadow-[0_1px_2px_rgb(28_25_33/0.04)]";
const HEADING =
  "m-0 text-[10.5px] font-[650] uppercase tracking-[0.08em] text-ink-dim";
const LABEL = "grid gap-4 text-[10.5px] font-[600] text-ink-dim";
const FIELD =
  "min-h-28 w-full rounded-field border border-field-border bg-field px-8 py-6 text-[12px] leading-[1.4] text-ink outline-none transition-[border-color,box-shadow,background-color] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent focus:bg-card focus:shadow-ring";
const TAB =
  "flex-1 rounded-[6px] px-4 py-5 text-[10.5px] transition-[background-color,color,box-shadow] duration-120 ease-studio disabled:cursor-default disabled:opacity-35";
const SECONDARY =
  "inline-flex items-center justify-center gap-5 rounded-field border border-field-border bg-card px-9 py-6 text-[11px] font-[600] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY =
  "inline-flex items-center justify-center gap-6 rounded-field bg-accent px-10 py-7 text-[11.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_3px_rgb(79_107_246/0.3)] transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-45";

const SCOPES: ReadonlyArray<{
  id: ReviewScope;
  label: string;
  title: string;
}> = [
  {
    id: "selection",
    label: "Selection",
    title: "Use the selected logo objects for conversation and review",
  },
  {
    id: "active-artboard",
    label: "Artboard",
    title: "Use the active logo artboard for conversation and review",
  },
  {
    id: "document",
    label: "System",
    title: "Use the full logo system for conversation and review",
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
  return "Design Mate could not complete this review. Try again.";
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
}: {
  finding: ReviewFinding;
  onFocus: () => void;
  canFocus: boolean;
}) {
  return (
    <li
      data-severity={finding.severity}
      className={`rounded-[8px] border-l-[3px] px-10 py-9 text-[11.5px] ${
        finding.severity === "warning"
          ? "border-[#f59e0b] bg-[#fdf6e9]"
          : finding.severity === "strong"
            ? "border-danger bg-[#fdf1f0]"
            : "border-accent bg-accent-soft"
      }`}
    >
      <div className="flex items-start justify-between gap-8">
        <span className="font-[650] leading-[1.35] text-ink">
          <span className="sr-only">{severityLabel(finding)}: </span>
          {finding.title}
        </span>
        <span className="shrink-0 rounded-full bg-[rgb(255_255_255/0.58)] px-6 py-2 text-[8.5px] font-[650] uppercase tracking-[0.06em] text-ink-dim">
          {finding.category}
        </span>
      </div>
      <p className="mx-0 my-5 leading-[1.45] text-[#55515c]">
        {finding.detail}
      </p>
      {finding.evidence.length > 0 && (
        <p className="m-0 text-[10px] leading-[1.45] text-ink-dim">
          {finding.evidence
            .slice(0, 2)
            .map(
              (item) =>
                `${item.label}: ${item.value}${item.unit ? ` ${item.unit}` : ""}`,
            )
            .join(" · ")}
        </p>
      )}
      <div className="mt-7 flex items-end justify-between gap-8">
        <em className="min-w-0 flex-1 text-[10.5px] leading-[1.4] text-ink-dim">
          {finding.action}
        </em>
        {canFocus && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-4 rounded-field border border-[rgb(79_107_246/0.28)] bg-card px-7 py-4 text-[10px] font-[650] text-accent transition-colors hover:bg-accent-soft"
            onClick={onFocus}
            aria-label={`Show ${finding.title} on canvas`}
          >
            <LocateFixed size={11} aria-hidden="true" />
            Show
          </button>
        )}
      </div>
    </li>
  );
}

export function DesignMateSection() {
  const document = useDocument();
  const documentGeneration = documentStore.documentGeneration;
  const contentId = useId();
  const previousDocumentHead = useRef({
    documentId: document.id,
    generation: documentGeneration,
  });
  const latestRun = useRef(0);
  const latestProposalAction = useRef(0);
  const applyingProposalRef = useRef<ApplyingProposal | null>(null);
  const [expanded, setExpanded] = useState(true);
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

  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const activeGroupId = useEditorStore((state) => state.activeGroupId);
  const scope = useEditorStore((state) => state.designMateScope);
  const reviewSnapshot = useEditorStore((state) => state.designMateReview);
  const status = useEditorStore((state) => state.designMateStatus);
  const error = useEditorStore((state) => state.designMateError);
  const setScope = useEditorStore((state) => state.setDesignMateScope);
  const setReview = useEditorStore((state) => state.setDesignMateReview);
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
      setReview(null);
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
    }
  }, [
    document.designBrief,
    document.id,
    documentGeneration,
    setError,
    setReview,
    setStatus,
  ]);

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
      if (latestRun.current !== runId) {
        return;
      }
      setPreparedProposals([]);
      setProposalBaseDocument(null);
      setApplyingProposal(null);
      setReview(null);
      setError(providerErrorMessage(cause));
      setStatus("error");
    }
  }

  function clearChatProposals(): void {
    setChatPreparedProposals([]);
    setChatProposalBaseDocument(null);
    setChatProposalContext(null);
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
    if (applyingProposalRef.current !== null) {
      return;
    }

    const proposalId = prepared.proposal.id;
    const pending = { source, id: proposalId } as const;
    const actionId = latestProposalAction.current + 1;
    latestProposalAction.current = actionId;
    applyingProposalRef.current = pending;
    setApplyingProposal(pending);
    try {
      const { applyPreparedDesignMateProposal } = await import(
        "../lib/design-mate-proposal"
      );
      if (latestProposalAction.current !== actionId) {
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
        }
        setToast(
          "Proposal applied as one undoable step. Press Ctrl/Cmd+Z to undo.",
        );
      } else if (outcome.status === "stale") {
        setToast(
          source === "review"
            ? "This proposal is out of date and was not applied. Re-run the design review."
            : "This proposal is out of date and was not applied. Ask Design Mate again.",
        );
      } else {
        setToast(
          source === "review"
            ? "This proposal could not be applied safely. Re-run the design review and try again."
            : "This proposal could not be applied safely. Ask Design Mate again.",
        );
      }
    } catch {
      if (latestProposalAction.current !== actionId) {
        return;
      }
      setToast(
        source === "review"
          ? "This proposal could not be applied safely. Re-run the design review and try again."
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
    const removeDismissed = (
      current: readonly PreparedDesignMateProposal[],
    ): readonly PreparedDesignMateProposal[] =>
      current.filter((item) => item.proposal.id !== proposalId);
    if (source === "review") {
      setPreparedProposals(removeDismissed);
    } else {
      setChatPreparedProposals(removeDismissed);
    }
  }

  function focusFinding(finding: ReviewFinding): void {
    const target = resolveDesignMateFocus(
      documentStore.committedDocument,
      finding,
    );
    if (!target) {
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
  }

  const findings = reviewSnapshot?.review.findings ?? [];

  return (
    <section className={SECTION}>
      <header className="flex items-center justify-between gap-8">
        <h2 className={`${HEADING} min-w-0 flex-1`}>
          <button
            type="button"
            className="flex w-full items-center gap-6 text-left"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={contentId}
          >
            {expanded ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
            <Sparkles size={13} className="text-accent" aria-hidden="true" />
            <span>Design mate</span>
          </button>
        </h2>
        <span className="rounded-full border border-panel-hairline bg-field px-6 py-2 text-[8.5px] font-[650] uppercase tracking-[0.06em] text-ink-dim">
          {designMateChatHeaderLabel(DESIGN_MATE_CHAT_ENDPOINT)}
        </span>
      </header>

      <div
        id={contentId}
        hidden={!expanded}
        className={`mt-10 grid gap-10 ${expanded ? "" : "hidden"}`}
      >
          <div className="rounded-[8px] border border-panel-hairline bg-field p-8">
            <div className="flex items-start justify-between gap-8">
              <div>
                <strong className="block text-[11.5px] font-[650] text-ink">
                  Brand brief
                </strong>
                <p className="m-0 mt-2 text-[10px] leading-[1.4] text-ink-dim">
                  Design Mate uses this context in conversation and review.
                </p>
              </div>
              <button
                type="button"
                className="text-[10.5px] font-[650] text-accent"
                onClick={() => setBriefExpanded((value) => !value)}
                aria-expanded={briefExpanded}
              >
                {briefExpanded ? "Hide" : document.designBrief ? "Edit" : "Add"}
              </button>
            </div>

            {briefExpanded && (
              <fieldset className="mt-9 grid gap-7 border-0 p-0">
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
            )}
          </div>

          <div>
            <div
              className="flex rounded-[8px] border border-field-border bg-field p-3"
              role="group"
              aria-label="Design Mate conversation and review scope"
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
                        ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(28_25_33/0.1)]"
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
            <p className="mx-0 mb-0 mt-4 text-[9px] leading-[1.4] text-ink-dim">
              This scope applies to both conversation and design review.
            </p>
            <button
              type="button"
              className={`${PRIMARY} mt-7 w-full`}
              onClick={() => void runReview()}
              disabled={status === "reviewing"}
            >
              {status === "reviewing" ? (
                <RefreshCw
                  size={13}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Sparkles size={13} aria-hidden="true" />
              )}
              {status === "reviewing"
                ? "Reviewing…"
                : reviewSnapshot
                  ? "Review again"
                  : "Run design review"}
            </button>
          </div>

          <DesignMateChatErrorBoundary
            resetKey={`${document.id}\u0000${documentGeneration}`}
          >
            <Suspense
              fallback={
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-[7px] border border-panel-hairline bg-field px-9 py-7 text-[10.5px] text-ink-dim"
                >
                  Loading conversation…
                </div>
              }
            >
              <DesignMateChatPanel
                disabled={applyingProposal !== null}
                onProposalsClear={clearChatProposals}
                onProposalsReady={receiveChatProposals}
              />
            </Suspense>
          </DesignMateChatErrorBoundary>

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
                      className="rounded-[7px] border border-panel-hairline bg-field px-9 py-7 text-[10.5px] text-ink-dim"
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
                    busy={applyingProposal !== null}
                    heading="Conversation suggestions"
                    description="Prepared from the latest completed Design Mate answer."
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

          {stale && (
            <div
              role="status"
              className="rounded-[7px] border border-[#e7c883] bg-[#fff8e8] px-9 py-7 text-[10.5px] leading-[1.45] text-[#73551f]"
            >
              The document changed after this review. Re-run it before acting
              on the details.
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-[7px] border border-[rgb(194_70_62/0.28)] bg-[#fdf1f0] px-9 py-7 text-[10.5px] leading-[1.45] text-danger"
            >
              {error}
            </div>
          )}

          {reviewSnapshot && (
            <div aria-live="polite" aria-atomic="false">
              <div className="mb-8 flex items-start justify-between gap-8">
                <p className="m-0 text-[11px] leading-[1.5] text-ink-dim">
                  {reviewSnapshot.review.summary}
                </p>
                <span className="shrink-0 text-[9.5px] tabular-nums text-ink-dim">
                  {findings.length} {findings.length === 1 ? "finding" : "findings"}
                </span>
              </div>
              {findings.length === 0 ? (
                <p className="m-0 rounded-[7px] bg-[#eef8f1] px-9 py-7 text-[10.5px] text-[#2f6b43]">
                  No issues found in this pass.
                </p>
              ) : (
                <ul className="m-0 grid list-none gap-8 p-0">
                  {findings.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      canFocus={
                        resolveDesignMateFocus(
                          documentStore.committedDocument,
                          finding,
                        ) !== null
                      }
                      onFocus={() => focusFinding(finding)}
                    />
                  ))}
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
                    busy={applyingProposal !== null}
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
      </div>
    </section>
  );
}
