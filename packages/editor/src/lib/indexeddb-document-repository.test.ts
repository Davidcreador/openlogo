import { Effect } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createInitialDocument, type LogoDocument } from "@openlogo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_HEAD_STORE,
  DOCUMENT_SUMMARY_STORE,
  DOCUMENT_VERSION_STORE,
  IndexedDbDocumentRepository,
  LEGACY_DOCUMENT_STORE,
  OPENLOGO_DATABASE_VERSION,
  WORKSPACE_STORE,
} from "./indexeddb-document-repository";

let databaseSequence = 0;
const databases = new Set<string>();

function makeDocument(id: string, name: string): LogoDocument {
  return { ...createInitialDocument(), id, name };
}

function nextDatabaseName(): string {
  const name = `openlogo-migration-${++databaseSequence}`;
  databases.add(name);
  return name;
}

function openDatabase(
  databaseName: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(databaseName)
        : indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedLegacyDatabase(
  databaseName: string,
  entries: ReadonlyArray<readonly [IDBValidKey, unknown]>,
): Promise<void> {
  const database = await openDatabase(databaseName, 1, (upgrading) => {
    upgrading.createObjectStore(LEGACY_DOCUMENT_STORE);
  });
  const transaction = database.transaction(LEGACY_DOCUMENT_STORE, "readwrite");
  const store = transaction.objectStore(LEGACY_DOCUMENT_STORE);
  for (const [key, value] of entries) {
    store.put(structuredClone(value), key);
  }
  await transactionDone(transaction);
  database.close();
}

async function readLegacyEntries(
  databaseName: string,
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  const database = await openDatabase(databaseName);
  const transaction = database.transaction(LEGACY_DOCUMENT_STORE, "readonly");
  const store = transaction.objectStore(LEGACY_DOCUMENT_STORE);
  const keysRequest = store.getAllKeys();
  const valuesRequest = store.getAll();
  const [keys, values] = await Promise.all([
    new Promise<IDBValidKey[]>((resolve, reject) => {
      keysRequest.onsuccess = () => resolve(keysRequest.result);
      keysRequest.onerror = () => reject(keysRequest.error);
    }),
    new Promise<unknown[]>((resolve, reject) => {
      valuesRequest.onsuccess = () => resolve(valuesRequest.result);
      valuesRequest.onerror = () => reject(valuesRequest.error);
    }),
    transactionDone(transaction),
  ]);
  database.close();
  return keys.map((key, index) => ({ key, value: values[index] }));
}

function makeRepository(databaseName: string): IndexedDbDocumentRepository {
  let timestamp = 10_000;
  let id = 0;
  return new IndexedDbDocumentRepository({
    databaseName,
    indexedDB,
    keyRange: IDBKeyRange,
    now: () => timestamp++,
    createId: (prefix) => `${prefix}-${++id}`,
  });
}

async function corruptHeadWidth(
  databaseName: string,
  documentId: string,
): Promise<void> {
  const database = await openDatabase(databaseName);
  const transaction = database.transaction(DOCUMENT_HEAD_STORE, "readwrite");
  const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
  const request = headStore.get(documentId);
  request.onsuccess = () => {
    const head = request.result as { document: LogoDocument };
    head.document.artboards[0]!.width = -1;
    headStore.put(head);
  };
  await transactionDone(transaction);
  database.close();
}

async function corruptFirstVersionWidth(databaseName: string): Promise<void> {
  const database = await openDatabase(databaseName);
  const transaction = database.transaction(
    DOCUMENT_VERSION_STORE,
    "readwrite",
  );
  const versionStore = transaction.objectStore(DOCUMENT_VERSION_STORE);
  const request = versionStore.getAll();
  request.onsuccess = () => {
    const version = request.result[0] as { document: LogoDocument };
    version.document.artboards[0]!.width = -1;
    versionStore.put(version);
  };
  await transactionDone(transaction);
  database.close();
}

afterEach(async () => {
  await Promise.all(
    [...databases].map(
      (databaseName) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () =>
            reject(new Error(`Deletion blocked for ${databaseName}.`));
        }),
    ),
  );
  databases.clear();
});

