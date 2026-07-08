export type Tool = "select" | "rectangle" | "ellipse" | "path" | "text";

export type LogoVariant =
  | "primary"
  | "icon"
  | "wordmark"
  | "horizontal"
  | "stacked";

export type Paint = {
  type: "solid";
  value: string;
};

export type Stroke = {
  color: string;
  width: number;
};

export type BaseNode = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  fill: Paint;
  stroke?: Stroke;
};

export type ShapeNode = BaseNode & {
  type: "rectangle" | "ellipse";
  cornerRadius?: number;
};

export type PathNode = BaseNode & {
  type: "path";
  d: string;
};

export type TextNode = BaseNode & {
  type: "text";
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
};

export type LogoNode = ShapeNode | PathNode | TextNode;

export type Artboard = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  purpose: LogoVariant;
  nodeIds: string[];
};

export type ColorPalette = {
  id: string;
  name: string;
  colors: string[];
};

export type LogoDocument = {
  id: string;
  name: string;
  activeArtboardId: string;
  artboards: Artboard[];
  nodes: Record<string, LogoNode>;
  palettes: ColorPalette[];
};

export type SelectionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

let idCounter = 0;

export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createInitialDocument(): LogoDocument {
  const primaryArtboardId = createId("artboard");
  const iconId = createId("node");
  const wordmarkId = createId("node");
  const accentId = createId("node");

  return {
    id: createId("doc"),
    name: "Untitled OpenLogo",
    activeArtboardId: primaryArtboardId,
    artboards: [
      {
        id: primaryArtboardId,
        name: "Primary logo",
        x: 0,
        y: 0,
        width: 720,
        height: 420,
        background: "#f8fafc",
        purpose: "primary",
        nodeIds: [accentId, iconId, wordmarkId],
      },
    ],
    nodes: {
      [accentId]: {
        id: accentId,
        type: "ellipse",
        name: "Construction circle",
        x: 172,
        y: 138,
        width: 112,
        height: 112,
        rotation: 0,
        opacity: 0.12,
        visible: true,
        locked: false,
        fill: { type: "solid", value: "#2563eb" },
      },
      [iconId]: {
        id: iconId,
        type: "path",
        name: "Sample mark",
        x: 180,
        y: 140,
        width: 96,
        height: 96,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        fill: { type: "solid", value: "#111827" },
        d: "M48 6 L88 78 H68 L60 62 H36 L28 78 H8 L48 6 Z M44 46 H52 L48 36 Z",
      },
      [wordmarkId]: {
        id: wordmarkId,
        type: "text",
        name: "Wordmark",
        x: 300,
        y: 185,
        width: 220,
        height: 58,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        fill: { type: "solid", value: "#111827" },
        content: "OpenLogo",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 48,
        fontWeight: 700,
        letterSpacing: -1.4,
      },
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

export function getActiveArtboard(document: LogoDocument): Artboard {
  const active = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  );

  if (!active) {
    throw new Error("Active artboard is missing from the document.");
  }

  return active;
}

export function getNodesForArtboard(
  document: LogoDocument,
  artboardId = document.activeArtboardId,
): LogoNode[] {
  const artboard = document.artboards.find((item) => item.id === artboardId);

  if (!artboard) {
    return [];
  }

  return artboard.nodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node));
}

export function getSelectionBounds(
  nodes: LogoNode[],
  selectedNodeIds: string[],
): SelectionBounds | null {
  const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));

  if (selectedNodes.length === 0) {
    return null;
  }

  const minX = Math.min(...selectedNodes.map((node) => node.x));
  const minY = Math.min(...selectedNodes.map((node) => node.y));
  const maxX = Math.max(...selectedNodes.map((node) => node.x + node.width));
  const maxY = Math.max(...selectedNodes.map((node) => node.y + node.height));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function duplicateArtboard(
  document: LogoDocument,
  purpose: LogoVariant,
): LogoDocument {
  const activeArtboard = getActiveArtboard(document);
  const suffix = purpose.charAt(0).toUpperCase() + purpose.slice(1);
  const nodeIdMap = new Map<string, string>();
  const clonedNodes: Record<string, LogoNode> = {};

  for (const nodeId of activeArtboard.nodeIds) {
    const node = document.nodes[nodeId];

    if (!node) {
      continue;
    }

    const nextId = createId("node");
    nodeIdMap.set(nodeId, nextId);
    clonedNodes[nextId] = {
      ...node,
      id: nextId,
      name: `${node.name} ${suffix}`,
    };
  }

  const newArtboard: Artboard = {
    ...activeArtboard,
    id: createId("artboard"),
    name: `${suffix} variant`,
    x: activeArtboard.x + document.artboards.length * 48,
    y: activeArtboard.y + document.artboards.length * 48,
    purpose,
    nodeIds: activeArtboard.nodeIds
      .map((nodeId) => nodeIdMap.get(nodeId))
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  };

  return {
    ...document,
    activeArtboardId: newArtboard.id,
    artboards: [...document.artboards, newArtboard],
    nodes: {
      ...document.nodes,
      ...clonedNodes,
    },
  };
}
