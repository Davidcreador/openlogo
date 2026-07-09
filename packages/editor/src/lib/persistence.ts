import { Data, Effect, Schedule } from "effect";
import { type LogoDocument, parseDocumentEffect } from "@openlogo/core";

const DB_NAME = "openlogo";
const STORE_NAME = "documents";
const CURRENT_KEY = "current";

/** IndexedDB failure, tagged by which operation broke. */
export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly op: "open" | "get" | "put";
  readonly cause: unknown;
}> {}

const openDatabase = Effect.async<IDBDatabase, PersistenceError>((resume) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resume(Effect.succeed(request.result));
  request.onerror = () =>
    resume(Effect.fail(new PersistenceError({ op: "open", cause: request.error })));
});

/** Every operation runs inside acquire/use/release so the handle always closes. */
const withDatabase = <A, E>(
  use: (db: IDBDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PersistenceError> =>
  Effect.acquireUseRelease(openDatabase, use, (db) =>
    Effect.sync(() => db.close()),
  );

const putValue = (
  db: IDBDatabase,
  key: string,
  value: unknown,
): Effect.Effect<void, PersistenceError> =>
  Effect.async<void, PersistenceError>((resume) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resume(Effect.void);
    tx.onerror = () =>
      resume(Effect.fail(new PersistenceError({ op: "put", cause: tx.error })));
  });

const getValue = (
  db: IDBDatabase,
  key: string,
): Effect.Effect<unknown, PersistenceError> =>
  Effect.async<unknown, PersistenceError>((resume) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resume(Effect.succeed(request.result));
    request.onerror = () =>
      resume(Effect.fail(new PersistenceError({ op: "get", cause: request.error })));
  });

export const saveDocument = (
  document: LogoDocument,
): Effect.Effect<void, PersistenceError> =>
  withDatabase((db) =>
    putValue(db, CURRENT_KEY, JSON.parse(JSON.stringify(document))),
  );

/**
 * Rejected payloads are never destroyed: the very next autosave overwrites
 * CURRENT_KEY, so park them under a backup key first, then start fresh.
 */
const backupRejected = (
  db: IDBDatabase,
  data: unknown,
  error: unknown,
): Effect.Effect<null> => {
  const backupKey = `backup-${new Date().toISOString()}`;
  return putValue(db, backupKey, data).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        console.warn(
          `Stored document failed validation; it was preserved in IndexedDB ("${DB_NAME}" › "${STORE_NAME}" › "${backupKey}") and a fresh document was started.`,
          error,
        ),
      ),
    ),
    Effect.catchAll((backupError) =>
      Effect.sync(() =>
        console.warn(
          "Stored document failed validation AND could not be backed up.",
          error,
          backupError,
        ),
      ),
    ),
    Effect.as(null),
  );
};

export const loadDocument: Effect.Effect<LogoDocument | null, PersistenceError> =
  withDatabase((db) =>
    getValue(db, CURRENT_KEY).pipe(
      Effect.flatMap((data) => {
        if (!data) {
          return Effect.succeed(null);
        }
        return parseDocumentEffect(data).pipe(
          Effect.catchTag("DocumentDecodeError", (decodeError) =>
            backupRejected(db, data, decodeError.cause),
          ),
        );
      }),
    ),
  );

/**
 * Debounced autosave. Each save retries with exponential backoff before
 * giving up (transient IndexedDB failures — tab freeze, quota pressure —
 * usually clear); the final failure is logged, never thrown.
 */
export function createAutosave(
  getDocument: () => LogoDocument,
  delayMs = 800,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = (document: LogoDocument) =>
    saveDocument(document).pipe(
      Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 3 }),
      Effect.catchAll((error) =>
        Effect.sync(() => console.warn("Autosave failed", error)),
      ),
    );

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      Effect.runFork(save(getDocument()));
    }, delayMs);
  };
}
