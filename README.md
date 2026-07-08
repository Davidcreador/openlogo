# OpenLogo

OpenLogo is a manual-first logo design studio: Kittl-style approachability, Illustrator-inspired vector control, and a design-mate agent that assists the manual process instead of replacing it.

## Architecture

pnpm monorepo. Rendering is GPU-accelerated via **CanvasKit (Skia compiled to WASM)** — the same engine behind Chrome and Flutter. React drives only the UI chrome; the canvas renders outside React's cycle entirely.

```
packages/
  core/      Document model: scene graph, geometry, command-based ops,
             patch-based undo, zod-validated versioned schema. Pure TS,
             zero DOM deps, fully unit-tested.
  renderer/  CanvasKit scene renderer: camera (pan/zoom), drawing,
             hit-testing, font registry (Skia Paragraph text shaping).
  editor/    React app: canvas stage, tools, panels, IndexedDB autosave,
             SVG/PNG export, design-mate review.
poc/         Original SVG-DOM prototype, kept as reference.
```

Key decisions:

- **All document mutations are serializable commands** (`applyCommand` returns the next document + exact inverse). History stores patches, not snapshots — and the op-based model keeps the door open for realtime collaboration later.
- **Live drags use `DocumentStore.preview()`** — per-frame patches on top of the last committed state, committed as a single command at gesture end. One history entry per gesture.
- **Skia PathOps and Paragraph** give production-grade boolean operations and text shaping without extra dependencies (booleans not yet wired into UI).
- **Local-first v1**: IndexedDB persistence, no backend.

## Current features

- GPU canvas with pan (middle-drag / scroll) and zoom (⌘/Ctrl + scroll), zoom-to-cursor
- Tools: select (V), rectangle (R), ellipse (O), pen (P), mark (M), text (T)
- Pen tool: click for corners, click-drag for smooth bezier points, click first
  anchor or Enter to finish, Escape to cancel
- Bezier node editing: double-click a pen path to edit anchors and handles;
  click a segment to insert an anchor (exact de Casteljau split), select an
  anchor and press Delete to remove it
- Boolean operations via Skia PathOps: union, subtract (minus front),
  intersect, exclude — atomic single-undo replacement of the operands
- Smart-guide snapping while moving and resizing: edges and centers against
  other nodes and the artboard (hold Alt to disable)
- Move, 8-handle resize, marquee selection, shift multi-select
- Fill, opacity, rotation, corner radius, typography property controls
- Real text shaping with variable-weight Inter (bundled)
- Logo system artboard variants: icon, wordmark, horizontal, stacked
- Small-size preview strip (128/64/32/16 px) rendered from the actual SVG export
- SVG and PNG export
- Patch-based undo/redo (⌘Z / ⇧⌘Z), 200-entry history
- Autosave + restore via IndexedDB
- Local "design mate" review pass for logo craft checks

## Development

```bash
pnpm install
pnpm dev          # editor at http://localhost:5174
pnpm test         # core unit tests
pnpm typecheck    # all packages
pnpm build        # production build
pnpm poc          # run the original SVG prototype
```

## Roadmap

1. Font browsing (Google Fonts pipeline) and text-to-path conversion
2. Pen handle symmetry modes; snapping while drawing; distance/spacing guides
3. Agent tools: critique, cleanup, variations, export prep (non-destructive)
4. Export packs: dark/light/mono variants, favicon set, brand guidelines
5. Workers for geometry ops and export off the main thread
