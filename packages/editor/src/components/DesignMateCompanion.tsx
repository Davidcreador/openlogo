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
import { ChevronUp, Sparkles, X } from "lucide-react";
import { useEditorStore } from "../state/editor-store";

const DesignMateSection = lazy(() =>
  import("./DesignMateSection").then((module) => ({
    default: module.DesignMateSection,
  })),
);

const PANEL_ID = "design-mate-companion-panel";
const PANEL_TITLE_ID = "design-mate-companion-title";
const PANEL_DESCRIPTION_ID = "design-mate-companion-description";

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
          className="rounded-[10px] border border-[rgb(194_70_62/0.2)] bg-[#fdf1f0] p-12 text-[11px] leading-[1.5] text-danger"
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

function MateMark({ thinking = false }: { thinking?: boolean }) {
  return (
    <span
      className={`relative grid h-36 w-36 shrink-0 place-items-center rounded-[12px] bg-[linear-gradient(145deg,#8b9cff_0%,var(--color-accent)_54%,#7447d8_100%)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_4px_14px_rgb(79_107_246/0.35)] ${
        thinking ? "animate-pulse" : ""
      }`}
      aria-hidden="true"
    >
      <span className="text-[14px] font-[800] tracking-[-0.06em]">M</span>
      <Sparkles
        size={10}
        className="absolute -right-2 -top-2 rounded-full bg-white p-1 text-accent shadow-[0_1px_5px_rgb(28_25_33/0.18)]"
        strokeWidth={2.4}
      />
    </span>
  );
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
          className={`design-mate-panel pointer-events-auto mb-10 h-[calc(100vh-176px)] max-h-[690px] min-h-420 w-[390px] flex-col overflow-hidden rounded-[18px] border border-[rgb(28_25_33/0.12)] bg-panel shadow-[0_2px_8px_rgb(28_25_33/0.12),0_24px_70px_rgb(28_25_33/0.22)] ${
            open ? "flex" : "hidden"
          }`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={PANEL_TITLE_ID}
          aria-describedby={PANEL_DESCRIPTION_ID}
        >
          <header className="flex shrink-0 items-center gap-10 border-b border-[rgb(255_255_255/0.08)] bg-[linear-gradient(135deg,#252133,#17151b)] px-13 py-11 text-chrome-text">
            <MateMark thinking={thinking} />
            <div className="min-w-0 flex-1">
              <h2
                id={PANEL_TITLE_ID}
                className="m-0 text-[13px] font-[700] tracking-[-0.01em]"
              >
                Design Mate
              </h2>
              <p
                id={PANEL_DESCRIPTION_ID}
                className="mb-0 mt-2 truncate text-[10px] text-chrome-dim"
              >
                Your honest creative sidekick
              </p>
            </div>
            <span className="flex items-center gap-4 text-[8.5px] font-[650] uppercase tracking-[0.06em] text-chrome-dim">
              <span
                className={`h-6 w-6 rounded-full ${
                  thinking ? "animate-pulse bg-amber-400" : "bg-emerald-400"
                }`}
                aria-hidden="true"
              />
              {thinking ? "Thinking" : "Here"}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              className="grid h-28 w-28 shrink-0 place-items-center rounded-m text-chrome-dim transition-colors duration-140 ease-studio hover:bg-chrome-raised hover:text-chrome-text"
              onClick={close}
              aria-label="Close Design Mate"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>

          <div className="inspector-card min-h-0 flex-1 overflow-y-auto bg-panel p-12">
            <DesignMateErrorBoundary>
              <Suspense
                fallback={
                  <div
                    className="grid min-h-120 place-items-center rounded-[10px] border border-panel-hairline bg-card text-[11px] text-ink-dim"
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
        className={`pointer-events-auto group flex min-w-216 items-center gap-9 rounded-[16px] border px-7 py-7 text-left shadow-[0_2px_7px_rgb(28_25_33/0.16),0_12px_32px_rgb(28_25_33/0.15)] transition-[transform,background-color,border-color,box-shadow] duration-180 ease-studio hover:-translate-y-1 hover:shadow-[0_3px_9px_rgb(28_25_33/0.18),0_16px_40px_rgb(28_25_33/0.2)] ${
          open
            ? "border-[rgb(142_160_250/0.32)] bg-[#201d28] text-chrome-text"
            : "border-[rgb(28_25_33/0.1)] bg-card text-ink"
        }`}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={activated ? PANEL_ID : undefined}
        aria-label={`${open ? "Close" : "Open"} Design Mate. ${statusLine}`}
      >
        <MateMark thinking={thinking} />
        <span className="min-w-0 flex-1">
          <strong className="block text-[11.5px] font-[700]">Design Mate</strong>
          <span
            className={`mt-1 block truncate text-[9.5px] ${
              open ? "text-chrome-dim" : "text-ink-dim"
            }`}
          >
            {statusLine}
          </span>
        </span>
        {snapshot && findingCount > 0 && (
          <span
            className="grid h-20 min-w-20 place-items-center rounded-full bg-accent px-5 text-[9px] font-[700] tabular-nums text-white"
            aria-hidden="true"
          >
            {findingCount}
          </span>
        )}
        <ChevronUp
          size={14}
          className={`shrink-0 transition-transform duration-180 ease-studio ${
            open ? "rotate-180 text-[#aebaff]" : "text-ink-dim"
          }`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
