import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { colorInfo } from "../lib/color-info";

/**
 * Read-only print-awareness popover for a colour: CMYK conversion,
 * nearest generic spot reference (bundled PMS-approx LUT, no licensed
 * data) and an out-of-print-gamut hint. Display only — never writes.
 */
export function ColorInfoChip({ color }: { color: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const focusFrame = requestAnimationFrame(() => panelRef.current?.focus());
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const info = colorInfo(color);
  if (!info) {
    return null;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="color-info-trigger"
        className="grid h-28 w-24 flex-none cursor-pointer place-items-center rounded-field border border-field-border bg-field text-ink-dim transition-[border-color,color] duration-140 ease-studio hover:border-accent hover:text-accent"
        title="Print values (CMYK / spot reference)"
        aria-label="Print values"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) {
            setPos({
              top: Math.min(rect.bottom + 4, window.innerHeight - 140),
              left: Math.max(8, Math.min(rect.left - 180, window.innerWidth - 240)),
            });
          }
          setOpen((value) => !value);
        }}
      >
        <Info size={12} />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={popoverId}
          data-testid="color-info-popover"
          className="dialog-in fixed z-50 w-228 rounded-card border border-panel-hairline bg-card p-10 text-[11.5px] shadow-[0_10px_30px_rgb(0_0_0/0.45)]"
          style={{ top: pos.top, left: pos.left }}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${popoverId}-title`}
          tabIndex={-1}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (
              !event.currentTarget.contains(next) &&
              !triggerRef.current?.contains(next)
            ) {
              setOpen(false);
            }
          }}
        >
          <h3 id={`${popoverId}-title`} className="sr-only">
            Print color values for {color}
          </h3>
          <div className="mb-6 flex items-center gap-6">
            <i
              className="h-16 w-16 flex-none rounded-[4px] border border-[rgb(255_255_255/0.12)]"
              style={{ background: color }}
              aria-hidden="true"
            />
            <span className="font-[650] uppercase tabular-nums">{color}</span>
          </div>
          <div className="mb-4 tabular-nums text-ink" data-testid="color-info-cmyk">
            {info.cmykLabel}
          </div>
          {info.spot && (
            <div className="flex items-center gap-6 text-ink-dim" data-testid="color-info-spot">
              <i
                className="h-12 w-12 flex-none rounded-[3px] border border-[rgb(255_255_255/0.12)]"
                style={{ background: info.spot.hex }}
                aria-hidden="true"
              />
              <span>
                ≈ {info.spot.name}
                <span className="tabular-nums"> · ΔE {info.spot.deltaE.toFixed(1)}</span>
              </span>
            </div>
          )}
          {info.gamutHint && (
            <p
              className="mx-0 mb-0 mt-6 rounded-[6px] border-l-[3px] border-[#f59e0b] bg-[#fdf6e9] px-8 py-5 leading-[1.4] text-[#7c5a12]"
              data-testid="color-info-gamut"
            >
              {info.gamutHint}
            </p>
          )}
          <p className="mx-0 mb-0 mt-6 text-[10.5px] leading-[1.4] text-ink-dim">
            Naive CMYK (no ICC profile); spot match is a generic reference.
          </p>
        </div>
      )}
    </>
  );
}
