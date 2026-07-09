import type { Bounds } from "./geometry";
import { createId } from "./id";
import type {
  Artboard,
  EllipseNode,
  GroupNode,
  LogoDocument,
  LogoNode,
  LogoVariant,
  PathNode,
  RectangleNode,
  TextNode,
} from "./types";
import { DOCUMENT_SCHEMA_VERSION } from "./types";

const DEFAULT_FONT_STACK = "Inter, ui-sans-serif, system-ui, sans-serif";
export const PATH_INTRINSIC_SIZE = 96;

type BaseOptions = {
  x: number;
  y: number;
  fill?: string;
};

function baseNode(options: BaseOptions) {
  return {
    id: createId("node"),
    name: "Node",
    x: options.x,
    y: options.y,
    width: 96,
    height: 96,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { type: "solid" as const, color: options.fill ?? "#111827" },
  };
}

export function createRectangle(options: BaseOptions): RectangleNode {
  return {
    ...baseNode(options),
    type: "rectangle",
    name: "Rectangle",
    width: 120,
    height: 80,
    cornerRadius: 12,
  };
}

export function createEllipse(options: BaseOptions): EllipseNode {
  return {
    ...baseNode(options),
    type: "ellipse",
    name: "Ellipse",
    width: 96,
    height: 96,
  };
}

export function createPath(
  options: BaseOptions & { d?: string; name?: string },
): PathNode {
  return {
    ...baseNode(options),
    type: "path",
    name: options.name ?? "Mark",
    d:
      options.d ??
      // Starter heart-style mark in the 96×96 intrinsic space.
      "M48 4 C68 4 84 20 84 40 C84 66 62 78 48 92 C34 78 12 66 12 40 C12 20 28 4 48 4 Z M48 22 C38 30 32 38 32 48 C32 58 39 66 48 70 C57 66 64 58 64 48 C64 38 58 30 48 22 Z",
    intrinsicWidth: PATH_INTRINSIC_SIZE,
    intrinsicHeight: PATH_INTRINSIC_SIZE,
  };
}

export function createText(
  options: BaseOptions & { content?: string },
): TextNode {
  return {
    ...baseNode(options),
    type: "text",
    name: "Wordmark",
    width: 220,
    height: 56,
    content: options.content ?? "Brand",
    fontFamily: DEFAULT_FONT_STACK,
    fontSize: 44,
    fontWeight: 700,
    letterSpacing: -1,
    lineHeight: 1.2,
    align: "left",
  };
}

/**
 * Group node over existing children ids. Geometry fields are dead
 * placeholders (see GroupNode docs) — pass bounds only so fresh
 * documents serialize with plausible values.
 */
export function createGroup(
  children: string[],
  bounds?: Bounds | null,
): GroupNode {
  return {
    id: createId("group"),
    type: "group",
    name: "Group",
    x: bounds?.x ?? 0,
    y: bounds?.y ?? 0,
    width: Math.max(1, bounds?.width ?? 1),
    height: Math.max(1, bounds?.height ?? 1),
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { type: "solid", color: "#111827" },
    children,
  };
}

export function createArtboard(
  purpose: LogoVariant,
  options: Partial<Omit<Artboard, "id" | "purpose">> = {},
): Artboard {
  return {
    id: createId("artboard"),
    name: options.name ?? `${purpose[0]?.toUpperCase()}${purpose.slice(1)}`,
    x: options.x ?? 0,
    y: options.y ?? 0,
    width: options.width ?? 720,
    height: options.height ?? 420,
    background: options.background ?? "#f8fafc",
    purpose,
    nodeIds: options.nodeIds ?? [],
  };
}

export function createInitialDocument(): LogoDocument {
  const accent = createEllipse({ x: 172, y: 138, fill: "#2563eb" });
  accent.name = "Construction circle";
  accent.width = 112;
  accent.height = 112;
  accent.opacity = 0.12;

  const mark = createPath({
    x: 180,
    y: 140,
    name: "Sample mark",
    d: "M48 6 L88 78 H68 L60 62 H36 L28 78 H8 L48 6 Z M44 46 H52 L48 36 Z",
  });

  const wordmark = createText({ x: 300, y: 185, content: "OpenLogo" });
  wordmark.width = 260;
  wordmark.fontSize = 48;
  wordmark.letterSpacing = -1.4;

  const artboard = createArtboard("primary", {
    name: "Primary logo",
    nodeIds: [accent.id, mark.id, wordmark.id],
  });

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: createId("doc"),
    name: "Untitled OpenLogo",
    activeArtboardId: artboard.id,
    artboards: [artboard],
    nodes: {
      [accent.id]: accent,
      [mark.id]: mark,
      [wordmark.id]: wordmark,
    },
    palettes: [
      {
        id: createId("palette"),
        name: "Studio neutrals",
        colors: ["#111827", "#2563eb", "#f8fafc", "#f59e0b", "#10b981"],
      },
    ],
  };
}

/** Deep-clone the nodes of an artboard for variant creation. */
export function cloneArtboardForVariant(
  document: LogoDocument,
  sourceArtboardId: string,
  purpose: LogoVariant,
): { artboard: Artboard; nodes: LogoNode[] } {
  const source = document.artboards.find(
    (item) => item.id === sourceArtboardId,
  );

  if (!source) {
    throw new Error(`Artboard ${sourceArtboardId} not found.`);
  }

  const nodes: LogoNode[] = [];
  const nodeIds: string[] = [];

  // Clone whole subtrees with fresh ids — a cloned group must reference
  // cloned children, never the source artboard's nodes.
  const cloneSubtree = (nodeId: string, seen: Set<string>): string | null => {
    const node = document.nodes[nodeId];
    if (!node || seen.has(nodeId)) {
      return null;
    }
    seen.add(nodeId);
    const clone: LogoNode = structuredClone(node);
    clone.id = createId(node.type === "group" ? "group" : "node");
    if (clone.type === "group") {
      clone.children = clone.children
        .map((childId) => cloneSubtree(childId, seen))
        .filter((id): id is string => id !== null);
    }
    nodes.push(clone);
    return clone.id;
  };

  const seen = new Set<string>();
  for (const nodeId of source.nodeIds) {
    const cloneId = cloneSubtree(nodeId, seen);
    if (cloneId) {
      nodeIds.push(cloneId);
    }
  }

  const artboard = createArtboard(purpose, {
    name: `${purpose[0]?.toUpperCase()}${purpose.slice(1)} variant`,
    x: source.x + document.artboards.length * 48,
    y: source.y + document.artboards.length * 48,
    width: source.width,
    height: source.height,
    background: source.background,
    nodeIds,
  });

  return { artboard, nodes };
}
