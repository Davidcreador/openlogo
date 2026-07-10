# ADR 0004: Local Document Library uses revisioned heads and immutable versions

- Status: Accepted
- Date: 2026-07-09

## Context

A single IndexedDB `current` slot cannot safely support multiple documents,
recovery history, concurrent tabs, or non-destructive migration. Last-write-wins
would silently replace work when two sessions save the same document. Document
switches also need a durable boundary: the current head must finish saving
before another head is adopted by the live editor.

## Decision

- IndexedDB database version 2 separates document heads, derived summaries,
  immutable versions, and workspace state. The legacy v1 `documents/current`
  record remains readable during migration.
- Every Document Head carries an integer revision. Commits use compare-and-swap
  against the expected revision.
- A stale commit never replaces the authoritative head. Its incoming snapshot
  is retained as a conflict Document Version, then the session reconciles to
  the authoritative head.
- Automatic recovery checkpoints are bounded; named, migration, conflict, and
  deleted-recovery versions are not pruned by automatic retention.
- Invalid heads and versions are quarantined. A corrupt head recovers from the
  newest valid retained version when possible; otherwise a validated fallback
  opens without destroying the raw record.
- Create, duplicate, import, switch, rename, named-version, and restore
  transitions flush the current Document Session first. Failure cancels the
  transition without changing the canvas or active-head pointer.
- Active-head archive flushes first; inactive archive and restore are metadata
  transitions and do not switch the Document Session.
- Restore commits the chosen immutable snapshot as a new head revision. It
  does not mutate or remove the version being restored.
- Archive retains the Document Head and every Document Version, marks the
  summary unavailable for normal activation, and rejects commits until restore.
  Archiving the active document and adopting another unarchived head happen in
  one repository transaction; the final unarchived document cannot be archived.
- A stale tab that commits after another tab archives its head cannot update
  that head, but its incoming snapshot is retained as an immutable conflict
  version before the typed archived-document rejection is returned.
- Permanent deletion remains deferred. Archive/restore is the only destructive
  library surface exposed by the product.

## Consequences

- The live app supports multiple local Logo Documents and durable history
  without silently overwriting concurrent edits.
- Migration is idempotent and non-destructive; old local work becomes a
  retained migration version.
- Repository contract tests can run against memory and IndexedDB adapters.
- Accidental removal is recoverable because archive never destroys a head or
  its retained versions.
- The additional records cost local storage, bounded for automatic versions.
- Cross-device sync remains future work, but document IDs, revisions, conflict
  copies, and immutable versions now provide a stable synchronization seam.
