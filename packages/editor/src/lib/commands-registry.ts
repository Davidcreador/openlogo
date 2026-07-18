export const COMMAND_GROUPS = [
  "Tools",
  "Edit",
  "Arrange",
  "View",
  "Document",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export type CommandId =
  | "tool.select"
  | "tool.rectangle"
  | "tool.ellipse"
  | "tool.pen"
  | "tool.path"
  | "tool.text"
  | "tool.eyedropper"
  | "tool.gradient"
  | "tool.shape-builder"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.duplicate"
  | "edit.transform-again"
  | "edit.select-all"
  | "edit.delete"
  | "edit.group"
  | "edit.ungroup"
  | "edit.boolean-union"
  | "edit.boolean-subtract"
  | "edit.boolean-intersect"
  | "edit.boolean-exclude"
  | "arrange.forward"
  | "arrange.backward"
  | "arrange.front"
  | "arrange.back"
  | "arrange.align-left"
  | "arrange.align-center"
  | "arrange.align-right"
  | "arrange.align-top"
  | "arrange.align-middle"
  | "arrange.align-bottom"
  | "arrange.flip-horizontal"
  | "arrange.flip-vertical"
  | "arrange.transform"
  | "view.fit"
  | "view.actual-size"
  | "view.toggle-grid"
  | "view.design-mate"
  | "document.open"
  | "document.save"
  | "document.library"
  | "document.export";

export type CommandSpec = {
  id: CommandId;
  label: string;
  group: CommandGroup;
  shortcut?: string;
  keywords?: string;
};

export type CommandAvailability = {
  selectionCount: number;
  selectedGroupCount: number;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  canBoolean: boolean;
  viewportReady: boolean;
};

export const COMMANDS: readonly CommandSpec[] = [
  { id: "tool.select", label: "Select tool", group: "Tools", shortcut: "V" },
  { id: "tool.rectangle", label: "Rectangle tool", group: "Tools", shortcut: "R" },
  { id: "tool.ellipse", label: "Ellipse tool", group: "Tools", shortcut: "O" },
  { id: "tool.pen", label: "Pen tool", group: "Tools", shortcut: "P" },
  { id: "tool.path", label: "Starter mark tool", group: "Tools", shortcut: "M", keywords: "path" },
  { id: "tool.text", label: "Text tool", group: "Tools", shortcut: "T" },
  { id: "tool.eyedropper", label: "Eyedropper tool", group: "Tools", shortcut: "I", keywords: "sample color" },
  { id: "tool.gradient", label: "Gradient tool", group: "Tools", shortcut: "G" },
  { id: "tool.shape-builder", label: "Shape Builder tool", group: "Tools", shortcut: "S", keywords: "combine" },
  { id: "edit.undo", label: "Undo", group: "Edit", shortcut: "Mod+Z" },
  { id: "edit.redo", label: "Redo", group: "Edit", shortcut: "Shift+Mod+Z" },
  { id: "edit.cut", label: "Cut", group: "Edit", shortcut: "Mod+X" },
  { id: "edit.copy", label: "Copy", group: "Edit", shortcut: "Mod+C" },
  { id: "edit.paste", label: "Paste", group: "Edit", shortcut: "Mod+V" },
  { id: "edit.duplicate", label: "Duplicate", group: "Edit", shortcut: "Mod+C Mod+V" },
  { id: "edit.transform-again", label: "Transform Again", group: "Edit", shortcut: "Mod+D", keywords: "repeat" },
  { id: "edit.select-all", label: "Select All", group: "Edit", shortcut: "Mod+A" },
  { id: "edit.delete", label: "Delete selection", group: "Edit", shortcut: "Backspace" },
  { id: "edit.group", label: "Group", group: "Edit", shortcut: "Mod+G" },
  { id: "edit.ungroup", label: "Ungroup", group: "Edit", shortcut: "Shift+Mod+G" },
  { id: "edit.boolean-union", label: "Union shapes", group: "Edit", keywords: "boolean add combine" },
  { id: "edit.boolean-subtract", label: "Subtract shapes", group: "Edit", keywords: "boolean minus" },
  { id: "edit.boolean-intersect", label: "Intersect shapes", group: "Edit", keywords: "boolean overlap" },
  { id: "edit.boolean-exclude", label: "Exclude shapes", group: "Edit", keywords: "boolean xor" },
  { id: "arrange.forward", label: "Bring Forward", group: "Arrange", shortcut: "Mod+]" },
  { id: "arrange.backward", label: "Send Backward", group: "Arrange", shortcut: "Mod+[" },
  { id: "arrange.front", label: "Bring to Front", group: "Arrange", shortcut: "]" },
  { id: "arrange.back", label: "Send to Back", group: "Arrange", shortcut: "[" },
  { id: "arrange.align-left", label: "Align Left", group: "Arrange" },
  { id: "arrange.align-center", label: "Align Horizontal Center", group: "Arrange", keywords: "centre" },
  { id: "arrange.align-right", label: "Align Right", group: "Arrange" },
  { id: "arrange.align-top", label: "Align Top", group: "Arrange" },
  { id: "arrange.align-middle", label: "Align Vertical Center", group: "Arrange", keywords: "middle centre" },
  { id: "arrange.align-bottom", label: "Align Bottom", group: "Arrange" },
  { id: "arrange.flip-horizontal", label: "Flip Horizontal", group: "Arrange", keywords: "mirror reflect" },
  { id: "arrange.flip-vertical", label: "Flip Vertical", group: "Arrange", keywords: "mirror reflect" },
  { id: "arrange.transform", label: "Open Transform dialog", group: "Arrange", keywords: "rotate reflect" },
  { id: "view.fit", label: "Fit to View", group: "View", shortcut: "Mod+0", keywords: "zoom artboard" },
  { id: "view.actual-size", label: "Zoom to 100%", group: "View", shortcut: "Mod+1", keywords: "actual size" },
  {
    id: "view.toggle-grid",
    label: "Show Grid",
    group: "View",
    shortcut: "Mod+'",
    keywords: "overlay snap guides",
  },
  { id: "view.design-mate", label: "Toggle Design Mate", group: "View", keywords: "assistant review" },
  { id: "document.open", label: "Open document", group: "Document", shortcut: "Mod+O" },
  { id: "document.save", label: "Save document", group: "Document", shortcut: "Mod+S" },
  { id: "document.library", label: "Open Document Library", group: "Document", keywords: "projects history versions" },
  { id: "document.export", label: "Open Export", group: "Document", keywords: "svg png pdf" },
];

const NEEDS_SELECTION = new Set<CommandId>([
  "edit.cut",
  "edit.copy",
  "edit.duplicate",
  "edit.transform-again",
  "edit.delete",
  "arrange.forward",
  "arrange.backward",
  "arrange.front",
  "arrange.back",
  "arrange.align-left",
  "arrange.align-center",
  "arrange.align-right",
  "arrange.align-top",
  "arrange.align-middle",
  "arrange.align-bottom",
  "arrange.flip-horizontal",
  "arrange.flip-vertical",
  "arrange.transform",
]);

export function isCommandAvailable(
  id: CommandId,
  availability: CommandAvailability,
): boolean {
  if (id === "edit.undo") return availability.canUndo;
  if (id === "edit.redo") return availability.canRedo;
  if (id === "edit.paste") return availability.canPaste;
  if (id === "edit.group" || id === "tool.shape-builder") {
    return availability.selectionCount >= 2;
  }
  if (id === "edit.ungroup") return availability.selectedGroupCount > 0;
  if (id.startsWith("edit.boolean-")) return availability.canBoolean;
  if (id === "view.fit" || id === "view.actual-size") {
    return availability.viewportReady;
  }
  if (NEEDS_SELECTION.has(id)) return availability.selectionCount > 0;
  return true;
}

export function fuzzyScore(command: CommandSpec, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const haystack = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return direct;

  let score = 0;
  let cursor = 0;
  let previous = -1;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return null;
    score += previous === index - 1 ? 0 : index - cursor + 1;
    previous = index;
    cursor = index + 1;
  }
  return score + 20;
}

