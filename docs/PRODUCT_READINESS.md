# OpenLogo product readiness

Last reviewed: 2026-07-10

## Verdict

OpenLogo already has a credible vector-editor core: a GPU canvas, a command
model with patch-based history, real bezier editing, PathOps booleans, groups,
multi-artboard logo systems, typography, gradients, effects, import/export,
and logo-specific review tooling. It is well beyond a prototype.

It is now a credible local-first product beta, not an Illustrator replacement.
The document lifecycle, recovery foundation, compound paths, clipping masks,
and core delivery formats exist. The largest remaining gaps are creative
fidelity at interoperability boundaries, semantic canvas accessibility,
measured frame and memory performance at scale, PDF/print color workflows, and
the collaboration layer users expect from a modern design product.

OpenLogo should not try to become a general-purpose Illustrator clone. The
product advantage is a fast, local-first studio dedicated to complete logo
systems: editable vectors, variants, brand assets, craft checks, and reliable
delivery packs.

## Competitive baseline

| Area | Illustrator | Figma | Kittl | OpenLogo direction |
| --- | --- | --- | --- | --- |
| Vector construction | Deep paths, compound paths, Shape Builder, masks, print tooling | Strong collaborative vector networks | Approachable shapes, templates, effects | Canonical editable paths, compound paths, and clipping ship now; live/non-destructive construction remains |
| Document model | Desktop/cloud documents and recovery | Files, pages, version history, multiplayer | Projects and template workflows | Local-first Logo Documents, crash recovery, named versions, then optional cloud sync |
| Collaboration | Cloud documents and review | Multiplayer, comments, sharing permissions | Sharing and asset workflows | Defer multiplayer until the local document contract is durable; add comments/review before co-editing |
| Brand workflow | Broad creative suite integration | Libraries/components | Brand kits, logos, fonts, templates | Make logo systems first-class: variants, palettes, type, clear-space rules, exports, reusable brand assets |
| Delivery | Broad formats and professional color | Product/UI export presets | Fast social/brand exports | Deterministic SVG/PNG/JPEG/WebP/ICO now; then PDF, color profiles, preflight, and reusable batch presets |

Primary references:

