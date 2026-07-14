import { useEffect, useRef, useState } from "react";
import {
  Blend,
  Circle,
  Combine,
  Hexagon,
  LayoutTemplate,
  MousePointer2,
  MoveUpRight,
  PenTool,
  Pipette,
  Shapes,
  Slash,
  Square,
  Star,
  Triangle,
  Type,
} from "lucide-react";
import { type Tool, useEditorStore } from "../state/editor-store";

type ToolSpec = {
  id: Tool;
  label: string;
  shortcut?: string;
  icon: typeof Square;
};

/** Shape library behind the rectangle slot's flyout. */
const SHAPE_TOOLS: ToolSpec[] = [
  { id: "rectangle", label: "Rectangle", shortcut: "R", icon: Square },
  { id: "triangle", label: "Triangle", icon: Triangle },
  { id: "polygon", label: "Polygon", icon: Hexagon },
  { id: "star", label: "Star", icon: Star },
  { id: "line", label: "Line", icon: Slash },
  { id: "arrow", label: "Arrow", icon: MoveUpRight },
];

const SHAPE_TOOL_IDS = new Set(SHAPE_TOOLS.map((item) => item.id));

const LONG_PRESS_MS = 350;

const TOOL_BUTTON =
  "toolbar-button grid h-36 w-36 place-items-center rounded-[9px] transition-[background-color,color,box-shadow] duration-140 ease-studio";
const TOOL_BUTTON_ACTIVE =
  "bg-linear-to-b from-accent-grad to-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.24),0_2px_8px_var(--glow-45)]";
const TOOL_BUTTON_IDLE =
  "text-chrome-dim hover:bg-chrome-raised hover:text-chrome-text aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

/**
 * Rectangle tool slot with a shape-library flyout: click activates the
 * remembered shape, long-press (or the corner caret) opens the library.
 */