export function formatShortcut(shortcut: string, isMac = isMacPlatform()): string {
  const labels: Record<string, string> = {
    Mod: isMac ? "⌘" : "Ctrl",
    Shift: isMac ? "⇧" : "Shift",
    Alt: isMac ? "⌥" : "Alt",
    Plus: "+",
    Minus: "−",
    Backspace: isMac ? "⌫" : "Backspace",
  };
  return shortcut
    .split(" ")
    .map((chord) =>
      chord
        .split("+")
        .map((part) => labels[part] ?? part)
        .join(isMac ? "" : "+"),
    )
    .join(" ");
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export const SHORTCUT_GROUPS = [
  {
    label: "Tools",
    items: [
      ["Select", "V"], ["Rectangle", "R"], ["Ellipse", "O"],
      ["Pen", "P"], ["Starter mark", "M"], ["Text", "T"],
      ["Eyedropper", "I"], ["Gradient", "G"], ["Shape Builder", "S"],
    ],
  },
  {
    label: "Edit",
    items: [
      ["Undo", "Mod+Z"], ["Redo", "Shift+Mod+Z"], ["Cut", "Mod+X"],
      ["Copy", "Mod+C"], ["Copy as SVG", "Shift+Mod+C"], ["Paste", "Mod+V"],
      ["Transform Again", "Mod+D"], ["Select All", "Mod+A"],
      ["Group", "Mod+G"], ["Ungroup", "Shift+Mod+G"], ["Join paths", "Mod+J"],
      ["Make clipping mask", "Mod+7"], ["Release clipping mask", "Alt+Mod+7"],
      ["Make compound path", "Mod+8"], ["Release compound path", "Alt+Shift+Mod+8"],
      ["Delete", "Backspace"],
    ],
  },
  {
    label: "Arrange",
    items: [
      ["Bring Forward", "Mod+]"], ["Send Backward", "Mod+["],
      ["Bring to Front", "]"], ["Send to Back", "["],
      ["Nudge 1 px", "Arrow keys"], ["Nudge 10 px", "Shift+Arrow keys"],
    ],
  },
  {
    label: "View",
    items: [
      ["Fit to View", "Mod+0"], ["Zoom to 100%", "Mod+1"],
      ["Show Grid", "Mod+'"],
      ["Zoom in", "Mod+Plus"], ["Zoom out", "Mod+Minus"],
      ["Command Palette", "Mod+K"], ["Keyboard shortcuts", "Mod+/"],
    ],
  },
  {
    label: "File",
    items: [["Open document", "Mod+O"], ["Save document", "Mod+S"]],
  },
] as const;
