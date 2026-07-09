import { Data, Effect } from "effect";
import type opentype from "opentype.js";
import {
  type LogoDocument,
  type LogoNode,
  type PathCommand,
  type PathNode,
  type TextNode,
  commandsToGeometry,
  createId,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
  kernAt,
  kernToPx,
  pathGeometryBounds,
  pathGeometryToSvg,
  translatePathGeometry,
} from "@openlogo/core";
import { documentStore } from "../state/document";
import { catalogEntry } from "./font-catalog";
import { fontStore } from "./font-store";
import { kerningLookup } from "./opentype-kerning";
import { opentypeModule } from "./opentype-loader";

/** Outline conversion failure: module load or glyph outlining threw. */
export class TextOutlineError extends Data.TaggedError("TextOutlineError")<{
  readonly stage: "load-opentype" | "outline";
  readonly cause: unknown;
}> {}

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
      [
        fontStore.ensureEffect(
          family.name,
          node.fontWeight,
          node.fontStyle ?? "normal",
        ),
        opentypeModule.pipe(
          Effect.mapError(
            (error) =>
              new TextOutlineError({ stage: "load-opentype", cause: error.cause }),
          ),
        ),
      ],
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

/**
 * Build the outline PathNode for a text node WITHOUT touching the
 * document — the caller decides whether to swap it in (destructive
 * convert) or use it transiently (outline-text-on-export).
 *
 * Glyphs are placed one by one from cmap + advances, with GPOS/kern
 * pair kerning and the node's manual kerning map applied per gap. This
 * deliberately avoids opentype.js's shaping path (font.getPath /
 * forEachGlyph): its GSUB engine throws on lookup formats many Google
 * fonts use, and its kerning:true option only reads the legacy kern
 * table, which Fontsource TTFs don't carry. Trade-off: no ligatures —
 * unchanged from v1, which never shaped them either.
 */
function buildOutlinePathNode(
  ot: typeof opentype,
  bytes: ArrayBuffer,
  node: TextNode,
): PathNode | null {
  const font = ot.parse(bytes);

  const scale = node.fontSize / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const kern = kerningLookup(font);
  const glyphs = Array.from(node.content, (char) => font.charToGlyph(char));

  // Gap after glyph i: tracking + metrics kerning + manual kerning.
  const gapAfter = (i: number): number => {
    if (i >= glyphs.length - 1) {
      return 0;
    }
    return (
      node.letterSpacing +
      kern(node.content[i]!, node.content[i + 1]!) * node.fontSize +
      kernToPx(kernAt(node.kerning, i), node.fontSize)
    );
  };

  const advances = glyphs.map(
    (glyph, i) => (glyph.advanceWidth ?? 0) * scale + gapAfter(i),
  );
  const advance = advances.reduce((sum, value) => sum + value, 0);

  const alignOffset =
    node.align === "center"
      ? (node.width - advance) / 2
      : node.align === "right"
        ? node.width - advance
        : 0;

  // Artboard-local baseline origin, matching the rendered text position.
  const baseY = node.y + ascent;
  let penX = node.x + alignOffset;
  const commands: PathCommand[] = [];
  glyphs.forEach((glyph, i) => {
    commands.push(
      ...(glyph.getPath(penX, baseY, node.fontSize).commands as PathCommand[]),
    );
    penX += advances[i]!;
  });
  const geometry = commandsToGeometry(commands);
  const bounds = pathGeometryBounds(geometry);
  if (!bounds) {
    return null;
  }

  const normalized = translatePathGeometry(geometry, -bounds.x, -bounds.y);
  return {
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
}

/** Build the outline and swap it in for the text node, one batch command. */
function outlineNode(
  ot: typeof opentype,
  bytes: ArrayBuffer,
  node: TextNode,
): string | null {
  const document = documentStore.document;
  const pathNode = buildOutlinePathNode(ot, bytes, node);
  if (!pathNode) {
    return null;
  }

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
        void fontStore.ensure(
          family.name,
          node.fontWeight,
          node.fontStyle ?? "normal",
        );
      }
    }
  }
}

/** Text-node helper so UI can gate the outline button. */
export function isConvertibleText(node: TextNode): boolean {
  return node.content.length > 0;
}

/**
 * A copy of the document with every plain text node replaced by its
 * glyph-outline path (same node id, so containers and z-order hold).
 * The live document is NEVER mutated — this exists for the export
 * dialog's outline-text option. Nodes that can't outline (empty, font
 * unavailable) and text-on-path attachments (their layout lives in the
 * <textPath> export, not the straight-baseline outliner) pass through
 * as text.
 */
export const outlineDocumentTexts = (
  document: LogoDocument,
): Effect.Effect<LogoDocument, TextOutlineError> =>
  Effect.gen(function* () {
    const targets = Object.values(document.nodes).filter(
      (node): node is TextNode =>
        node.type === "text" && node.content.length > 0 && !node.onPath,
    );
    if (targets.length === 0) {
      return document;
    }

    const ot = yield* opentypeModule.pipe(
      Effect.mapError(
        (error) =>
          new TextOutlineError({ stage: "load-opentype", cause: error.cause }),
      ),
    );

    const nodes: Record<string, LogoNode> = { ...document.nodes };
    for (const node of targets) {
      const family = catalogEntry(node.fontFamily) ?? catalogEntry("Inter")!;
      const bytes = yield* fontStore.ensureEffect(
        family.name,
        node.fontWeight,
        node.fontStyle ?? "normal",
      );
      if (!bytes) {
        continue;
      }
      const outline = yield* Effect.try({
        try: () => buildOutlinePathNode(ot, bytes, node),
        catch: (cause) => new TextOutlineError({ stage: "outline", cause }),
      });
      if (outline) {
        nodes[node.id] = { ...outline, id: node.id, name: node.name };
      }
    }

    return { ...document, nodes };
  });
