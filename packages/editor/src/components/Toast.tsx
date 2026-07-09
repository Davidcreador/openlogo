import { useEffect } from "react";
import { useEditorStore } from "../state/editor-store";

const TOAST_MS = 3200;

/**
 * Single transient status line (file open results, clipboard, export
 * errors). Non-blocking, self-dismissing; latest message wins.
 */
export function Toast() {
  const toast = useEditorStore((state) => state.toast);
  const setToast = useEditorStore((state) => state.setToast);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, setToast]);

  if (!toast) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-[9px] border border-chrome-hairline bg-chrome px-14 py-8 text-[12.5px] text-chrome-text shadow-[0_4px_16px_rgb(8_6_12/0.4)]"
      role="status"
      data-testid="toast"
    >
      {toast}
    </div>
  );
}
