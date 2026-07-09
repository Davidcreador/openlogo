import { useEffect, useRef, useState } from "react";
import {
  Circle,
  Combine,
  Hexagon,
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
  "toolbar-button grid h-34 w-34 place-items-center rounded-[9px] transition-[background-color,color,box-shadow] duration-140 ease-studio";
const TOOL_BUTTON_ACTIVE =
  "bg-linear-to-b from-[#5d77f7] to-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.24),0_2px_8px_rgb(79_107_246/0.45)]";
const TOOL_BUTTON_IDLE =
  "text-chrome-dim hover:bg-chrome-raised hover:text-chrome-text";

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
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function pick(item: ToolSpec) {
    setLastShape(item);
    setTool(item.id);
    setOpen(false);
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
      >
        <Icon size={18} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="tool-flyout-caret"
        onClick={() => setOpen((value) => !value)}
        title="Shape library"
        aria-label="Shape library"
        aria-expanded={open}
      />
      {open && (
        <div className="tool-flyout menu" role="menu" aria-label="Shapes">
          {SHAPE_TOOLS.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`menu-item ${tool === item.id ? "active" : ""}`}
                role="menuitem"
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
  { id: "eyedropper", label: "Eyedropper", shortcut: "I", icon: Pipette },
];

export function Toolbar() {
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);

  const renderButton = (item: ToolSpec) => {
    const Icon = item.icon;
    const title = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
    return (
      <button
        key={item.id}
        type="button"
        className={`${TOOL_BUTTON} ${
          tool === item.id ? `active ${TOOL_BUTTON_ACTIVE}` : TOOL_BUTTON_IDLE
        }`}
        onClick={() => setTool(item.id)}
        title={title}
        aria-label={title}
        aria-pressed={tool === item.id}
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
      <ShapeToolSlot />
      {AFTER_SHAPES.map(renderButton)}
    </nav>
  );
}