describe("IndexedDbDocumentRepository migration", () => {
  it("imports a valid v1 current document once and leaves every legacy value untouched", async () => {
    const databaseName = nextDatabaseName();
    const legacy = makeDocument("legacy-document", "Legacy");
    const backup = makeDocument("legacy-backup", "Backup");
    await seedLegacyDatabase(databaseName, [
      ["current", legacy],
      ["backup-123", backup],
    ]);
    const repository = makeRepository(databaseName);

    const first = await Effect.runPromise(
      repository.bootstrap(makeDocument("fresh", "Fresh")),
    );
    const second = await Effect.runPromise(
      repository.bootstrap(makeDocument("ignored", "Ignored")),
    );
    const versions = await Effect.runPromise(
      repository.listVersions(legacy.id),
    );
    const entries = await readLegacyEntries(databaseName);

    expect(first).toMatchObject({
      activeDocumentId: legacy.id,
      migration: { status: "migrated", documentId: legacy.id },
      documents: [{ documentId: legacy.id, name: legacy.name, revision: 1 }],
    });
    expect(second).toEqual(first);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      kind: "migration",
      sourceRevision: 1,
      document: legacy,
    });
    expect(entries).toEqual([
      { key: "backup-123", value: backup },
      { key: "current", value: legacy },
    ]);
  });

  it("blocks invalid legacy data, creates a usable fresh head, and preserves the bad value", async () => {
    const databaseName = nextDatabaseName();
    const invalidLegacy = { schemaVersion: 999, broken: true };
    const fresh = makeDocument("fresh-document", "Fresh");
    await seedLegacyDatabase(databaseName, [["current", invalidLegacy]]);
    const repository = makeRepository(databaseName);

    const bootstrap = await Effect.runPromise(repository.bootstrap(fresh));
    const loaded = await Effect.runPromise(repository.loadDocument(fresh.id));
    const versions = await Effect.runPromise(
      repository.listVersions(fresh.id),
    );
    const entries = await readLegacyEntries(databaseName);

    expect(bootstrap.activeDocumentId).toBe(fresh.id);
    expect(bootstrap.migration).toMatchObject({ status: "blocked" });
    expect(loaded).toMatchObject({ revision: 1, document: fresh });
    expect(versions).toEqual([]);
    expect(entries).toEqual([{ key: "current", value: invalidLegacy }]);
  });

  it("serializes concurrent bootstrap attempts without duplicate imports", async () => {
    const databaseName = nextDatabaseName();
    const legacy = makeDocument("legacy-concurrent", "Concurrent legacy");
    await seedLegacyDatabase(databaseName, [["current", legacy]]);
    const firstRepository = makeRepository(databaseName);
    const secondRepository = makeRepository(databaseName);

    const [first, second] = await Promise.all([
      Effect.runPromise(
        firstRepository.bootstrap(makeDocument("fresh-one", "Fresh one")),
      ),
      Effect.runPromise(
        secondRepository.bootstrap(makeDocument("fresh-two", "Fresh two")),
      ),
    ]);
    const versions = await Effect.runPromise(
      firstRepository.listVersions(legacy.id),
    );

    expect(second).toEqual(first);
    expect(first.activeDocumentId).toBe(legacy.id);
    expect(first.documents).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.kind).toBe("migration");
  });

  it("upgrades the database to v2 with all repository stores", async () => {
    const databaseName = nextDatabaseName();
    const repository = makeRepository(databaseName);
    await Effect.runPromise(
      repository.bootstrap(makeDocument("initial", "Initial")),
    );

    const database = await openDatabase(databaseName);
    expect(database.version).toBe(OPENLOGO_DATABASE_VERSION);
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining([
        LEGACY_DOCUMENT_STORE,
        DOCUMENT_HEAD_STORE,
        DOCUMENT_SUMMARY_STORE,
        DOCUMENT_VERSION_STORE,
        WORKSPACE_STORE,
      ]),
    );
    database.close();
  });

  it("normalizes pre-archive summaries with no archivedAt field", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("legacy-summary", "Legacy summary");
    const repository = makeRepository(databaseName);
    const first = await Effect.runPromise(repository.bootstrap(initial));

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      DOCUMENT_SUMMARY_STORE,
      "readwrite",
    );
    const legacySummary = {
      ...first.documents[0]!,
    } as Partial<(typeof first.documents)[number]>;
    delete legacySummary.archivedAt;
    transaction.objectStore(DOCUMENT_SUMMARY_STORE).put(legacySummary);
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap(initial));
    const documents = await Effect.runPromise(repository.listDocuments());
    expect(recovered.documents[0]?.archivedAt).toBeNull();
    expect(documents[0]?.archivedAt).toBeNull();
  });

  it("repairs a workspace pointer that targets an archived head", async () => {
    const databaseName = nextDatabaseName();
    const first = makeDocument("available-head", "Available");
    const archived = makeDocument("archived-head", "Archived");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(first));
    const created = await Effect.runPromise(
      repository.createDocument({ document: archived, makeActive: true }),
    );

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      DOCUMENT_SUMMARY_STORE,
      "readwrite",
    );
    transaction.objectStore(DOCUMENT_SUMMARY_STORE).put({
      ...created.summary,
      archivedAt: 9_999,
    });
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap(first));
    expect(recovered.activeDocumentId).toBe(first.id);
    expect(
      recovered.documents.find(
        (document) => document.documentId === archived.id,
      )?.archivedAt,
    ).toBe(9_999);
  });

  it("commits archived-edit recovery before surfacing the rejection", async () => {
    const databaseName = nextDatabaseName();
    const available = makeDocument("available-document", "Available");
    const archived = makeDocument("archived-document", "Archived");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(available));
    await Effect.runPromise(
      repository.createDocument({ document: archived, makeActive: false }),
    );
    await Effect.runPromise(repository.archiveDocument(archived.id));

    const outcome = await Effect.runPromise(
      Effect.either(
        repository.commitDocument({
          documentId: archived.id,
          expectedRevision: 1,
          document: { ...archived, name: "Edit from another tab" },
        }),
      ),
    );

    const reopened = makeRepository(databaseName);
    const versions = await Effect.runPromise(reopened.listVersions(archived.id));
    const head = await Effect.runPromise(reopened.loadDocument(archived.id));
    const recoveryVersionId =
      outcome._tag === "Left" &&
      outcome.left._tag === "DocumentArchivedError"
        ? outcome.left.recoveryVersionId
        : null;

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentArchivedError",
        operation: "commit",
        recoveryVersionId: expect.any(String),
      },
    });
    expect(head).toMatchObject({
      revision: 1,
      document: { name: "Archived" },
    });
    expect(versions).toEqual([
      expect.objectContaining({
        versionId: recoveryVersionId,
        kind: "conflict",
        label: "Archived edit recovery",
        sourceRevision: 1,
        document: expect.objectContaining({ name: "Edit from another tab" }),
      }),
    ]);
  });

  it("repairs missing and orphaned summaries before selecting the active head", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("surviving-head", "Surviving document");
    const repository = makeRepository(databaseName);
    const first = await Effect.runPromise(repository.bootstrap(initial));

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      [DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
      "readwrite",
    );
    const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
    summaryStore.delete(initial.id);
    summaryStore.put({
      ...first.documents[0]!,
      documentId: "orphaned-summary",
      name: "Deleted document",
    });
    transaction.objectStore(WORKSPACE_STORE).put({
      key: "state",
      activeDocumentId: "orphaned-summary",
      legacyMigration: { status: "none" },
      migrationVersion: 1,
    });
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap(initial));
    const documents = await Effect.runPromise(repository.listDocuments());

    expect(recovered.activeDocumentId).toBe(initial.id);
    expect(recovered.documents).toEqual([
      expect.objectContaining({
        documentId: initial.id,
        name: initial.name,
        revision: 1,
      }),
    ]);
    expect(documents).toEqual(recovered.documents);
  });

  it("removes orphaned metadata when no authoritative heads survive", async () => {
    const databaseName = nextDatabaseName();
    const orphan = makeDocument("orphaned-head", "Orphaned document");
    const fallback = makeDocument("replacement-head", "Replacement document");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(orphan));

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(DOCUMENT_HEAD_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_HEAD_STORE).delete(orphan.id);
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap(fallback));
    const documents = await Effect.runPromise(repository.listDocuments());

    expect(recovered).toMatchObject({
      activeDocumentId: fallback.id,
      documents: [{ documentId: fallback.id, name: fallback.name }],
    });
    expect(documents).toEqual(recovered.documents);
  });

  it("quarantines a corrupt latest head and restores its newest valid version once", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("recoverable-head", "Known good version");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(initial));
    await Effect.runPromise(
      repository.createVersion({
        documentId: initial.id,
        kind: "named",
        label: "Before corruption",
      }),
    );
    await Effect.runPromise(
      repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 1,
        document: { ...initial, name: "Latest head" },
      }),
    );

    await corruptHeadWidth(databaseName, initial.id);

    const recovered = await Effect.runPromise(
      repository.bootstrap(makeDocument("fresh-fallback", "Fresh fallback")),
    );
    const loaded = await Effect.runPromise(repository.loadDocument(initial.id));
    const entriesAfterRecovery = await readLegacyEntries(databaseName);
    const repeated = await Effect.runPromise(
      repository.bootstrap(makeDocument("ignored", "Ignored")),
    );
    const entriesAfterRepeat = await readLegacyEntries(databaseName);

    expect(recovered).toMatchObject({
      activeDocumentId: initial.id,
      documents: [
        {
          documentId: initial.id,
          name: initial.name,
          revision: 3,
        },
      ],
      migration: {
        status: "blocked",
        reason: expect.stringContaining("recovery-head-"),
      },
    });
    expect(loaded).toMatchObject({
      revision: 3,
      document: {
        id: initial.id,
        name: initial.name,
        artboards: [{ width: initial.artboards[0]!.width }],
      },
    });
    expect(entriesAfterRecovery).toHaveLength(1);
    expect(String(entriesAfterRecovery[0]!.key)).toContain("recovery-head-");
    expect(entriesAfterRecovery[0]!.value).toMatchObject({
      documentId: initial.id,
      revision: 2,
      document: {
        name: "Latest head",
        artboards: [{ width: -1 }],
      },
    });
    expect(repeated).toEqual(recovered);
    expect(entriesAfterRepeat).toEqual(entriesAfterRecovery);
  });

  it("preserves an unrecoverable corrupt head and opens a fresh fallback", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("unrecoverable-head", "Unrecoverable");
    const fallback = makeDocument("safe-fallback", "Safe fallback");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(initial));
    await corruptHeadWidth(databaseName, initial.id);

    const recovered = await Effect.runPromise(repository.bootstrap(fallback));
    const loaded = await Effect.runPromise(repository.loadDocument(fallback.id));
    const entries = await readLegacyEntries(databaseName);

    expect(recovered).toMatchObject({
      activeDocumentId: fallback.id,
      documents: [
        {
          documentId: fallback.id,
          name: fallback.name,
          revision: 1,
        },
      ],
      migration: { status: "blocked" },
    });
    expect(loaded).toMatchObject({ revision: 1, document: fallback });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.value).toMatchObject({
      documentId: initial.id,
      document: { artboards: [{ width: -1 }] },
    });
  });

  it("quarantines a corrupt version without blocking a valid document head", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("valid-head", "Valid head");
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap(initial));
    await Effect.runPromise(
      repository.createVersion({
        documentId: initial.id,
        kind: "named",
        label: "Corrupt version",
      }),
    );
    await corruptFirstVersionWidth(databaseName);

    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    const loaded = await Effect.runPromise(repository.loadDocument(initial.id));
    const entriesAfterRecovery = await readLegacyEntries(databaseName);
    const repeated = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    const entriesAfterRepeat = await readLegacyEntries(databaseName);

    expect(versions).toEqual([]);
    expect(loaded).toMatchObject({ revision: 1, document: initial });
    expect(entriesAfterRecovery).toHaveLength(1);
    expect(String(entriesAfterRecovery[0]!.key)).toContain("recovery-version-");
    expect(entriesAfterRecovery[0]!.value).toMatchObject({
      documentId: initial.id,
      document: { artboards: [{ width: -1 }] },
    });
    expect(repeated).toEqual([]);
    expect(entriesAfterRepeat).toEqual(entriesAfterRecovery);
  });
});
