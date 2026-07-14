# Plan — Projects Dashboard (Kittl-style)

Status: approved by Dave 2026-07-13. Dashboard-first boot, save-time thumbnails,
full v1 scope (grid + search + sort, preset row, import, folders).

## Goal

A full-screen home surface where the user manages their Logo Documents:
card grid with thumbnails, search, sort, new-document presets, import,
folders, and archived documents. The app boots into this dashboard; the
editor becomes a view entered by opening a document.

Vocabulary follows `CONTEXT.md`: these are **Logo Documents** in the
**Document Library** — not "projects" in code (UI copy may say what it wants).

## Phase 1 — Data layer

All in `packages/editor/src/lib/`, mirrored across
`indexeddb-document-repository.ts` and `memory-document-repository.ts`,
with tests updated in both.

1. Schema bump (new repository version + migration):
   - `DocumentSummary` += `thumbnail: string | null` (PNG dataUrl, ~320px
     longest edge), `folderId: string | null` (null = root).
   - New `folders` object store: `{ folderId, name, createdAt }`.
   - Migration: existing heads get `thumbnail: null`, `folderId: null`.
     Heads and versions must survive untouched (see ADR 0004 machinery).
2. Repository API additions:
   - `setThumbnail(documentId, dataUrl)` — must NOT bump revision or create
     versions; it is derived data.
   - `createFolder(name)`, `renameFolder(folderId, name)`,
     `deleteFolder(folderId)` (documents fall back to root),
     `moveDocument(documentId, folderId | null)`.
   - Bootstrap returns folders alongside document summaries.
3. Thumbnail generation:
   - After a committed save (`DocumentSession` save path /
     `documentLibrary.saveDocument`), render the active artboard to a small
     PNG and call `setThumbnail`. Debounce (e.g. trailing 2s) so drags don't
     thrash. Failure to thumbnail must never fail the save.
   - Rendering must not require the full editor to be mounted; reuse the
     existing renderer/SVG-export path headlessly.

## Phase 2 — Dashboard-first boot + UI

1. App view state: `view: "dashboard" | "editor"` in the editor store.
   Boot hydrates library bootstrap ONLY — CanvasKit compile + DocumentSession
   start are deferred until a document is opened. Do not regress the
   startup-budget work documented in `App.tsx` comments.
2. `DashboardView` component tree:
   - Header: search input (client-side name filter), sort dropdown
     (Recent / Name / Created).
   - Preset row: New blank, Logo 500×500, Square 1080×1080, Wide 1920×1080,
     Custom size… — creates a document with that artboard and enters editor.
   - Import: upload button + drag-drop for `.openlogo` (reuse existing open
     path) and SVG (reuse existing SVG import if present).
   - Tabs: Projects (root + folder filter) / Folders / Archived.
   - Card grid: thumbnail (placeholder showing artboard size when null),
     name, "Updated X ago", per-card menu: rename, duplicate, move to
     folder, archive, version history.
3. Editor chrome gets a "Back to projects" affordance. The existing
   `DocumentLibraryDialog` shrinks to an in-editor quick-switcher (keep
   version history UI reachable) — do not delete flows that only exist
   there until the dashboard covers them.

## Phase 3 — Polish

- Archived tab wired to existing archive/restore flows.
- Folder drag-and-drop of cards.
- Thumbnail backfill: on dashboard load, lazily render thumbnails for
  legacy documents that have none.

## Risks / invariants

- Schema migration must be forward-only and non-destructive; conflict and
  recovery version machinery (ADR 0002/0004) stays intact.
- Multi-tab: `setThumbnail` and folder ops must tolerate concurrent tabs
  the same way existing ops do (revision checks where relevant).
- One writer: single implementer branch; do not touch Design Mate surfaces.

## Verification

- `pnpm typecheck && pnpm test` (repo root).
- `pnpm --filter @openlogo/editor smoke:browser` still passes.
- Manual: fresh profile boots to dashboard; legacy IndexedDB profile
  migrates with documents intact and placeholder thumbnails.
