# OpenLogo

OpenLogo is a manual-first logo design studio: Kittl-style approachability, Illustrator-inspired vector control, and a design-mate agent that assists the manual process instead of replacing it.

## Architecture

pnpm monorepo. Rendering is GPU-accelerated via **CanvasKit (Skia compiled to WASM)** — the same engine behind Chrome and Flutter. React drives only the UI chrome; the canvas renders outside React's cycle entirely.

```
packages/
  core/      Document model: scene graph, geometry, command-based ops,
             patch-based undo, zod-validated versioned schema. Pure TS,
             zero DOM deps, covered by unit tests.
  renderer/  CanvasKit scene renderer: camera (pan/zoom), drawing,
             hit-testing, font registry (Skia Paragraph text shaping).
  editor/    React app: canvas stage, tools, panels, IndexedDB autosave,
             SVG/PNG/JPEG/WebP/ICO export, Design Mate UI.
  design-mate/
             Headless review, context, chat, proposal, and provider runtime.
  design-mate-service/
             Authenticated Node.js SSE gateway for remote model providers.
poc/         Original SVG-DOM prototype, kept as reference.
```

Key decisions:

- **All document mutations are serializable commands** (`applyCommand` returns the next document + exact inverse). History stores patches, not snapshots — and the op-based model keeps the door open for realtime collaboration later.
- **Live drags use `DocumentStore.preview()`** — per-frame patches on top of the last committed state, committed as a single command at gesture end. One history entry per gesture.
- **Skia PathOps and Paragraph** provide production-grade boolean operations,
  editable geometry results, and text shaping without duplicating geometry
  engines in the editor.
- **Local-first library**: revisioned IndexedDB heads, recovery versions, and
  optimistic conflict preservation; no backend required.
- **Demand-loaded product surfaces**: Document Library, Export, and Transform
  dialogs load on first use and remain mounted afterward so startup stays lean
  without discarding in-progress dialog state.

Domain language is defined in [CONTEXT.md](CONTEXT.md); durable architecture
decisions live in [docs/adr](docs/adr).

## Current features

- GPU canvas with pan (middle-drag / scroll) and zoom (⌘/Ctrl + scroll), zoom-to-cursor
- Tools: select (V), rectangle (R), ellipse (O), pen (P), mark (M), text (T)
- Pen tool: click for corners, click-drag for smooth bezier points, click first
  anchor or Enter to finish, Escape to cancel
- Bezier node editing: double-click an editable or legacy SVG path to edit anchors and handles;
  click a segment to insert an anchor (exact de Casteljau split), select an
  anchor and press Delete to remove it
- Boolean operations via Skia PathOps: union, subtract (minus front),
  intersect, exclude — atomic single-undo replacement of the operands
- Compound paths (⌘/Ctrl+8) with editable nonzero/even-odd fill rules and
  atomic Release Compound Path (⌥⇧⌘8 / Alt+Shift+Ctrl+8)
- Non-destructive clipping groups (⌘/Ctrl+7; release with ⌥⌘7 / Alt+Ctrl+7):
  explicit mask ownership, nested CanvasKit clipping, clipped hit-testing,
  and standard single-shape `clipPath` SVG round-trip
- Smart-guide snapping while moving and resizing: edges and centers against
  other nodes and the artboard (hold Alt to disable)
- Move, 8-handle resize (Shift = proportional), marquee selection, shift
  multi-select, space-drag panning
- Double-click a wordmark to edit text inline on the canvas
- Clipboard: copy/cut/paste/duplicate (⌘C/⌘X/⌘V/⌘D), select all (⌘A),
  arrow-key nudge (⇧ = 10px), bring forward / send backward (⌘] / ⌘[)
- Text alignment (left/center/right, respected in SVG export) and line height
- Stroke controls with Expand (Skia outline-stroke → editable filled path)
- Align & distribute panel (to artboard for single selection), flip H/V
- Linear gradient fills with stop + angle editor
- Rotate copies: radial repeat around the artboard centre for badge marks
- Real nested groups (⌘G/⇧⌘G): scene-graph group nodes with derived bounds,
  group move/resize/rotate as a unit, double-click to enter a group /
  Esc to exit, ⌘-click select-through, nested layers panel with
  expand/collapse, nested `<g>` in SVG export
- Eyedropper (I), Alt-drag duplicate, ⌘0 fit / ⌘1 100% / ⌘± zoom
- Rulers with draggable guides (drag from ruler; guides snap; drag off to
  delete) and blend modes (multiply/screen/overlay/darken/lighten, exported
  as mix-blend-mode)
- Fill, opacity, rotation, corner radius, typography property controls
- Real text shaping with variable-weight Inter (bundled)
- Font browsing: curated 13-family catalog (sans/serif/display/mono) served
  as raw TTFs from the Fontsource CDN, fetched and registered on demand
- Text-to-path: convert wordmarks to editable glyph outlines (opentype.js on
  the same TTF bytes Skia renders with; kerning + letter-spacing preserved,
  quadratics elevated to cubics so outlines are pen-editable)
- Logo system artboard variants: icon, wordmark, horizontal, stacked
- Small-size preview strip (128/64/32/16 px) rendered from the actual SVG export
- SVG import (shapes, nested transforms, styles, and conservative user-space
  clipping groups — shapes become editable paths) and bounded
  SVG/PNG/JPEG/WebP/ICO export; JPEG gets an explicit opaque background while
  WebP can preserve transparency, and every raster batch is fully preflighted
  before any allocation or download; selection exports include rotated,
  clipped, stroked, and effect-painted extents
- Export pack: original + mono + reversed SVGs plus favicon 16/32/48 and
  512px icon PNGs in one click
- Brand colors: editing a swatch recolors every object using it (one undo)
- Patch-based undo/redo (⌘Z / ⇧⌘Z), 200-entry history
- Document Library with create, switch, duplicate, rename, archive/restore,
  independent file import, named versions, automatic recovery history, and
  confirmed version restore; archived documents restore without opening
- Serialized committed-state autosave with optimistic revisions, visible
  loading/saving/saved/error state, lifecycle flush, safe v1 migration, and
  conflict copies instead of silent last-write-wins
- Keyboard-focusable editor chrome, trapped/restored modal focus, reduced-motion
  support, persistent dismissible status messages, and labelled controls
- Design Mate: deterministic logo critique, canvas-linked findings, safe
  before/after proposals, bounded multimodal chat, and explicit approval before
  one-step undoable edits
- Local guidance works without a backend; optional remote AI requires explicit
  user consent and an independently deployed authenticated gateway

## Development

```bash
pnpm install
pnpm dev          # editor at http://localhost:5174
pnpm dev:design-mate # optional remote gateway at http://127.0.0.1:8787
pnpm test         # core, renderer, and editor unit tests
pnpm typecheck    # all packages
pnpm build        # production build
pnpm smoke:editor # production browser startup + Design Mate smoke
pnpm smoke:design-mate-service # gateway build + health smoke
pnpm bench        # repeatable 500/10,000-leaf model benchmarks
pnpm poc          # run the original SVG prototype
```

The gateway needs provider and authentication settings before it starts. See
[Design Mate setup, privacy, and deployment](docs/DESIGN_MATE.md); the
[service README](packages/design-mate-service/README.md) is the operator quick
reference.

## Roadmap

The product benchmark, readiness gates, performance budgets, and reliability
decisions live in [docs/PRODUCT_READINESS.md](docs/PRODUCT_READINESS.md). The
repeatable fixtures and startup instrumentation are documented in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).
