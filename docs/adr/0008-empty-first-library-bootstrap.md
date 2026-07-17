# ADR 0008: Repository bootstrap leaves a fresh Document Library empty

- Status: Accepted
- Date: 2026-07-16

## Context

ADR 0006 made the app dashboard-first, and the dashboard already renders a
first-run hero when the Document Library holds zero Logo Documents. That state
was unreachable: `bootstrap()` seeded a starter document whenever the store was
empty, so every fresh profile woke up with an "Untitled" head the user never
asked for. The starter document also polluted recovery paths — a blocked legacy
migration and an unrecoverable corrupt head both seeded a fallback head instead
of reporting what actually happened.

Every explicit creation flow (preset, template, custom size, import) already
exists on the dashboard and activates its document through
`createDocument(makeActive)`.

## Decision

- `DocumentRepository.bootstrap()` takes no initial document. On a fresh
  profile it performs no writes and returns an empty library:
  `documents: []`, `activeDocumentId: null`.
- `DocumentRepositoryBootstrap.activeDocumentId` is `string | null`; it is null
  exactly while the library is empty.
- The persisted `WorkspaceRecord` keeps its non-null `activeDocumentId`. The
  record is simply absent until the first `createDocument` writes it (that
  write already existed). This choice follows from the no-writes rule and
  leaves the IndexedDB v3 schema and its migration untouched.
- A valid legacy v1 document still migrates exactly as before and yields a
  non-empty library. A legacy payload that fails validation is left untouched
  and reported as a `blocked` migration over an empty library; no fallback
  starter is seeded. Because nothing is persisted, the blocked notice is
  recomputed on each bootstrap until the user creates a document.
- Workspace recovery no longer seeds a fallback: orphaned summaries or a
  workspace pointer without any head are cleared, and when every head is
  corrupt and unrecoverable the raw records are quarantined as before and the
  library reports empty with a `blocked` notice.
- Archiving rules are unchanged: the last unarchived document still cannot be
  archived. An empty library exists only before the first document is created,
  never as the result of archiving.
- The editor is only entered through an explicit open/create, so a null active
  document keeps the user on the dashboard; session resume already ignores
  markers that reference no stored document.

## Consequences

- The dashboard first-run hero is reachable, and the user's first Logo Document
  is one they explicitly chose.
- Failure states are honest: a blocked migration or total head corruption shows
  an empty library plus a notice instead of a silent starter document.
- Repository consumers must handle `activeDocumentId: null`; the controller
  state already allowed it.
- The blocked-migration notice disappears after the first create (the fresh
  workspace record stores `status: "none"`); the untouched legacy payload
  remains recoverable in the legacy store.
- Contract tests seed through `createDocument` like the product does, so the
  memory and IndexedDB adapters stay verifiably interchangeable.
