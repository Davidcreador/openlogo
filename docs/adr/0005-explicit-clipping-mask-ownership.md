# ADR 0005: Clipping Groups own one direct Clipping Path

- Status: Accepted
- Date: 2026-07-09

## Context

Illustrator-style clipping must stay editable, survive save and SVG exchange,
render with the same transforms and fill rule used for hit-testing, and release
without reconstructing flattened geometry. Per-node mask tags allow ambiguous
many-to-many relationships and become invalid when layers move or clone.

## Decision

- A Clipping Group is a normal `GroupNode` with one optional
  `clippingMaskId` referencing a direct rectangle, ellipse, or Path Node child.
- The group owns the relationship. Layer order does not determine ownership.
- The Clipping Path's paint, stroke, opacity, effects, and identity remain in
  the Logo Document, but only its filled geometry participates while clipped.
- Making and releasing a Clipping Group are each one command-history entry.
  Validation finishes before make; unsupported selections leave every source
  unchanged.
- CanvasKit rendering and hit-testing use the same transformed path and fill
  rule. Malformed ownership fails closed instead of exposing clipped content.
- SVG export uses a user-space `clipPath`. Import reconstructs ownership only
  for a conservative single-shape, user-space subset; unsupported SVG masks,
  object-bounding-box clips, and multi-element clip paths are not guessed.
- Reparenting a Clipping Path is blocked until its Clipping Group is released.
  Copy, paste, duplication, and variant cloning remap both child and ownership
  identifiers.
- Deleting a Clipping Path releases its content before removing the path. If
  the last content node is deleted or moved out, the empty structural group is
  released automatically and the Clipping Path is preserved.

## Consequences

- Clipping stays non-destructive and release restores original node styling.
- Nested Clipping Groups work without flattening.
- Selection bounds and hit-testing reflect the visible clipped intersection.
- Selection export bounds intersect rotated mask and content bounds, preventing
  rotated clipping geometry from being cropped during SVG or raster delivery.
- Boolean, Shape Builder, compound-release, and cross-path join operations
  reject Clipping Paths when they cannot preserve ownership safely.
- SVG alpha masks and multi-shape clipping unions remain explicit future work.
