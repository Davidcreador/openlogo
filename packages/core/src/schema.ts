import { Data, Effect } from "effect";
import { z } from "zod";
import { boundsUnion } from "./geometry";
import { createGroup } from "./factory";
import { nodeBounds } from "./queries";
import type { LogoDocument, LogoNode } from "./types";
import { DOCUMENT_SCHEMA_VERSION } from "./types";

/**
 * Versioned document schema. `parseDocument` is the only entry point for
 * untrusted data (files, IndexedDB, future API payloads). Bump
 * DOCUMENT_SCHEMA_VERSION and add a migration step when the shape changes.
 */

const solidPaintSchema = z.object({
  type: z.literal("solid"),
  color: z.string(),
});

const gradientPaintSchema = z.object({
  type: z.literal("linear-gradient"),
  angle: z.number(),
  stops: z.array(z.object({ offset: z.number(), color: z.string() })),
});

const paintSchema = z.discriminatedUnion("type", [
  solidPaintSchema,
  gradientPaintSchema,
]);

const strokeSchema = z.object({
  color: z.string(),
  width: z.number().nonnegative(),
  align: z.enum(["center", "inside", "outside"]),
});

const effectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("drop-shadow"),
    enabled: z.boolean(),
    dx: z.number(),
    dy: z.number(),
    blur: z.number().nonnegative(),
    color: z.string(),
    opacity: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("outline"),
    enabled: z.boolean(),
    width: z.number().nonnegative(),
    color: z.string(),
    opacity: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("bevel"),
    enabled: z.boolean(),
    size: z.number().nonnegative(),
    soften: z.number().nonnegative(),
    intensity: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("glow"),
    enabled: z.boolean(),
    blur: z.number().nonnegative(),
    color: z.string(),
    opacity: z.number().min(0).max(1),
  }),
]);

const baseNodeShape = {
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
  fill: paintSchema,
  stroke: strokeSchema.optional(),
  /** v1 tag-based grouping; accepted on load, migrated to GroupNodes. */
  groupId: z.string().optional(),
  blendMode: z
    .enum(["multiply", "screen", "overlay", "darken", "lighten"])
    .optional(),
  effects: z.array(effectSchema).optional(),
};

const nodeSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseNodeShape,
    type: z.literal("rectangle"),
    cornerRadius: z.number().nonnegative(),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal("ellipse"),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal("path"),
    d: z.string(),
    intrinsicWidth: z.number().positive(),
    intrinsicHeight: z.number().positive(),
    shape: z
      .object({
        kind: z.enum(["triangle", "polygon", "star", "line", "arrow"]),
        sides: z.number().int().min(3).max(60).optional(),
        innerRatio: z.number().min(0.05).max(0.95).optional(),
      })
      .optional(),
    geometry: z
      .object({
        subpaths: z.array(
          z.object({
            closed: z.boolean(),
            points: z.array(
              z.object({
                x: z.number(),
                y: z.number(),
                handleIn: z
                  .object({ x: z.number(), y: z.number() })
                  .optional(),
                handleOut: z
                  .object({ x: z.number(), y: z.number() })
                  .optional(),
              }),
            ),
          }),
        ),
      })
      .optional(),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal("text"),
    content: z.string(),
    fontFamily: z.string(),
    fontSize: z.number().positive(),
    fontWeight: z.number(),
    letterSpacing: z.number(),
    lineHeight: z.number().positive(),
    align: z.enum(["left", "center", "right"]),
    onPath: z
      .object({
        pathId: z.string(),
        startOffset: z.number(),
        flip: z.boolean(),
      })
      .optional(),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal("group"),
    children: z.array(z.string()),
  }),
]);

const artboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  background: z.string(),
  purpose: z.enum(["primary", "icon", "wordmark", "horizontal", "stacked"]),
  nodeIds: z.array(z.string()),
  guides: z
    .object({ v: z.array(z.number()), h: z.array(z.number()) })
    .optional(),
});

export const documentSchema = z.object({
  schemaVersion: z.number(),
  id: z.string(),
  name: z.string(),
  activeArtboardId: z.string(),
  artboards: z.array(artboardSchema).min(1),
  nodes: z.record(z.string(), nodeSchema),
  palettes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      colors: z.array(z.string()),
    }),
  ),
});

/**
 * v1 → v2: convert `groupId` tag clusters into real GroupNodes. Members
 * of a cluster (in z-order) become the group's children; the group takes
 * the topmost member's z-position. The tag is stripped everywhere.
 */
