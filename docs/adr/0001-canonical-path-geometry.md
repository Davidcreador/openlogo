# ADR 0001: Canonical editable path geometry

- Status: Accepted
- Date: 2026-07-09

## Context

OpenLogo historically allowed a `PathNode` to contain only SVG path data
(`d`). That is sufficient for rendering, boolean operations, and export, but
not for direct anchor editing. Imports and destructive geometry operations
could therefore produce vectors that looked correct yet silently lost editor
capability.

## Decision

- `PathGeometry` is the canonical direct-edit representation: subpaths,
  anchors, and Bezier handles.
- SVG path data remains on `PathNode` for rendering and interchange, derived
  from geometry whenever OpenLogo changes anchors.
- Every in-product operation that produces a path must also produce geometry.
- CanvasKit command streams are converted through one strict parser that owns
  verb validation, multi-subpaths, quadratics, conics, cubics, and cleanup.
- Legacy `d`-only paths materialize temporary geometry lazily when the user
  enters node editing. Materialization creates no history entry; the geometry
  persists only when a real edit commits.
- Failed conversion preserves the original path and operands.

## Consequences

- “Editable vector” has a testable data contract.
- Imported and generated results can use the same path-editing tools as pen
  paths.
- Loading large legacy documents remains fast because conversion is on demand.
- Conics may become cubic approximations only after a user performs a direct
  geometry edit; untouched SVG data remains unchanged.

