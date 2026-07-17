import { useId, useRef } from "react";
import { X } from "lucide-react";
import { formatShortcut, SHORTCUT_GROUPS } from "../lib/commands-registry";
import { useModalDialog } from "../lib/use-modal-dialog";

export function ShortcutOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useModalDialog({ open, onClose, dialogRef, initialFocusRef: closeRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="overlay-in fixed inset-0 z-60 grid place-items-center bg-scrim p-20 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="dialog-in flex max-h-[min(820px,calc(100vh-40px))] w-[min(920px,calc(100vw-40px))] flex-col overflow-hidden rounded-[14px] border border-panel-hairline bg-panel shadow-[0_28px_90px_rgb(0_0_0/0.58)]">
        <header className="flex shrink-0 items-center justify-between border-b border-panel-hairline px-18 py-14">
          <div>
            <h1 id={titleId} className="m-0 text-[15px] font-bold text-ink">
              Keyboard shortcuts
            </h1>
            <p className="mb-0 mt-3 text-[11px] text-ink-dim">
              Work faster without leaving the canvas.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="grid h-28 w-28 place-items-center rounded-m text-ink-dim transition-colors duration-140 ease-studio hover:bg-field hover:text-ink"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="grid min-h-0 grid-cols-1 gap-18 overflow-y-auto p-18 sm:grid-cols-2 lg:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.label}>
              <h2 className="m-0 mb-7 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                {group.label}
              </h2>
              <dl className="m-0 space-y-1">
                {group.items.map(([label, shortcut]) => (
                  <div
                    key={label}
                    className="flex min-h-28 items-center justify-between gap-10 rounded-m px-7 py-4 odd:bg-field/35"
                  >
                    <dt className="text-[11.5px] text-ink-dim">{label}</dt>
                    <dd className="m-0 shrink-0">
                      <kbd>{formatShortcut(shortcut)}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
