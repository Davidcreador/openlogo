import { FIELD_INPUT } from "./field-styles";
import { useState } from "react";
import type { LogoDocument } from "@openlogo/core";
import { VIBES, type Vibe } from "@openlogo/foundry";
import { Shuffle, Sparkles } from "lucide-react";
import {
  templateFontsReady,
  useTemplateGallery,
} from "../lib/use-template-gallery";
import type { TemplateProposal } from "../lib/template-proposals";
import { TemplateCard } from "./TemplateCard";

const VIBE_LABELS: Record<Vibe, string> = {
  minimal: "Minimal",
  classic: "Classic",
  retro: "Retro",
  streetwear: "Streetwear",
  elegant: "Elegant",
  playful: "Playful",
};

export default function TemplateGallery({
  disabled,
  onCreateDocument,
}: {
  disabled: boolean;
  onCreateDocument(document: LogoDocument): Promise<void>;
}) {
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const gallery = useTemplateGallery({
    initialBrandName: "Studio North",
    initialTagline: "Made with intent",
    count: 18,
  });

  async function create(proposal: TemplateProposal): Promise<void> {
    if (creatingKey || !templateFontsReady(proposal)) {
      return;
    }
    setCreatingKey(proposal.key);
    try {
      await onCreateDocument(proposal.document);
    } finally {
      setCreatingKey(null);
    }
  }

  return (
    <section className="mt-28" aria-labelledby="template-gallery-heading">
      <div className="rounded-panel border border-panel-hairline bg-panel/72 p-14 shadow-[0_10px_30px_rgb(19_16_25/0.07)] sm:p-18">
        <div className="flex flex-col gap-14 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-[520px]">
            <span className="inline-flex items-center gap-6 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent">
              <Sparkles size={13} aria-hidden="true" /> Foundry
            </span>
            <h2
              id="template-gallery-heading"
              className="mb-0 mt-5 text-[18px] font-[720] tracking-[-0.02em] text-ink"
            >
              Start from a template
            </h2>
            <p className="mb-0 mt-4 text-[11.5px] leading-5 text-ink-dim">
              Live, editable proposals generated from type, color, and vector primitives.
            </p>
          </div>

          <div className="grid min-w-0 flex-1 gap-8 sm:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_auto] xl:max-w-[720px]">
            <label className="grid gap-4 text-[10.5px] font-semibold text-ink-dim">
              Brand name
              <input
                className={FIELD_INPUT}
                value={gallery.brandName}
                onChange={(event) => gallery.setBrandName(event.target.value)}
                maxLength={120}
                placeholder="Your brand"
                disabled={disabled}
              />
            </label>
            <label className="grid gap-4 text-[10.5px] font-semibold text-ink-dim">
              Tagline <span className="sr-only">optional</span>
              <input
                className={FIELD_INPUT}
                value={gallery.tagline}
                onChange={(event) => gallery.setTagline(event.target.value)}
                maxLength={160}
                placeholder="Optional tagline"
                disabled={disabled}
              />
            </label>
            <button
              type="button"
              className="mt-auto inline-flex h-36 items-center justify-center gap-7 rounded-field border border-field-border bg-card px-12 text-[12px] font-semibold text-ink transition-[border-color,color,transform] duration-140 ease-studio hover:-translate-y-1 hover:border-accent hover:text-accent disabled:translate-y-0 disabled:opacity-45"
              onClick={gallery.shuffle}
              disabled={disabled || creatingKey !== null}
            >
              <Shuffle size={14} aria-hidden="true" /> Shuffle
            </button>
          </div>
        </div>

        <div
          className="mt-14 flex flex-wrap items-center gap-6"
          role="group"
          aria-label="Filter templates by vibe"
        >
          <span className="mr-2 text-[10.5px] font-semibold text-ink-dim">Vibe</span>
          <button
            type="button"
            className={`h-28 rounded-full border px-10 text-[10.5px] font-semibold transition-colors ${
              gallery.vibe === null
                ? "border-accent bg-accent text-white"
                : "border-field-border bg-card text-ink-dim hover:border-accent/55 hover:text-accent"
            }`}
            aria-pressed={gallery.vibe === null}
            onClick={() => gallery.setVibe(null)}
            disabled={disabled}
          >
            All
          </button>
          {VIBES.map((item) => (
            <button
              key={item}
              type="button"
              className={`h-28 rounded-full border px-10 text-[10.5px] font-semibold transition-colors ${
                gallery.vibe === item
                  ? "border-accent bg-accent text-white"
                  : "border-field-border bg-card text-ink-dim hover:border-accent/55 hover:text-accent"
              }`}
              aria-pressed={gallery.vibe === item}
              onClick={() => gallery.setVibe(item)}
              disabled={disabled}
            >
              {VIBE_LABELS[item]}
            </button>
          ))}
          <span className="ml-auto text-[10.5px] text-ink-faint" role="status">
            {gallery.readyCount} of {gallery.proposals.length} previews ready
          </span>
        </div>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {gallery.proposals.map((proposal) => {
          const ready = templateFontsReady(proposal);
          const creating = creatingKey === proposal.key;
          return (
            <TemplateCard
              key={proposal.key}
              proposal={proposal}
              ready={ready}
              busy={creating}
              disabled={disabled || creatingKey !== null}
              vibeLabel={gallery.vibe ?? "mixed vibe"}
              actionLabel={`Create for ${gallery.previewBrandName}`}
              onUse={() => void create(proposal)}
              onPalette={(paletteId) => gallery.setPalette(proposal.key, paletteId)}
            />
          );
        })}
      </div>
    </section>
  );
}
