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

  return { ...document, schemaVersion: DOCUMENT_SCHEMA_VERSION };
}
