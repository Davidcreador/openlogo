import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useEditorStore } from "../state/editor-store";

const TOAST_MS = 6000;

/**
 * Single transient status line (file open results, clipboard, export
 * errors). Non-blocking, self-dismissing; latest message wins.
 */
export function Toast() {
  const toast = useEditorStore((state) => state.toast);
  const setToast = useEditorStore((state) => state.setToast);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!toast || paused) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused, toast, setToast]);

  if (!toast) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-10 rounded-[9px] border border-chrome-hairline bg-chrome px-14 py-8 text-[12.5px] text-chrome-text shadow-[0_4px_16px_rgb(8_6_12/0.4)]"
      data-testid="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
    >
      <span role="status" aria-live="polite" aria-atomic="true">
        {toast}
      </span>
      <button
        type="button"
        className="grid h-24 w-24 flex-none place-items-center rounded-[5px] text-chrome-dim transition-colors hover:bg-chrome-raised hover:text-chrome-text"
        aria-label="Dismiss notification"
        onClick={() => {
          setPaused(false);
          setToast(null);
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
