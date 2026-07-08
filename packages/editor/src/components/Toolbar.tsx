import {
  Circle,
  MousePointer2,
  PenTool,
  Pipette,
  Shapes,
  Square,
  Type,
} from "lucide-react";
import { type Tool, useEditorStore } from "../state/editor-store";

const tools: Array<{
  id: Tool;
  label: string;
  shortcut: string;
  icon: typeof Square;
}> = [
  { id: "select", label: "Select", shortcut: "V", icon: MousePointer2 },
  { id: "rectangle", label: "Rectangle", shortcut: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", shortcut: "O", icon: Circle },
  { id: "pen", label: "Pen", shortcut: "P", icon: PenTool },
  { id: "path", label: "Starter mark", shortcut: "M", icon: Shapes },
  { id: "text", label: "Text", shortcut: "T", icon: Type },
  { id: "eyedropper", label: "Eyedropper", shortcut: "I", icon: Pipette },
];

export function Toolbar() {
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);

  return (
    <nav className="toolbar" aria-label="Tools">
      {tools.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className={`toolbar-button ${tool === item.id ? "active" : ""}`}
            onClick={() => setTool(item.id)}
            title={`${item.label} (${item.shortcut})`}
            aria-label={`${item.label} (${item.shortcut})`}
            aria-pressed={tool === item.id}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
    </nav>
  );
}
