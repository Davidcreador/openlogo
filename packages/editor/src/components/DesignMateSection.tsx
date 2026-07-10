import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import type { ReviewFinding, ReviewScope } from "@openlogo/core";
import { collectDesignMateReview } from "@openlogo/design-mate";
import { fitBounds } from "@openlogo/renderer";
import {
  designBriefFromDraft,
  designBriefToDraft,
  type DesignBriefDraft,
} from "../lib/design-mate-form";
import {
  isDesignMateReviewStale,
  resolveDesignMateFocus,
} from "../lib/design-mate-review";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

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
    title: "Review only the selected logo objects",
  },
  {
    id: "active-artboard",
    label: "Artboard",
    title: "Review the active logo artboard",
  },
  {
    id: "document",
    label: "System",
    title: "Review every logo variant in this document",
  },
];

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
  const contentId = useId();
  const previousDocumentId = useRef(document.id);
  const latestRun = useRef(0);
  const [expanded, setExpanded] = useState(true);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [draft, setDraft] = useState<DesignBriefDraft>(() =>
    designBriefToDraft(document.designBrief),
  );
  const [briefDirty, setBriefDirty] = useState(false);

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

  useEffect(() => {
    setDraft(designBriefToDraft(document.designBrief));
    setBriefDirty(false);

    if (previousDocumentId.current !== document.id) {
      previousDocumentId.current = document.id;
      latestRun.current += 1;
      setReview(null);
      setStatus("idle");
      setError(null);
    }
  }, [
    document.designBrief,
    document.id,
    setError,
    setReview,
    setStatus,
  ]);

  const hasSelection = selectedNodeIds.length > 0;
  const effectiveScope =
    scope === "selection" && !hasSelection ? "active-artboard" : scope;
  const stale =
    reviewSnapshot !== null &&
    isDesignMateReviewStale(reviewSnapshot.identity, {
      documentId: document.id,
      generation: documentStore.documentGeneration,
      revision: documentStore.committedRevision,
    });

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
    if (briefDirty) {
      saveBrief();
    }

    const runId = latestRun.current + 1;
    latestRun.current = runId;
    const committedDocument = documentStore.committedDocument;
    const generation = documentStore.documentGeneration;
    const revision = documentStore.committedRevision;
    setStatus("reviewing");
    setError(null);

    try {
      const result = await collectDesignMateReview(
        committedDocument,
        {
          selectedNodeIds,
          ...(keyObjectId ? { keyObjectId } : {}),
          ...(activeGroupId ? { activeGroupId } : {}),
        },
        {
          scope: effectiveScope,
          generation,
          revision,
        },
      );
      if (latestRun.current !== runId) {
        return;
      }
      setReview({
        review: result.review,
        identity: result.identity,
        scope: result.scope,
      });
      setStatus("complete");
    } catch (cause) {
      if (latestRun.current !== runId) {
        return;
      }
      setError(providerErrorMessage(cause));
      setStatus("error");
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
    if (target.type === "nodes") {
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
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-6 text-left"
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
          <h2 className={HEADING}>Design mate</h2>
        </button>
        <span className="rounded-full border border-panel-hairline bg-field px-6 py-2 text-[8.5px] font-[650] uppercase tracking-[0.06em] text-ink-dim">
          Local expert
        </span>
      </header>

      {expanded && (
        <div id={contentId} className="mt-10 grid gap-10">
          <div className="rounded-[8px] border border-panel-hairline bg-field p-8">
            <div className="flex items-start justify-between gap-8">
              <div>
                <strong className="block text-[11.5px] font-[650] text-ink">
                  Brand brief
                </strong>
                <p className="m-0 mt-2 text-[10px] leading-[1.4] text-ink-dim">
                  Design Mate uses this context in every review.
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
              aria-label="Design review scope"
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
        </div>
      )}
    </section>
  );
}
