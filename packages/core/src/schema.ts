import { z } from "zod";
import type { LogoDocument } from "./types";
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

export function parseDocument(data: unknown): LogoDocument {
  const parsed = documentSchema.parse(data);

  if (parsed.schemaVersion > DOCUMENT_SCHEMA_VERSION) {
    throw new Error(
      `Document schema v${parsed.schemaVersion} is newer than this build supports (v${DOCUMENT_SCHEMA_VERSION}).`,
    );
  }

  // Future migrations: if (parsed.schemaVersion < N) { migrate... }
  return parsed as LogoDocument;
}
