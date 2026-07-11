import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Effect as Fx } from "effect";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  type FontCategory,
  type FontFamily,
  fontCatalog,
} from "../lib/font-catalog";
import {
  ensurePreview,
  isPreviewReady,
  previewsSnapshot,
  subscribePreviews,
} from "../lib/font-preview";

/**
 * Searchable font picker over the full Fontsource catalog (~1950 families).
 * The list is windowed by hand (fixed row height, one scroll container) —
 * at this size a virtualization dependency isn't warranted. Row previews
 * are lazy woff2 FontFaces; Skia typefaces are only registered on apply.
 */

const ROW_H = 28;
const LIST_H = ROW_H * 12;
const PANEL_W = 300;
const OVERSCAN = 6;
const RECENTS_KEY = "openlogo:font-recents";
const RECENTS_MAX = 8;

const CATEGORIES: { label: string; value: FontCategory }[] = [
  { label: "Sans", value: "sans" },
  { label: "Serif", value: "serif" },
  { label: "Display", value: "display" },
  { label: "Script", value: "handwriting" },
  { label: "Mono", value: "mono" },
];

const TRIGGER =
  "flex h-28 min-w-0 flex-1 cursor-pointer items-center justify-between gap-6 rounded-field border border-field-border bg-field px-8 text-[12px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio hover:border-accent focus-visible:border-accent focus-visible:shadow-ring";
const CHIP_BASE =
  "cursor-pointer rounded-full border px-8 py-2 text-[10.5px] transition-[border-color,color,background-color] duration-140 ease-studio";
const CHIP = `${CHIP_BASE} border-field-border bg-field text-ink-dim hover:border-accent hover:text-accent`;
const CHIP_ACTIVE = `${CHIP_BASE} border-accent bg-accent/10 text-accent`;

type Item =
  | { kind: "header"; label: string }
  | { kind: "font"; family: FontFamily };

/**
 * Decide whether a focus move should dismiss the picker.
 *
 * Options are non-focusable `role="option"` rows, so clicking one blurs the
 * search field with a null `relatedTarget`. Closing on that would unmount the
 * panel before the option's click fires. Real outside dismissals are handled
 * by the pointerdown listener (and by a non-null relatedTarget when focus
 * moves to another control).
 */
export function shouldCloseFontPickerOnBlur(
  panel: { contains(other: Node | null): boolean },
  trigger: { contains(other: Node | null): boolean } | null,
  relatedTarget: Node | null,
): boolean {
  if (relatedTarget == null) {
    return false;
  }
  return !panel.contains(relatedTarget) && !trigger?.contains(relatedTarget);
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

function pushRecent(name: string): string[] {
  const next = [name, ...loadRecents().filter((n) => n !== name)].slice(
    0,
    RECENTS_MAX,
  );
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Quota/private mode: recents just don't persist.
  }
  return next;
}

/** One windowed row; kicks off its preview after it has stayed visible. */
function FontRow({
  id,
  family,
  active,
  current,
  onApply,
  onHover,
}: {
  id: string;
  family: FontFamily;
  active: boolean;
  current: boolean;
  onApply: (family: FontFamily) => void;
  onHover: () => void;
}) {
  useEffect(() => {
    // Skipped past during a fast scroll → unmounts before the timer fires.
    const timer = setTimeout(() => ensurePreview(family), 120);
    return () => clearTimeout(timer);
  }, [family]);

  const ready = isPreviewReady(family.name);
  return (
    <div
      id={id}
      role="option"
      aria-selected={current}
      data-font-option={family.name}
      className={`flex w-full cursor-pointer items-center justify-between gap-8 border-0 px-10 text-left text-[13px] ${
        active ? "bg-accent/12 text-ink" : "bg-transparent text-ink"
      } ${current ? "text-accent" : ""}`}
      style={{ height: ROW_H, fontFamily: ready ? `"${family.name}"` : undefined }}
      onPointerEnter={onHover}
      // Keep search focused so the panel's blur handler never races the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onApply(family)}
    >
      <span className="truncate">{family.name}</span>
      {current && <Check size={12} className="flex-none" aria-hidden="true" />}
    </div>
  );
}

