import { Data, Effect } from "effect";
import type opentype from "opentype.js";
import {
  type PathCommand,
  type PathNode,
  type TextNode,
  commandsToGeometry,
  createId,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
  pathGeometryBounds,
  pathGeometryToSvg,
  translatePathGeometry,
} from "@openlogo/core";
import { documentStore } from "../state/document";
import { catalogEntry, fontStore } from "./font-store";

/** Outline conversion failure: module load or glyph outlining threw. */
export class TextOutlineError extends Data.TaggedError("TextOutlineError")<{
  readonly stage: "load-opentype" | "outline";
  readonly cause: unknown;
}> {}

/**
 * opentype.js is heavy, so it loads lazily on first conversion and the
 * module stays memoized (`Effect.cached`). A module import has no release
 * side, so this is a cache, not an acquireRelease scope.
 */
const opentypeModule: Effect.Effect<typeof opentype, TextOutlineError> =
  Effect.runSync(
    Effect.cached(
      Effect.tryPromise({
        try: () => import("opentype.js").then((module) => module.default),
        catch: (cause) => new TextOutlineError({ stage: "load-opentype", cause }),
      }),
    ),
  );

/**
 * Convert a text node into an editable path node with real glyph
 * outlines. Uses opentype.js on the same TTF bytes Skia renders with,
 * so shapes match. Latin-only shaping (kerning yes, ligatures/complex
 * scripts no) — fine for logo work, v1.
 *
 * Succeeds with the new node id, or null when the node isn't convertible
 * (missing, not text, empty, font unavailable).
 */
export const convertTextToPath = (
  nodeId: string,
): Effect.Effect<string | null, TextOutlineError> =>
  Effect.gen(function* () {
    const document = documentStore.document;
    const node = document.nodes[nodeId];

    if (!node || node.type !== "text" || node.content.length === 0) {
      return null;
    }

    const family = catalogEntry(node.fontFamily) ?? catalogEntry("Inter")!;
    const [bytes, ot] = yield* Effect.all(
      [fontStore.ensureEffect(family.name, node.fontWeight), opentypeModule],
      { concurrency: "unbounded" },
    );
    if (!bytes) {
      return null;
    }

    return yield* Effect.try({
      try: () => outlineNode(ot, bytes, node),
      catch: (cause) => new TextOutlineError({ stage: "outline", cause }),
    });
  });

/** Pure-ish core: parse, outline, and swap the node in one batch command. */
function outlineNode(
  ot: typeof opentype,
  bytes: ArrayBuffer,
  node: TextNode,
): string | null {
  const document = documentStore.document;
  const font = ot.parse(bytes);
  const options: opentype.RenderOptions = {
    kerning: true,
    letterSpacing: node.letterSpacing / node.fontSize,
  };

  const scale = node.fontSize / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const advance = font.getAdvanceWidth(node.content, node.fontSize, options);

  const alignOffset =
    node.align === "center"
      ? (node.width - advance) / 2
      : node.align === "right"
        ? node.width - advance
        : 0;

  // Artboard-local baseline origin, matching the rendered text position.
  const otPath = font.getPath(
    node.content,
    node.x + alignOffset,
    node.y + ascent,
    node.fontSize,
    options,
  );

  const commands = otPath.commands as PathCommand[];
  const geometry = commandsToGeometry(commands);
  const bounds = pathGeometryBounds(geometry);
  if (!bounds) {
    return null;
  }

  const normalized = translatePathGeometry(geometry, -bounds.x, -bounds.y);
  const pathNode: PathNode = {
    id: createId("node"),
    type: "path",
    name: `${node.content} outlines`,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: node.rotation,
    opacity: node.opacity,
    visible: node.visible,
    locked: false,
    fill: structuredClone(node.fill),
    ...(node.stroke ? { stroke: { ...node.stroke } } : {}),
    d: pathGeometryToSvg(normalized),
    intrinsicWidth: bounds.width,
    intrinsicHeight: bounds.height,
    geometry: normalized,
  };

  // The outline replaces the text in its own container (group-aware).
  const artboard = getActiveArtboard(document);
  const containerId = findContainerId(document, node.id) ?? artboard.id;
  const index = getContainerChildIds(document, containerId).indexOf(node.id);
  const insertIndex = index === -1 ? undefined : index;

  documentStore.apply({
    type: "batch",
    label: "Convert to outlines",
    commands: [
      { type: "delete-nodes", nodeIds: [node.id] },
      {
        type: "insert-nodes",
        artboardId: artboard.id,
        ...(containerId !== artboard.id ? { containerId } : {}),
        nodes: [pathNode],
        ...(insertIndex !== undefined ? { index: insertIndex } : {}),
      },
    ],
  });

  return pathNode.id;
}

/** Preload every catalog font referenced by the document's text nodes. */
export function ensureDocumentFonts(): void {
  const document = documentStore.document;
  for (const node of Object.values(document.nodes)) {
    if (node.type === "text") {
      const family = catalogEntry(node.fontFamily);
      if (family) {
        void fontStore.ensure(family.name, node.fontWeight);
      }
    }
  }
}

/** Text-node helper so UI can gate the outline button. */
export function isConvertibleText(node: TextNode): boolean {
  return node.content.length > 0;
}