function migrateGroupIdTags(document: LogoDocument): LogoDocument {
  const nodes: Record<string, LogoNode> = { ...document.nodes };

  const artboards = document.artboards.map((artboard) => {
    const clusters = new Map<string, string[]>();
    for (const id of artboard.nodeIds) {
      const tag = (nodes[id] as { groupId?: string } | undefined)?.groupId;
      if (tag) {
        clusters.set(tag, [...(clusters.get(tag) ?? []), id]);
      }
    }

    let nodeIds = artboard.nodeIds;
    for (const members of clusters.values()) {
      if (members.length < 2) {
        continue;
      }
      const indices = members.map((id) => nodeIds.indexOf(id));
      const insertAt = Math.max(...indices) - (members.length - 1);
      const group = createGroup(
        members,
        boundsUnion(
          members
            .map((id) => nodes[id])
            .filter((node): node is LogoNode => Boolean(node))
            .map(nodeBounds),
        ),
      );
      nodes[group.id] = group;
      nodeIds = nodeIds.filter((id) => !members.includes(id));
      nodeIds = [...nodeIds];
      nodeIds.splice(Math.min(insertAt, nodeIds.length), 0, group.id);
    }

    return nodeIds === artboard.nodeIds ? artboard : { ...artboard, nodeIds };
  });

  for (const [id, node] of Object.entries(nodes)) {
    if ((node as { groupId?: string }).groupId !== undefined) {
      const { groupId: _legacy, ...rest } = node as LogoNode & {
        groupId?: string;
      };
      nodes[id] = rest as LogoNode;
    }
  }

  return { ...document, nodes, artboards };
}

/**
 * Referential repair for structurally valid but inconsistent documents
 * (hand-edited or corrupted storage, or bugs in older builds). Zod can't
 * express these constraints, and the tree queries assume them:
 *
 * - activeArtboardId must name an existing artboard (else: first one)
 * - container references to missing nodes are dropped
 * - a node belongs to at most one container; later duplicate references
 *   (including group cycles — a child pointing at an ancestor) are cut
 * - nodes unreachable from any artboard are pruned from the table
 */
function sanitizeDocument(document: LogoDocument): LogoDocument {
  const nodes: Record<string, LogoNode> = { ...document.nodes };
  const claimed = new Set<string>();

  const sanitizeChildren = (ids: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const id of ids) {
      if (!nodes[id] || claimed.has(id)) {
        continue;
      }
      claimed.add(id);
      kept.push(id);
      const node = nodes[id]!;
      if (node.type === "group") {
        const children = sanitizeChildren(node.children);
        if (children.length !== node.children.length) {
          nodes[id] = { ...node, children };
        }
      }
    }
    return kept;
  };

  const artboards = document.artboards.map((artboard) => {
    const nodeIds = sanitizeChildren(artboard.nodeIds);
    return nodeIds.length === artboard.nodeIds.length
      ? artboard
      : { ...artboard, nodeIds };
  });

  for (const id of Object.keys(nodes)) {
    if (!claimed.has(id)) {
      delete nodes[id];
    }
  }

  // A text-on-path attachment must reference a surviving path node —
  // otherwise the renderer would chase a dangling id forever.
  for (const [id, node] of Object.entries(nodes)) {
    if (
      node.type === "text" &&
      node.onPath &&
      nodes[node.onPath.pathId]?.type !== "path"
    ) {
      const { onPath: _dangling, ...rest } = node;
      nodes[id] = rest;
    }
  }

  const activeArtboardId = artboards.some(
    (item) => item.id === document.activeArtboardId,
  )
    ? document.activeArtboardId
    : artboards[0]!.id;

  return { ...document, nodes, artboards, activeArtboardId };
}

export function parseDocument(data: unknown): LogoDocument {
  const parsed = documentSchema.parse(data);

  if (parsed.schemaVersion > DOCUMENT_SCHEMA_VERSION) {
    throw new Error(
      `Document schema v${parsed.schemaVersion} is newer than this build supports (v${DOCUMENT_SCHEMA_VERSION}).`,
    );
  }

  let document = parsed as LogoDocument;
  if (parsed.schemaVersion < 2) {
    document = migrateGroupIdTags(document);
  }

  return sanitizeDocument({ ...document, schemaVersion: DOCUMENT_SCHEMA_VERSION });
}

/** Decode failure for untrusted document payloads (zod issues, version gate). */
export class DocumentDecodeError extends Data.TaggedError("DocumentDecodeError")<{
  readonly cause: unknown;
}> {}

/**
 * Effect entry point for untrusted data. Same semantics as `parseDocument`
 * (which stays the throwing primitive — its contract is test-asserted and
 * zod remains the validator; see the module note below), but failures land
 * in the typed error channel instead of an exception.
 */
export const parseDocumentEffect = (
  data: unknown,
): Effect.Effect<LogoDocument, DocumentDecodeError> =>
  Effect.try({
    try: () => parseDocument(data),
    catch: (cause) => new DocumentDecodeError({ cause }),
  });

/*
 * Why the validator is still zod and not effect/Schema: parseDocument is the
 * durability boundary for every stored document, and the two libraries differ
 * in load-bearing details (discriminated-union issue shapes, unknown-key
 * stripping, optional-property semantics under exactOptionalPropertyTypes).
 * Porting would have to prove byte-identical round-trips across the fuzz
 * corpus and every schema test before zod could be deleted; that proof burden
 * buys no new capability here, so the Effect adoption wraps the boundary
 * (typed DecodeError) rather than replacing the validator.
 */
