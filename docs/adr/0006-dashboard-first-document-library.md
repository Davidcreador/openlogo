# ADR 0006: Dashboard-first startup uses derived Document Library metadata

- Status: Accepted
- Date: 2026-07-14

## Context

ADR 0004 made the Document Library safe for multiple Logo Documents, retained
versions, and concurrent tabs, but opening directly into the editor still hid
that library behind an active Document Session. It also paid the CanvasKit,
font, and editor startup costs before the user had chosen work to open.

A useful dashboard needs thumbnails and folders. Those are organizational and
derived data, not changes to the authoritative Logo Document. Storing them in
the Document Head would create revisions and recovery history for metadata
that can be rebuilt. Extending the local schema must also preserve every
existing head and immutable version.

## Decision

- Fresh visits start in the dashboard. Initial bootstrap reads Document Library
  metadata only; CanvasKit compilation, font preparation, and the Document
  Session remain cold until the user opens or creates a Logo Document.
- Reloading a tab that was actively editing resumes that Logo Document through
  a tab-scoped `sessionStorage` marker. New tabs and later fresh visits still
  start in the dashboard.
- IndexedDB version 3 adds a `folders` object store and adds nullable
  `thumbnail` and `folderId` fields to each Document Summary. The upgrade
  normalizes summaries in place and never rewrites Document Heads or Document
  Versions.
- Thumbnails and folder placement are summary metadata. Updating them does not
  advance the head revision or create a Document Version. Deleting a folder
  returns its Logo Documents to the Document Library root.
- A successful committed save schedules a trailing thumbnail render. Thumbnail
  generation and persistence are best-effort and cannot fail the save.
- Missing legacy thumbnails are backfilled lazily. A backfill writes only when
  the loaded head revision is still current; otherwise it is discarded and the
  dashboard keeps its placeholder.
- Search, sorting, presets, import, folders, archive/restore, and version-history
  entry points operate through the existing Document Library controller rather
  than creating a second persistence path.
- The product UI may say “Projects,” but code and architecture continue to use
  Logo Document and Document Library from `CONTEXT.md`.

## Consequences

- The app can present the user's work before loading the vector engine or
  starting persistence for an unchosen Logo Document.
- Refresh preserves editing continuity without turning every visit into an
  editor-first boot.
- Document thumbnails may briefly lag behind a save or remain placeholders when
  rendering/storage is unavailable; authoritative document safety is
  unaffected.
- Folder and thumbnail writes can occur independently of document commits, so
  repository adapters and concurrency tests must preserve both metadata and
  the latest head.
- The v3 migration is forward-only and non-destructive. A tab holding an older
  database connection may block the upgrade and must close or retry rather than
  trigger a destructive fallback.
- CanvasKit and editor-only modules must not leak back into dashboard bootstrap;
  the startup budget remains an architectural constraint.