export function FontPicker({
  value,
  onApply,
}: {
  /** Current family name (node.fontFamily, unparsed). */
  value: string;
  onApply: (family: FontFamily) => void;
}) {
  const families = useSyncExternalStore(
    fontCatalog.subscribe,
    fontCatalog.getSnapshot,
  );
  useSyncExternalStore(subscribePreviews, previewsSnapshot);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FontCategory | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const pickerId = useId();
  const panelId = `${pickerId}-panel`;
  const listboxId = `${pickerId}-listbox`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const currentName = fontCatalog.entry(value)?.name ?? value;

  // Kick the catalog fetch the first time a picker exists (idempotent).
  useEffect(() => {
    void Fx.runPromise(fontCatalog.init());
  }, []);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = families.filter(
      (f) =>
        (!category || f.category === category) &&
        (!q || f.name.toLowerCase().includes(q)),
    );
    // Recents lead the browse view; a search/filter is already an answer.
    if (q || category) {
      return matches.map((family) => ({ kind: "font" as const, family }));
    }
    const recentFamilies = recents
      .map((name) => fontCatalog.entry(name))
      .filter((f): f is FontFamily => f !== undefined);
    if (recentFamilies.length === 0) {
      return matches.map((family) => ({ kind: "font" as const, family }));
    }
    return [
      { kind: "header", label: "Recent" },
      ...recentFamilies.map((family) => ({ kind: "font" as const, family })),
      { kind: "header", label: "All fonts" },
      ...matches.map((family) => ({ kind: "font" as const, family })),
    ];
  }, [families, query, category, recents]);

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPanelPos({
        top: Math.min(rect.bottom + 4, window.innerHeight - LIST_H - 120),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8)),
      });
    }
    setQuery("");
    setCategory(null);
    setScrollTop(0);
    setOpen(true);
  };

  // Position on the current font when the panel opens.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    searchRef.current?.focus();
    const index = items.findIndex(
      (item) => item.kind === "font" && item.family.name === currentName,
    );
    setActiveIndex(index);
    if (index >= 0 && listRef.current) {
      const target = Math.max(0, index * ROW_H - LIST_H / 2);
      listRef.current.scrollTop = target;
      setScrollTop(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on any pointer press outside the panel and trigger.
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
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const apply = (family: FontFamily) => {
    setRecents(pushRecent(family.name));
    onApply(family);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveActive = (delta: 1 | -1) => {
    let index = activeIndex;
    for (let step = 0; step < items.length; step += 1) {
      index += delta;
      if (index < 0 || index >= items.length) {
        return;
      }
      if (items[index]?.kind === "font") {
        break;
      }
    }
    setActiveIndex(index);
    const list = listRef.current;
    if (list) {
      const rowTop = index * ROW_H;
      if (rowTop < list.scrollTop) {
        list.scrollTop = rowTop;
      } else if (rowTop + ROW_H > list.scrollTop + LIST_H) {
        list.scrollTop = rowTop + ROW_H - LIST_H;
      }
    }
  };

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    const controlsList = event.target === searchRef.current;
    if (
      controlsList &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (controlsList && event.key === "Enter") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item?.kind === "font") {
        apply(item.family);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const totalHeight = items.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + LIST_H) / ROW_H) + OVERSCAN,
  );
  const activeItem = items[activeIndex];
  const activeOptionId =
    activeItem?.kind === "font"
      ? `${listboxId}-option-${activeIndex}-${activeItem.family.id}`
      : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="font-picker-trigger"
        className={TRIGGER}
        aria-label="Font family"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className="truncate">{currentName}</span>
        <ChevronDown
          size={12}
          className="flex-none text-ink-dim"
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          data-testid="font-picker-panel"
          className="dialog-in fixed z-50 flex flex-col gap-6 rounded-card border border-panel-hairline bg-card p-8 shadow-[0_10px_30px_rgb(0_0_0/0.45)]"
          style={{ top: panelPos.top, left: panelPos.left, width: PANEL_W }}
          role="dialog"
          aria-modal="false"
          aria-label="Choose a font family"
          onKeyDown={onPanelKeyDown}
          onBlur={(event) => {
            if (
              shouldCloseFontPickerOnBlur(
                event.currentTarget,
                triggerRef.current,
                event.relatedTarget as Node | null,
              )
            ) {
              setOpen(false);
            }
          }}
        >
          <div className="flex items-center gap-6 rounded-field border border-field-border bg-field px-8">
            <Search size={12} className="flex-none text-ink-dim" aria-hidden="true" />
            <input
              ref={searchRef}
              data-testid="font-search"
              className="h-26 w-full border-0 bg-transparent text-[12px] text-ink outline-none"
              role="combobox"
              aria-label="Search font families"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              placeholder={`Search ${families.length} fonts…`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(-1);
                setScrollTop(0);
                if (listRef.current) {
                  listRef.current.scrollTop = 0;
                }
              }}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                data-font-cat={cat.value}
                className={category === cat.value ? CHIP_ACTIVE : CHIP}
                aria-pressed={category === cat.value}
                onClick={() => {
                  setCategory(category === cat.value ? null : cat.value);
                  setActiveIndex(-1);
                  setScrollTop(0);
                  if (listRef.current) {
                    listRef.current.scrollTop = 0;
                  }
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div
            ref={listRef}
            id={listboxId}
            className="overflow-y-auto overscroll-contain"
            style={{ height: LIST_H }}
            role="listbox"
            aria-label="Font families"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {items.length === 0 ? (
              <p
                className="m-0 px-10 py-12 text-[12px] text-ink-dim"
                role="option"
                aria-selected="false"
                aria-disabled="true"
              >
                No fonts match.
              </p>
            ) : (
              <div
                role="presentation"
                style={{ height: totalHeight, position: "relative" }}
              >
                {items.slice(start, end).map((item, offset) => {
                  const index = start + offset;
                  const top = index * ROW_H;
                  if (item.kind === "header") {
                    return (
                      <div
                        key={`header-${item.label}`}
                        role="presentation"
                        className="flex items-end px-10 pb-3 text-[10px] font-[650] uppercase tracking-[0.08em] text-ink-dim"
                        style={{ position: "absolute", top, height: ROW_H, width: "100%" }}
                      >
                        {item.label}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`${index}-${item.family.id}`}
                      role="presentation"
                      style={{ position: "absolute", top, width: "100%" }}
                    >
                      <FontRow
                        id={`${listboxId}-option-${index}-${item.family.id}`}
                        family={item.family}
                        active={index === activeIndex}
                        current={item.family.name === currentName}
                        onApply={apply}
                        onHover={() => setActiveIndex(index)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
