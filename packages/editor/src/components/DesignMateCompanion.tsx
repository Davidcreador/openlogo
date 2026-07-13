import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Sparkles, X } from "lucide-react";
import { useEditorStore } from "../state/editor-store";

const DesignMateSection = lazy(() =>
  import("./DesignMateSection").then((module) => ({
    default: module.DesignMateSection,
  })),
);

const PANEL_ID = "design-mate-companion-panel";
const PANEL_TITLE_ID = "design-mate-companion-title";

class DesignMateErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Design Mate failed to load.", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div
          className="m-12 rounded-[10px] bg-danger/10 p-12 text-[11px] leading-[1.5] text-danger"
          role="status"
        >
          I hit a snag while getting ready. Your canvas is safe. Reload the
          editor when you want me back.
        </div>
      );
    }
    return this.props.children;
  }
}

export function DesignMateCompanion() {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const status = useEditorStore((state) => state.designMateStatus);
  const snapshot = useEditorStore((state) => state.designMateReview);
  const findingCount = snapshot?.review.findings.length ?? 0;
  const thinking = status === "reviewing";
  const statusLine = thinking
    ? "Give me a moment…"
    : status === "error"
      ? "I hit a snag—try me again"
      : snapshot
        ? findingCount === 0
          ? "Looking sharp from here"
          : `I spotted ${findingCount} ${
              findingCount === 1 ? "thing" : "things"
            }`
        : "Want a second pair of eyes?";

  function toggle(): void {
    setActivated(true);
    if (open) {
      close();
      return;
    }
    setOpen(true);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
  }

  function close(): void {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === "Escape" &&
        panel?.contains(document.activeElement)
      ) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="pointer-events-none absolute bottom-64 right-16 z-20 flex flex-col items-end">
      {activated && (
        <section
          ref={panelRef}
          id={PANEL_ID}
          className={`design-mate-panel pointer-events-auto mb-10 h-[calc(100vh-176px)] max-h-[690px] min-h-420 w-[390px] flex-col overflow-hidden rounded-[14px] border border-panel-border bg-panel shadow-panel ${
            open ? "flex" : "hidden"
          }`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={PANEL_TITLE_ID}
        >
          <header className="flex shrink-0 items-center gap-7 border-b border-panel-hairline px-13 py-10">
            <Sparkles
              size={14}
              className={`shrink-0 text-accent ${thinking ? "animate-pulse" : ""}`}
              aria-hidden="true"
            />
            <h2
              id={PANEL_TITLE_ID}
              className="m-0 min-w-0 flex-1 truncate text-[12px] font-[650] tracking-[-0.01em] text-ink"
            >
              Design Mate
            </h2>
            <button
              ref={closeButtonRef}
              type="button"
              className="grid h-26 w-26 shrink-0 place-items-center rounded-m text-ink-dim transition-colors duration-140 ease-studio hover:bg-chrome-raised hover:text-ink"
              onClick={close}
              aria-label="Close Design Mate"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col">
            <DesignMateErrorBoundary>
              <Suspense
                fallback={
                  <div
                    className="grid flex-1 place-items-center text-[11px] text-ink-dim"
                    role="status"
                    aria-live="polite"
                  >
                    Design Mate is getting ready…
                  </div>
                }
              >
                <DesignMateSection />
              </Suspense>
            </DesignMateErrorBoundary>
          </div>
        </section>
      )}

      <button
        ref={launcherRef}
        type="button"
        data-design-mate-trigger
        className={`pointer-events-auto flex items-center gap-6 rounded-full border px-11 py-7 shadow-float transition-[transform,background-color,border-color,color] duration-180 ease-studio hover:-translate-y-1 ${
          open
            ? "border-accent/40 bg-card text-ink"
            : "border-panel-border bg-card text-ink hover:border-accent/40"
        }`}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={activated ? PANEL_ID : undefined}
        aria-label={`${open ? "Close" : "Open"} Design Mate. ${statusLine}`}
      >
        <Sparkles
          size={13}
          className={`shrink-0 text-accent ${thinking ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
        <span className="text-[11px] font-[650]">Design Mate</span>
        {snapshot && findingCount > 0 && (
          <span
            className="grid h-16 min-w-16 place-items-center rounded-full bg-accent px-4 text-[8.5px] font-[700] tabular-nums text-white"
            aria-hidden="true"
          >
            {findingCount}
          </span>
        )}
      </button>
    </div>
  );
}
