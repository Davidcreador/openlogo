import { useState } from "react";
import { VIBES, type Vibe } from "@openlogo/foundry";
import { Shuffle, Sparkles, X } from "lucide-react";
import { insertTemplateDocument } from "../lib/template-insert";
import {
  templateFontsReady,
  useTemplateGallery,
} from "../lib/use-template-gallery";
import { useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";
import { TemplateCard } from "./TemplateCard";

const VIBE_LABELS: Record<Vibe, string> = {
  minimal: "Minimal",
  classic: "Classic",
  retro: "Retro",
  streetwear: "Streetwear",
  elegant: "Elegant",
  playful: "Playful",
};

const INPUT =
  "h-32 min-w-0 rounded-field border border-field-border bg-field px-9 text-[11.5px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent focus:bg-card focus:shadow-ring";

export default function EditorTemplatePanel() {
  const document = useDocument();
  const [insertingKey, setInsertingKey] = useState<string | null>(null);
  const gallery = useTemplateGallery({
    initialBrandName: document.name,
    count: 12,
  });
  const setTemplatePanelOpen = useEditorStore(
    (state) => state.setTemplatePanelOpen,
  );

  function insert(proposal: (typeof gallery.proposals)[number]) {
    if (insertingKey || !templateFontsReady(proposal)) {
      return;
    }
    setInsertingKey(proposal.key);
    const groupId = insertTemplateDocument(
      proposal.document,
      proposal.archetypeLabel,
    );
    const editor = useEditorStore.getState();
    if (groupId) {
      editor.setSelection([groupId]);
      editor.setActiveGroupId(null);
      editor.setTool("select");
      editor.setToast("Template inserted as one group.");
    } else {
      editor.setToast("Template could not be inserted.");
    }
    setInsertingKey(null);
  }

  return (
    <aside
      id="editor-template-panel"
      className="absolute bottom-12 left-12 top-12 z-30 flex min-h-0 w-[280px] flex-col overflow-hidden rounded-panel border border-accent/18 bg-panel/94 shadow-[0_22px_56px_rgb(19_16_25/0.32)] backdrop-blur-[3px]"
      aria-labelledby="editor-template-heading"
    >
      <div className="flex items-center justify-between border-b border-panel-hairline bg-[linear-gradient(115deg,color-mix(in_srgb,var(--color-accent)_9%,transparent),transparent_58%)] px-12 py-10">
        <div>
          <span className="inline-flex items-center gap-5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-accent">
            <Sparkles size={11} aria-hidden="true" /> Foundry
          </span>
          <h2
            id="editor-template-heading"
            className="mb-0 mt-2 text-[13px] font-[700] text-ink"
          >
            Templates
          </h2>
        </div>
        <button
          type="button"
          className="grid h-28 w-28 place-items-center rounded-field text-ink-dim transition-[background-color,color,transform] duration-140 hover:bg-field hover:text-ink active:scale-[0.94] motion-reduce:transform-none"
          onClick={() => setTemplatePanelOpen(false)}
          aria-label="Close templates"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="border-b border-panel-hairline p-10">
        <div className="grid gap-7">
          <label className="grid gap-3 text-[9.5px] font-semibold text-ink-dim">
            Brand name
            <input
              className={INPUT}
              value={gallery.brandName}
              onChange={(event) => gallery.setBrandName(event.target.value)}
              maxLength={120}
              placeholder="Your brand"
            />
          </label>
          <label className="grid gap-3 text-[9.5px] font-semibold text-ink-dim">
            Tagline <span className="sr-only">optional</span>
            <input
              className={INPUT}
              value={gallery.tagline}
              onChange={(event) => gallery.setTagline(event.target.value)}
              maxLength={160}
              placeholder="Optional tagline"
            />
          </label>
        </div>

        <div
          className="mt-9 flex gap-5 overflow-x-auto pb-2"
          role="group"
          aria-label="Filter templates by vibe"
        >
          <button
            type="button"
            className={`h-25 shrink-0 rounded-full border px-8 text-[9.5px] font-semibold transition-[border-color,background-color,color,transform] duration-140 active:scale-[0.97] motion-reduce:transform-none ${
              gallery.vibe === null
                ? "border-accent bg-accent text-white"
                : "border-field-border bg-card text-ink-dim hover:text-accent"
            }`}
            aria-pressed={gallery.vibe === null}
            onClick={() => gallery.setVibe(null)}
          >
            All
          </button>
          {VIBES.map((vibe) => (
            <button
              key={vibe}
              type="button"
              className={`h-25 shrink-0 rounded-full border px-8 text-[9.5px] font-semibold transition-[border-color,background-color,color,transform] duration-140 active:scale-[0.97] motion-reduce:transform-none ${
                gallery.vibe === vibe
                  ? "border-accent bg-accent text-white"
                  : "border-field-border bg-card text-ink-dim hover:text-accent"
              }`}
              aria-pressed={gallery.vibe === vibe}
              onClick={() => gallery.setVibe(vibe)}
            >
              {VIBE_LABELS[vibe]}
            </button>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between">
          <span className="text-[9.5px] text-ink-faint" role="status">
            {gallery.readyCount}/{gallery.proposals.length} ready
          </span>
          <button
            type="button"
            className="inline-flex h-28 items-center gap-5 rounded-field border border-field-border bg-card px-9 text-[10px] font-semibold text-ink transition-[border-color,color,transform] duration-140 hover:border-accent/55 hover:text-accent active:scale-[0.97] motion-reduce:transform-none"
            onClick={gallery.shuffle}
            disabled={insertingKey !== null}
          >
            <Shuffle size={12} aria-hidden="true" /> Shuffle
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-9 overflow-y-auto p-10 [&>article]:shrink-0">
        {gallery.proposals.map((proposal) => (
          <TemplateCard
            key={proposal.key}
            proposal={proposal}
            ready={templateFontsReady(proposal)}
            busy={insertingKey === proposal.key}
            disabled={insertingKey !== null}
            vibeLabel={gallery.vibe ?? "mixed vibe"}
            actionLabel="Insert"
            onUse={() => insert(proposal)}
            onPalette={(paletteId) => gallery.setPalette(proposal.key, paletteId)}
            compact
          />
        ))}
      </div>
    </aside>
  );
}