- [Adobe Illustrator features](https://www.adobe.com/products/illustrator/features.html)
- [Adobe Shape Builder](https://helpx.adobe.com/illustrator/using/building-new-shapes-using-shape.html)
- [Adobe compound paths](https://helpx.adobe.com/illustrator/desktop/manage-objects/reshape-transform-objects/create-compound-paths.html)
- [Adobe clipping masks](https://helpx.adobe.com/illustrator/desktop/manage-objects/edit-objects/about-clipping-masks.html)
- [Adobe Export for Screens](https://helpx.adobe.com/illustrator/using/collect-assets-export-for-screens.html)
- [Figma vector editing](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers)
- [Figma version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
- [Figma export formats and settings](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings)
- [Figma comments](https://help.figma.com/hc/en-us/articles/360039825314)
- [Figma sharing and permissions](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions)
- [Kittl logo maker](https://www.kittl.com/create/logos)
- [Kittl brand assets](https://help.kittl.com/editing-and-design/brand-assets/)

## Product principles

1. **Never lose work.** Restoration, autosave, file import, export, and schema
   migration are product features, not plumbing.
2. **Editable means editable.** Every operation that produces a path must also
   produce canonical geometry; legacy SVG data is materialized only when it is
   needed.
3. **One gesture, one history entry.** Preview work stays transient; committed
   intent is serializable and undoable.
4. **The canvas owns frames; React owns chrome.** Pointer previews invalidate
   the renderer directly and do not regenerate panels, thumbnails, and export
   previews on every move.
5. **Local-first, cloud-optional.** The Logo Document and Document Library contracts must be
   complete before sync or multiplayer is added.
6. **Interoperability over novelty.** SVG/PDF fidelity, fonts, color, and
   deterministic exports matter more than generative features.
7. **Logo systems, not isolated marks.** A Logo Document contains related variants,
   brand colors, typography, usage rules, assets, and delivery presets.

## Foundation milestone completed in this review

- Document restore now has a five-second fallback, late-load conflict guards,
  serialized committed-only saves, retryable failed saves, lifecycle flush,
  and visible session state. Unknown storage is quarantined instead of being
  overwritten by a fresh document.
- Path-producing operations and SVG import now retain canonical editable
  geometry. Existing `d`-only paths materialize geometry lazily when direct
  editing begins, without creating a fake undo step.
- Preview and committed document changes are distinct. CanvasKit receives live
  preview invalidations directly while expensive React chrome observes only
  committed snapshots.
- The renderer sleeps when clean instead of running a perpetual animation
  frame loop.
- Raster export and custom-artboard allocation are bounded; import, boolean,
  and export failures preserve original document content and surface a useful
  message.
- CanvasKit startup failure now shows a recovery surface instead of leaving a
  blank canvas.
- Uncaught React failures now preserve a last-resort document download before
  reload instead of stranding users behind a blank application shell.
- Compound paths are first-class editable Path Nodes with explicit fill rules,
  atomic make/release operations, safe operand checks, SVG round-tripping, and
  renderer/hit-test parity.
- Clipping Groups have explicit ownership, nested renderer and hit-test parity,
  atomic make/release, clone-safe identifiers, and conservative single-shape
  user-space SVG round-tripping.
- The live Document Library now supports multiple documents, safe legacy
  migration, optimistic head revisions, automatic and named versions,
  conflict preservation, flush-or-abort transitions, confirmed version restore,
  and recoverable archive/restore with atomic active-document handoff.
- If another tab archives the open head, a rejected late commit is preserved as
  an immutable recovery version before the editor reports the conflict.
- Raster delivery now covers bounded PNG, JPEG, and WebP jobs. JPEG requires an
  explicit opaque underlay, WebP can retain transparency, MIME fallbacks are
  rejected, and the whole batch is preflighted before allocation or download.
- Selection delivery uses conservative paint bounds, including rotated and
  clipped geometry, scaled path strokes, shadows, glows, and group effects.
- Editor chrome now has modal focus trapping/restoration, labelled stateful
  controls, keyboard layer/gradient actions, reduced-motion handling, and
  persistent dismissible status messages.
- Stable React, Effect, and CanvasKit runtimes now build as independently
  cacheable chunks. CI enforces a 400 KiB editor-entry budget, an 850 KiB
  initial-JavaScript budget, and a 7.5 MiB WASM ceiling. Non-critical document,
  export, and transform dialogs load on demand.
- Core, renderer, and editor packages all have active tests (367 total at this
  milestone), and the full workspace passes typecheck and production build.
- Design Mate now has deterministic critique, bounded local/remote chat,
  validated one-step proposals, explicit remote-data consent, session-scoped
  conversation persistence, and an authenticated streaming gateway.
- CI launches the production editor in headless Chrome/Chromium at desktop and
  390 px, verifies CanvasKit/document readiness, loads Design Mate, and checks
  Escape/focus restoration and the default-off remote consent control.
- Fixed 500- and 10,000-leaf model fixtures are benchmarkable, and browser User
  Timing separates document, renderer, and whole-editor readiness. Four warm
  browser reloads measured a 224 ms median to whole-editor ready (219-257 ms
  range) on the review machine.

Still required to close Gate 0 completely: automated browser journeys for
restore, edit, undo, import, and export (startup and Design Mate loading are now
covered in CI), a semantic/keyboard manipulation layer for CanvasKit objects
and anchors, repeatable frame-time/memory fixtures, and measured cold startup
on a fixed runner. Manual browser smoke in this review covered migration,
reload, named version restore, compound and clipping make/release,
archive/restore, modal focus restoration, raster-format validation, and
oversized export rejection.

## Delivery plan

### Gate 0 — trustworthy editor foundation

- Bounded document restore, serialized autosave, visible save state, lifecycle
  flush, failed-save retry, and recovery checkpoints.
- Canonical path geometry for imports and all destructive geometry operations.
- Idle renderer with invalidation-driven frames; narrowly scoped live preview
  subscriptions.
- Typed errors and safe limits for imports, raster allocation, and downloads.
- Unit tests in core, renderer, and editor; browser smoke tests for restore,
  edit, undo, import, export, and narrow layouts.
- Error boundary and explicit recovery UI for CanvasKit/font/storage failures.

Exit criterion: a crash, failed save, malformed file, or oversized export does
not silently lose work or strand the editor.

### Gate 1 — logo-grade creative fidelity

- Compound paths and explicit, non-destructive clipping masks are complete;
  richer flatten/expand workflows remain.
- Non-destructive/live booleans and offset paths, plus explicit Expand.
- Multiple fills and strokes; cap, join, dash, miter, inside/outside alignment.
- Better direct selection: rotated path editing, lasso, snapping while drawing,
  numeric point transforms, and scalable legacy-path operations.
- Type improvements: local font import/embedding, OpenType features, text on a
  path controls, missing-font resolution, deterministic outline conversion.
- SVG round-trip fidelity for gradients, masks, symbols, text, effects, and
  transforms; PDF import/export where licensing and browser limits permit.

Exit criterion: common logo files can move between OpenLogo and professional
tools without unexpected flattening or visual change.

### Gate 2 — product workflow

- Document Library with multiple local documents, rename, duplicate,
  archive/restore, versions, and recovery is complete; thumbnails and
  restore-as-copy remain.
- Automatic recovery timeline plus user-named versions and restore-as-copy.
- First-class brand assets: logo variants, palettes, type styles, icons,
  clear-space rules, and export presets.
- Templates and guided Logo Document setup without hiding manual vector controls.
- Export preflight and deterministic delivery packs with manifest metadata.
- Keyboard-first command palette, searchable actions, onboarding, and complete
  focus/screen-reader semantics for non-canvas workflows.

Exit criterion: a user can start, iterate, recover, organize, and deliver a
real client logo engagement without leaving OpenLogo for file management.

### Gate 3 — optional cloud and collaboration

- Accounts and encrypted object storage only after local document IDs, versions,
  and migrations are stable.
- Offline operation log, resumable sync, conflict copies, and explicit sync
  state before multiplayer.
- Share links, comments, review pins, roles, and permissions.
- Multiplayer presence and co-editing only after command semantics have
  deterministic convergence tests.

Exit criterion: offline edits and concurrent edits converge without silent
overwrite, and every shared action has a clear permission boundary.

### Gate 4 — professional delivery and scale

- PDF/EPS where technically supportable; print preflight, CMYK/spot
  color strategy, and embedded color profiles.
- Geometry/export workers, cancellation, progress, and bounded concurrency.
- Plugin/extension contract only after document and command APIs are versioned.
- Telemetry that is opt-in, privacy-preserving, and focused on failures and
  performance—not document contents.

## Performance budgets

Measure these in CI on fixed fixtures; do not claim performance from bundle
size or architecture alone.

| Scenario | Target |
| --- | --- |
| Warm editor ready | under 1 second on reference desktop |
| Cold editor ready, cached WASM | under 2 seconds |
| Pointer preview | 60 fps; p95 main-thread work under 8 ms |
| Typical logo (500 leaves) | pan/zoom and transform remain 60 fps |
| Stress document (10,000 leaves) | opens without crash; interactive within 5 seconds |
| Autosave | never blocks input; latest committed revision durable within 1 second |
| Undo/redo | p95 under 50 ms for normal operations |
| Export | cancelable; memory estimate checked before raster allocation |

Bundle work should prioritize startup execution and cacheability. CanvasKit is
large by nature; keep it immutable/cacheable, split non-critical panels and
export tooling, and track parsed/compiled WASM startup separately from transfer
size.

The repeatable fixtures, current local baseline, and browser User Timing marks
are documented in [PERFORMANCE.md](PERFORMANCE.md).

## Reliability and test matrix

- **Pure model:** property/fuzz tests for commands, history, schema migration,
  geometry conversion, and referential integrity.
- **Renderer:** golden fixtures for paths, effects, text, masks, and exports;
  scheduler tests prove idle sleep and invalidation behavior.
- **Editor services:** fake timers/storage for hydration races, retries,
  visibility/pagehide flush, quota errors, and restore deadlines.
- **Browser:** smoke journeys at desktop and 390 px; keyboard-only flows;
  import/export round trips; reload after every committed operation class.
- **Performance:** repeatable scene fixtures, frame-time traces, memory ceilings,
  and worker cancellation tests.
- **Compatibility:** Chrome, Safari, Firefox, high-DPI, reduced motion, offline,
  storage denied/quota full, missing fonts, corrupt documents, and oversized
  assets.

## Decisions for failure scenarios

| Scenario | Product behavior |
| --- | --- |
| Stored document is invalid | Preserve the raw record under a recovery key, start safely, explain recovery path |
| Restore is slow/unavailable | Open an editable fresh session after a deadline; never let late restore overwrite edits |
| Save fails | Keep the newest committed snapshot queued, show an error state, retry on the next commit/lifecycle flush |
| Geometry conversion fails | Preserve original SVG data and operands; show a scoped error; do not insert partial results |
| Raster request is unsafe | Reject before allocation with actionable dimension/area limits |
| Font is missing/offline | Preserve family metadata, render an explicit fallback, offer relink/outline when available |
| Cloud conflict (future) | Keep both versions or converge commands; never last-write-wins silently |
| Browser loses GPU/WASM | Preserve document state and offer renderer restart/reload; do not present a blank canvas as success |
