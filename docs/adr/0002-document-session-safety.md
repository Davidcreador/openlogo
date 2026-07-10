# ADR 0002: Document Session owns restore and autosave safety

- Status: Accepted
- Date: 2026-07-09

## Context

An asynchronous IndexedDB restore can race with early user input. Saving every
store notification can persist transient gesture previews, overlapping writes
can finish out of order, and a failed save can be forgotten before page exit.
A blocked storage request can also strand the whole editor indefinitely.

## Decision

- One `DocumentSession` coordinates restore, committed-change persistence,
  lifecycle flushes, visible state, and failure reporting.
- It subscribes before loading so any committed change or preview activity
  prevents a late restore from replacing active work.
- Only committed snapshots are queued for persistence.
- Writes are serialized. A newer revision supersedes an older pending revision,
  and the latest failed revision stays queued for a later flush.
- Restore gets a five-second UI deadline. The editor may open after the
  deadline, but persistence stays quarantined until storage proves readable.
- If late storage and new local work both exist, neither is overwritten; local
  autosave remains blocked and the user is directed to save a file copy.
- Invalid stored payloads are preserved under a recovery key before a fresh
  document is allowed to replace the active slot.

## Consequences

- Slow, failed, and out-of-order asynchronous work cannot silently replace a
  newer document revision.
- The status bar can accurately report restoring, saving, saved, and error.
- The revisioned Document Library replaces the old single-slot adapter while
  keeping these session semantics.
- Quarantined storage requires an explicit recovery/library workflow rather
  than an unsafe automatic overwrite.