function ShapeToolSlot() {
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);
  const [open, setOpen] = useState(false);
  const [lastShape, setLastShape] = useState<ToolSpec>(SHAPE_TOOLS[0]!);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const mainButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByPress = useRef(false);

  // The slot mirrors whichever library shape is active.
  const active = SHAPE_TOOL_IDS.has(tool);
  const current = active
    ? (SHAPE_TOOLS.find((item) => item.id === tool) ?? lastShape)
    : lastShape;
  const Icon = current.icon;

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    const focusFrame = requestAnimationFrame(() => {
      const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      );
      const activeIndex = SHAPE_TOOLS.findIndex((item) => item.id === current.id);
      buttons?.[Math.max(0, activeIndex)]?.focus();
    });
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [current.id, open]);

  function pick(item: ToolSpec) {
    setLastShape(item);
    setTool(item.id);
    setOpen(false);
    requestAnimationFrame(() => mainButtonRef.current?.focus());
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? [],
    );
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1 + buttons.length) % buttons.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      mainButtonRef.current?.focus();
      return;
    }
    if (nextIndex !== null && buttons[nextIndex]) {
      event.preventDefault();
      buttons[nextIndex]!.focus();
    }
  }

  function clearPressTimer() {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  return (
    <div className="tool-flyout-anchor relative" ref={anchorRef}>
      <button
        ref={mainButtonRef}
        type="button"
        className={`${TOOL_BUTTON} relative ${
          active ? `active ${TOOL_BUTTON_ACTIVE}` : TOOL_BUTTON_IDLE
        }`}
        onPointerDown={() => {
          openedByPress.current = false;
          clearPressTimer();
          pressTimer.current = setTimeout(() => {
            openedByPress.current = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearPressTimer}
        onPointerLeave={clearPressTimer}
        onPointerCancel={clearPressTimer}
        onClick={() => {
          if (openedByPress.current) {
            openedByPress.current = false;
            return; // the long press already opened the flyout
          }
          pick(current);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        title={`${current.label}${current.shortcut ? ` (${current.shortcut})` : ""} — hold for more shapes`}
        aria-label={`${current.label}${current.shortcut ? ` (${current.shortcut})` : ""}`}
        aria-pressed={active}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="shape-tool-menu"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon size={18} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="tool-flyout-caret"
        onClick={() => setOpen((value) => !value)}
        title="Shape library"
        aria-label="Open shape library"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls="shape-tool-menu"
      />
      {open && (
        <div
          ref={menuRef}
          id="shape-tool-menu"
          className="tool-flyout menu"
          role="group"
          aria-label="Shapes"
          onKeyDown={handleMenuKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (
              !event.currentTarget.contains(next) &&
              !anchorRef.current?.contains(next)
            ) {
              setOpen(false);
            }
          }}
        >
          {SHAPE_TOOLS.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`menu-item ${tool === item.id ? "active" : ""}`}
                data-shape-id={item.id}
                aria-pressed={tool === item.id}
                onClick={() => pick(item)}
              >
                <ItemIcon size={14} strokeWidth={1.75} />
                <span className="menu-label">{item.label}</span>
                {item.shortcut && <small>{item.shortcut}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const AFTER_SHAPES: ToolSpec[] = [
  { id: "ellipse", label: "Ellipse", shortcut: "O", icon: Circle },
  { id: "pen", label: "Pen", shortcut: "P", icon: PenTool },
  { id: "path", label: "Starter mark", shortcut: "M", icon: Shapes },
  { id: "text", label: "Text", shortcut: "T", icon: Type },
  {
    id: "shapeBuilder",
    label: "Shape builder (select 2+ shapes)",
    shortcut: "S",
    icon: Combine,
  },
  {
    id: "gradient",
    label: "Gradient (drag on the selected shape)",
    shortcut: "G",
    icon: Blend,
  },
  { id: "eyedropper", label: "Eyedropper", shortcut: "I", icon: Pipette },
];

export function Toolbar() {
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const templatePanelOpen = useEditorStore((state) => state.templatePanelOpen);
  const setTemplatePanelOpen = useEditorStore(
    (state) => state.setTemplatePanelOpen,
  );

  const renderButton = (item: ToolSpec) => {
    const Icon = item.icon;
    const title = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
    const unavailable = item.id === "shapeBuilder" && selectedNodeIds.length < 2;
    return (
      <button
        key={item.id}
        type="button"
        className={`${TOOL_BUTTON} ${
          tool === item.id ? `active ${TOOL_BUTTON_ACTIVE}` : TOOL_BUTTON_IDLE
        }`}
        onClick={() => {
          if (!unavailable) {
            setTool(item.id);
          }
        }}
        title={title}
        aria-label={title}
        aria-pressed={tool === item.id}
        aria-disabled={unavailable}
      >
        <Icon size={18} strokeWidth={1.75} />
      </button>
    );
  };

  return (
    <nav
      className="toolbar mt-16 flex flex-col items-center gap-2 self-start justify-self-center rounded-panel border border-[rgb(0_0_0/0.5)] bg-linear-to-b from-[#1c1a22] to-chrome p-6 shadow-[inset_0_1px_0_var(--color-chrome-hairline),0_2px_6px_rgb(20_17_26/0.18),0_14px_36px_rgb(20_17_26/0.26)]"
      aria-label="Tools"
    >
      {renderButton({
        id: "select",
        label: "Select",
        shortcut: "V",
        icon: MousePointer2,
      })}
      <span className="my-3 h-px w-20 bg-chrome-border" aria-hidden="true" />
      <ShapeToolSlot />
      {AFTER_SHAPES.slice(0, 4).map(renderButton)}
      <span className="my-3 h-px w-20 bg-chrome-border" aria-hidden="true" />
      {AFTER_SHAPES.slice(4).map(renderButton)}
      <span className="my-3 h-px w-20 bg-chrome-border" aria-hidden="true" />
      <button
        type="button"
        className={`${TOOL_BUTTON} ${
          templatePanelOpen ? `active ${TOOL_BUTTON_ACTIVE}` : TOOL_BUTTON_IDLE
        }`}
        onClick={() => setTemplatePanelOpen(!templatePanelOpen)}
        title="Templates"
        aria-label="Templates"
        aria-pressed={templatePanelOpen}
        aria-expanded={templatePanelOpen}
        aria-controls="editor-template-panel"
      >
        <LayoutTemplate size={18} strokeWidth={1.75} />
      </button>
    </nav>
  );
}
