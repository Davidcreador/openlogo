import { useId, useRef, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import { useModalDialog } from "../lib/use-modal-dialog";
import {
  DESIGN_MATE_DEFAULT_BASE_URL,
  DESIGN_MATE_DEFAULT_MODEL,
  clearDesignMateProviderSettings,
  loadDesignMateProviderSettings,
  saveDesignMateProviderSettings,
  validateDesignMateProviderSettings,
} from "../lib/design-mate-settings";
import { useEditorStore } from "../state/editor-store";

const FIELD =
  "h-30 w-full rounded-[7px] border border-field-border bg-field px-9 text-[12px] text-ink outline-none transition-[border-color] duration-140 ease-studio placeholder:text-ink-faint focus:border-accent";
const LABEL = "mb-4 block text-[10.5px] font-semibold text-ink-dim";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const setRemoteEnabled = useEditorStore(
    (state) => state.setDesignMateRemoteEnabled,
  );

  const stored = loadDesignMateProviderSettings();
  const [apiKey, setApiKey] = useState(stored?.apiKey ?? "");
  const [model, setModel] = useState(stored?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? "");
  const [revealKey, setRevealKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  useModalDialog({ open: true, onClose, dialogRef, initialFocusRef });

  function save() {
    const result = validateDesignMateProviderSettings({
      apiKey,
      model: model.trim() || DESIGN_MATE_DEFAULT_MODEL,
      baseUrl,
    });
    if ("error" in result) {
      setError(result.error);
      setSavedNote(false);
      return;
    }
    saveDesignMateProviderSettings(result.settings);
    // A freshly configured provider should just work — turn remote AI on.
    setRemoteEnabled(true);
    setError(null);
    setSavedNote(true);
  }

  function clear() {
    clearDesignMateProviderSettings();
    setApiKey("");
    setModel("");
    setBaseUrl("");
    setError(null);
    setSavedNote(false);
  }

  return (
    <div
      ref={dialogRef}
      className="overlay-in fixed inset-0 z-50 grid place-items-center bg-[rgb(16_14_20/0.68)] p-20 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="dialog-in flex max-h-[min(640px,calc(100vh-40px))] w-[min(520px,calc(100vw-40px))] flex-col overflow-hidden rounded-panel border border-panel-hairline bg-panel shadow-[0_28px_90px_rgb(0_0_0/0.52)]">
        <header className="flex items-center justify-between border-b border-panel-hairline px-16 py-12">
          <h2 id={titleId} className="m-0 text-[14px] font-bold text-ink">
            Settings
          </h2>
          <button
            type="button"
            className="grid h-24 w-24 place-items-center rounded-[6px] text-ink-dim transition-colors duration-140 ease-studio hover:bg-field hover:text-ink"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-16 py-14">
          <h3 className="m-0 mb-3 text-[12.5px] font-bold text-ink">
            Design Mate
          </h3>
          <p className="m-0 mb-10 text-[10.5px] leading-[1.55] text-ink-dim">
            Connect Design Mate to an OpenAI-compatible model provider. The
            key is stored only in this browser and sent only to the base URL
            below — never to any other server.
          </p>

          <label className={LABEL} htmlFor={`${titleId}-key`}>
            API key
          </label>
          <div className="relative mb-10">
            <input
              ref={initialFocusRef}
              id={`${titleId}-key`}
              className={`${FIELD} pr-30`}
              type={revealKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button
              type="button"
              className="absolute right-6 top-1/2 grid h-20 w-20 -translate-y-1/2 place-items-center rounded-[5px] text-ink-dim hover:text-ink"
              onClick={() => setRevealKey((value) => !value)}
              aria-label={revealKey ? "Hide API key" : "Show API key"}
            >
              {revealKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>

          <label className={LABEL} htmlFor={`${titleId}-model`}>
            Model
          </label>
          <input
            id={`${titleId}-model`}
            className={`${FIELD} mb-10`}
            type="text"
            spellCheck={false}
            placeholder={DESIGN_MATE_DEFAULT_MODEL}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />

          <label className={LABEL} htmlFor={`${titleId}-base-url`}>
            Base URL
          </label>
          <input
            id={`${titleId}-base-url`}
            className={FIELD}
            type="text"
            spellCheck={false}
            placeholder={DESIGN_MATE_DEFAULT_BASE_URL}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />

          {error && (
            <p className="m-0 mt-8 text-[10.5px] font-semibold text-[#ef4444]">
              {error}
            </p>
          )}
          {savedNote && !error && (
            <p className="m-0 mt-8 text-[10.5px] font-semibold text-accent">
              Saved — Design Mate now uses your key directly.
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-panel-hairline px-16 py-11">
          <button
            type="button"
            className="text-[11px] font-semibold text-ink-dim transition-colors duration-140 ease-studio hover:text-[#ef4444] disabled:opacity-40"
            onClick={clear}
            disabled={!stored && !apiKey && !model && !baseUrl}
          >
            Clear settings
          </button>
          <div className="flex items-center gap-8">
            <button
              type="button"
              className="rounded-[7px] px-11 py-6 text-[11.5px] font-semibold text-ink-dim transition-colors duration-140 ease-studio hover:text-ink"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className="rounded-[7px] bg-linear-to-b from-accent-grad to-accent px-13 py-6 text-[11.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.24)] hover:brightness-[1.08]"
              onClick={save}
            >
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
