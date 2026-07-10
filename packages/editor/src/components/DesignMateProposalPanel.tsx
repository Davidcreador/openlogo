import { useId, useMemo } from "react";
import type { LogoDocument } from "@openlogo/core";
import type { PreparedDesignMateProposal } from "@openlogo/design-mate";
import { createDesignMateProposalPreview } from "../lib/design-mate-proposal";

export type DesignMateProposalPanelProps = {
  readonly baseDocument: LogoDocument;
  readonly proposals: readonly PreparedDesignMateProposal[];
  readonly stale: boolean;
  readonly applyingId: string | null;
  readonly onApply: (
    prepared: PreparedDesignMateProposal,
  ) => void | Promise<void>;
  readonly onDismiss: (proposalId: string) => void;
};

type ProposalRisk = PreparedDesignMateProposal["proposal"]["risk"];

const RISK_BADGES: Record<
  ProposalRisk,
  { readonly label: string; readonly className: string }
> = {
  low: {
    label: "Low risk",
    className: "border-[#a9d4b7] bg-[#eef8f1] text-[#2f6b43]",
  },
  medium: {
    label: "Medium risk",
    className: "border-[#e7c883] bg-[#fff8e8] text-[#73551f]",
  },
  high: {
    label: "High risk",
    className: "border-[rgb(194_70_62/0.28)] bg-[#fdf1f0] text-danger",
  },
};

const SECONDARY =
  "inline-flex items-center justify-center rounded-field border border-field-border bg-card px-8 py-5 text-[10.5px] font-[600] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-45";
const PRIMARY =
  "inline-flex items-center justify-center rounded-field bg-accent px-9 py-5 text-[10.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_3px_rgb(79_107_246/0.3)] transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-45";

function ProposalCard({
  baseDocument,
  prepared,
  stale,
  applyingId,
  onApply,
  onDismiss,
}: {
  readonly baseDocument: LogoDocument;
  readonly prepared: PreparedDesignMateProposal;
  readonly stale: boolean;
  readonly applyingId: string | null;
  readonly onApply: (
    prepared: PreparedDesignMateProposal,
  ) => void | Promise<void>;
  readonly onDismiss: (proposalId: string) => void;
}) {
  const titleId = useId();
  const preview = useMemo(
    () => createDesignMateProposalPreview(baseDocument, prepared),
    [baseDocument, prepared],
  );
  const { proposal, impact } = prepared;
  const applying = applyingId === proposal.id;
  const applyDisabled = stale || applyingId !== null;
  const risk = RISK_BADGES[proposal.risk];

  return (
    <article
      className="rounded-[8px] border border-panel-hairline bg-card p-9 shadow-[0_1px_2px_rgb(28_25_33/0.04)]"
      aria-labelledby={titleId}
      aria-busy={applying}
    >
      <div className="flex items-start justify-between gap-8">
        <h4
          id={titleId}
          className="m-0 min-w-0 text-[11.5px] font-[650] leading-[1.35] text-ink"
        >
          {proposal.label}
        </h4>
        <span
          className={`shrink-0 rounded-full border px-6 py-2 text-[8.5px] font-[650] uppercase tracking-[0.06em] ${risk.className}`}
        >
          {risk.label}
        </span>
      </div>

      <p className="mx-0 mb-0 mt-5 text-[10.5px] leading-[1.45] text-ink-dim">
        {proposal.rationale ??
          "A conservative change tied to an objective review finding."}
      </p>

      {impact.summaries.length > 0 && (
        <ul
          className="mx-0 mb-0 mt-7 grid gap-3 pl-16 text-[10px] leading-[1.4] text-[#55515c]"
          aria-label={`Impact of ${proposal.label}`}
        >
          {impact.summaries.map((summary, index) => (
            <li key={`${proposal.id}:impact:${index}`}>{summary}</li>
          ))}
        </ul>
      )}

      {preview && (
        <div
          className="mt-8 grid grid-cols-2 gap-6"
          role="group"
          aria-label={`Before and after preview for ${proposal.label}`}
        >
          {[preview.before, preview.after].map((image) => (
            <figure
              key={image.label}
              className="m-0 min-w-0 rounded-[7px] border border-panel-hairline bg-field p-4"
            >
              <img
                className="h-64 w-full rounded-[5px] bg-white object-contain"
                src={image.dataUrl}
                alt={image.label}
                decoding="async"
              />
              <figcaption className="mt-3 truncate text-center text-[8.5px] font-[600] text-ink-dim">
                {image.label}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="mt-7 rounded-[6px] bg-field px-7 py-5 text-[9.5px] leading-[1.45] text-ink-dim">
        <strong className="font-[650] text-ink">
          Preview only — no canvas changes yet.
        </strong>{" "}
        Applies as one undoable step.
      </div>

      <div className="mt-8 flex items-center justify-end gap-6">
        <button
          type="button"
          className={SECONDARY}
          onClick={() => onDismiss(proposal.id)}
          disabled={applyingId !== null}
          aria-label={`Dismiss ${proposal.label}`}
        >
          Dismiss
        </button>
        <button
          type="button"
          className={PRIMARY}
          onClick={() => void onApply(prepared)}
          disabled={applyDisabled}
          aria-label={
            applying ? `Applying ${proposal.label}` : `Apply ${proposal.label}`
          }
          title={
            stale
              ? "Re-run the design review before applying this proposal"
              : applyingId !== null && !applying
                ? "Another proposal is being applied"
                : undefined
          }
        >
          {applying ? "Applying…" : "Apply"}
        </button>
      </div>
    </article>
  );
}

export function DesignMateProposalPanel({
  baseDocument,
  proposals,
  stale,
  applyingId,
  onApply,
  onDismiss,
}: DesignMateProposalPanelProps) {
  const headingId = useId();

  return (
    <section
      className="rounded-[9px] border border-[rgb(79_107_246/0.22)] bg-accent-soft p-8"
      aria-labelledby={headingId}
      aria-busy={applyingId !== null}
    >
      <div className="flex items-start justify-between gap-8">
        <div>
          <h3
            id={headingId}
            className="m-0 text-[10.5px] font-[650] uppercase tracking-[0.07em] text-ink"
          >
            Suggested changes
          </h3>
          <p className="m-0 mt-2 text-[9.5px] leading-[1.4] text-ink-dim">
            Conservative edits from objective findings.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-card px-6 py-2 text-[8.5px] tabular-nums text-ink-dim">
          {proposals.length}
        </span>
      </div>

      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {stale
          ? "These proposals are out of date and cannot be applied."
          : applyingId
            ? "Applying Design Mate proposal."
            : `${proposals.length} Design Mate ${
                proposals.length === 1 ? "proposal" : "proposals"
              } available.`}
      </div>

      {stale && (
        <p className="mx-0 mb-0 mt-7 rounded-[6px] border border-[#e7c883] bg-[#fff8e8] px-7 py-5 text-[9.5px] leading-[1.4] text-[#73551f]">
          The document changed. Re-run the review to apply a suggestion.
        </p>
      )}

      <div className="mt-8 grid gap-8">
        {proposals.map((prepared) => (
          <ProposalCard
            key={prepared.proposal.id}
            baseDocument={baseDocument}
            prepared={prepared}
            stale={stale}
            applyingId={applyingId}
            onApply={onApply}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </section>
  );
}
