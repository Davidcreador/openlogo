import { Effect } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createInitialDocument, type LogoDocument } from "@openlogo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_HEAD_STORE,
  DOCUMENT_SUMMARY_STORE,
  DOCUMENT_VERSION_STORE,
  FOLDER_STORE,
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

function seedDocument(
  repository: IndexedDbDocumentRepository,
  document: LogoDocument,
) {
  return Effect.runPromise(
    repository.createDocument({ document, makeActive: true }),
  );
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

async function seedV2Database(
  databaseName: string,
  document: LogoDocument,
): Promise<void> {
  const artboard = document.artboards[0]!;
  const database = await openDatabase(databaseName, 2, (upgrading) => {
    upgrading.createObjectStore(LEGACY_DOCUMENT_STORE);
    const heads = upgrading.createObjectStore(DOCUMENT_HEAD_STORE, {
      keyPath: "documentId",
    });
    const summaries = upgrading.createObjectStore(DOCUMENT_SUMMARY_STORE, {
      keyPath: "documentId",
    });
    const versions = upgrading.createObjectStore(DOCUMENT_VERSION_STORE, {
      keyPath: "versionId",
    });
    versions.createIndex("by-document-created", ["documentId", "createdAt"]);
    versions.createIndex("by-document-kind-created", [
      "documentId",
      "kind",
      "createdAt",
    ]);
    const workspace = upgrading.createObjectStore(WORKSPACE_STORE, {
      keyPath: "key",
    });
    heads.put({
      documentId: document.id,
      document,
      revision: 4,
      createdAt: 100,
      updatedAt: 400,
    });
    summaries.put({
      documentId: document.id,
      name: document.name,
      revision: 4,
      createdAt: 100,
      updatedAt: 400,
      lastOpenedAt: 450,
      archivedAt: null,
      activeArtboardName: artboard.name,
      activeArtboardWidth: artboard.width,
      activeArtboardHeight: artboard.height,
    });
    versions.put({
      versionId: "version-v2",
      documentId: document.id,
      kind: "named",
      label: "v2 milestone",
      createdAt: 300,
      sourceRevision: 3,
      document,
    });
    workspace.put({
      key: "state",
      activeDocumentId: document.id,
      legacyMigration: { status: "none" },
      migrationVersion: 1,
    });
  });
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

    const first = await Effect.runPromise(repository.bootstrap());
    const second = await Effect.runPromise(repository.bootstrap());
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

  it("blocks invalid legacy data, keeps the library empty, and preserves the bad value", async () => {
    const databaseName = nextDatabaseName();
    const invalidLegacy = { schemaVersion: 999, broken: true };
    await seedLegacyDatabase(databaseName, [["current", invalidLegacy]]);
    const repository = makeRepository(databaseName);

    const bootstrap = await Effect.runPromise(repository.bootstrap());
    const documents = await Effect.runPromise(repository.listDocuments());
    const repeated = await Effect.runPromise(repository.bootstrap());
    const entries = await readLegacyEntries(databaseName);

    expect(bootstrap).toMatchObject({
      activeDocumentId: null,
      documents: [],
      migration: { status: "blocked" },
    });
    expect(documents).toEqual([]);
    // The blocked notice is recomputed on every bootstrap; nothing is seeded.
    expect(repeated).toEqual(bootstrap);
    expect(entries).toEqual([{ key: "current", value: invalidLegacy }]);
  });

  it("leaves a fresh profile empty and completely unwritten", async () => {
    const databaseName = nextDatabaseName();
    const repository = makeRepository(databaseName);

    const bootstrap = await Effect.runPromise(repository.bootstrap());

    expect(bootstrap).toEqual({
      activeDocumentId: null,
      documents: [],
      folders: [],
      migration: { status: "none" },
    });
    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
      "readonly",
    );
    const counts = await Promise.all(
      [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE].map(
        (storeName) =>
          new Promise<number>((resolve, reject) => {
            const request = transaction.objectStore(storeName).count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    await transactionDone(transaction);
    database.close();
    expect(counts).toEqual([0, 0, 0]);
  });

  it("writes the workspace pointer with the first created document", async () => {
    const databaseName = nextDatabaseName();
    const repository = makeRepository(databaseName);
    const first = makeDocument("first-created", "First created");
    await Effect.runPromise(repository.bootstrap());

    await Effect.runPromise(
      repository.createDocument({ document: first, makeActive: false }),
    );
    const bootstrap = await Effect.runPromise(repository.bootstrap());

    expect(bootstrap).toMatchObject({
      activeDocumentId: first.id,
      documents: [{ documentId: first.id, revision: 1 }],
    });
  });

  it("serializes concurrent bootstrap attempts without duplicate imports", async () => {
    const databaseName = nextDatabaseName();
    const legacy = makeDocument("legacy-concurrent", "Concurrent legacy");
    await seedLegacyDatabase(databaseName, [["current", legacy]]);
    const firstRepository = makeRepository(databaseName);
    const secondRepository = makeRepository(databaseName);

    const [first, second] = await Promise.all([
      Effect.runPromise(firstRepository.bootstrap()),
      Effect.runPromise(secondRepository.bootstrap()),
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

  it("upgrades the database to v3 with all repository stores", async () => {
    const databaseName = nextDatabaseName();
    const repository = makeRepository(databaseName);
    await Effect.runPromise(repository.bootstrap());

    const database = await openDatabase(databaseName);
    expect(database.version).toBe(OPENLOGO_DATABASE_VERSION);
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining([
        LEGACY_DOCUMENT_STORE,
        DOCUMENT_HEAD_STORE,
        DOCUMENT_SUMMARY_STORE,
        DOCUMENT_VERSION_STORE,
        FOLDER_STORE,
        WORKSPACE_STORE,
      ]),
    );
    database.close();
  });

  it("migrates v2 summaries forward without rewriting heads or versions", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("v2-document", "Version two");
    await seedV2Database(databaseName, initial);
    const repository = makeRepository(databaseName);

    await Effect.runPromise(repository.listDocuments());

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, DOCUMENT_VERSION_STORE],
      "readonly",
    );
    const [head, summary, version] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        const request = transaction
          .objectStore(DOCUMENT_HEAD_STORE)
          .get(initial.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise<unknown>((resolve, reject) => {
        const request = transaction
          .objectStore(DOCUMENT_SUMMARY_STORE)
          .get(initial.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise<unknown>((resolve, reject) => {
        const request = transaction
          .objectStore(DOCUMENT_VERSION_STORE)
          .get("version-v2");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      transactionDone(transaction),
    ]);
    expect(database.version).toBe(3);
    expect([...database.objectStoreNames]).toContain(FOLDER_STORE);
    expect(summary).toMatchObject({ thumbnail: null, folderId: null });
    expect(head).toMatchObject({
      documentId: initial.id,
      revision: 4,
      document: initial,
    });
    expect(version).toMatchObject({
      versionId: "version-v2",
      sourceRevision: 3,
      document: initial,
    });
    database.close();

    const bootstrap = await Effect.runPromise(repository.bootstrap());
    expect(bootstrap).toMatchObject({
      activeDocumentId: initial.id,
      documents: [
        {
          documentId: initial.id,
          revision: 4,
          thumbnail: null,
          folderId: null,
        },
      ],
      folders: [],
    });
    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    expect(versions).toEqual([
      expect.objectContaining({ versionId: "version-v2", sourceRevision: 3 }),
    ]);
  });

  it("serializes concurrent dashboard metadata writes without dangling folders", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("dashboard-concurrent", "Initial");
    const first = makeRepository(databaseName);
    const second = makeRepository(databaseName);
    await seedDocument(first, initial);
    const folder = await Effect.runPromise(first.createFolder("Client"));
    const thumbnail = "data:image/png;base64,iVBORw0KGgo=";

    await Promise.all([
      Effect.runPromise(
        first.commitDocument({
          documentId: initial.id,
          expectedRevision: 1,
          document: { ...initial, name: "Committed" },
        }),
      ),
      Effect.runPromise(second.setThumbnail(initial.id, thumbnail)),
    ]);
    await Effect.runPromise(first.moveDocument(initial.id, folder.folderId));
    await Promise.all([
      Effect.runPromise(
        Effect.either(second.moveDocument(initial.id, folder.folderId)),
      ),
      Effect.runPromise(first.deleteFolder(folder.folderId)),
    ]);

    const bootstrap = await Effect.runPromise(second.bootstrap());
    expect(bootstrap.folders).toEqual([]);
    expect(bootstrap.documents[0]).toMatchObject({
      name: "Committed",
      revision: 2,
      thumbnail,
      folderId: null,
    });
  });

  it("normalizes summaries missing archive and dashboard metadata", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("legacy-summary", "Legacy summary");
    const repository = makeRepository(databaseName);
    const created = await seedDocument(repository, initial);

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      DOCUMENT_SUMMARY_STORE,
      "readwrite",
    );
    const legacySummary = {
      ...created.summary,
    } as Partial<typeof created.summary>;
    delete legacySummary.archivedAt;
    delete legacySummary.thumbnail;
    delete legacySummary.folderId;
    transaction.objectStore(DOCUMENT_SUMMARY_STORE).put(legacySummary);
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap());
    const documents = await Effect.runPromise(repository.listDocuments());
    expect(recovered.documents[0]?.archivedAt).toBeNull();
    expect(recovered.documents[0]?.thumbnail).toBeNull();
    expect(recovered.documents[0]?.folderId).toBeNull();
    expect(documents[0]?.archivedAt).toBeNull();
    expect(documents[0]?.thumbnail).toBeNull();
    expect(documents[0]?.folderId).toBeNull();
  });

  it("repairs a workspace pointer that targets an archived head", async () => {
    const databaseName = nextDatabaseName();
    const first = makeDocument("available-head", "Available");
    const archived = makeDocument("archived-head", "Archived");
    const repository = makeRepository(databaseName);
    await seedDocument(repository, first);
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

    const recovered = await Effect.runPromise(repository.bootstrap());
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
    await seedDocument(repository, available);
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
    const created = await seedDocument(repository, initial);

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(
      [DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
      "readwrite",
    );
    const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
    summaryStore.delete(initial.id);
    summaryStore.put({
      ...created.summary,
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

    const recovered = await Effect.runPromise(repository.bootstrap());
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
    const repository = makeRepository(databaseName);
    await seedDocument(repository, orphan);

    const database = await openDatabase(databaseName);
    const transaction = database.transaction(DOCUMENT_HEAD_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_HEAD_STORE).delete(orphan.id);
    await transactionDone(transaction);
    database.close();

    const recovered = await Effect.runPromise(repository.bootstrap());
    const documents = await Effect.runPromise(repository.listDocuments());

    expect(recovered).toMatchObject({
      activeDocumentId: null,
      documents: [],
      migration: { status: "none" },
    });
    expect(documents).toEqual([]);
  });

  it("quarantines a corrupt latest head and restores its newest valid version once", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("recoverable-head", "Known good version");
    const repository = makeRepository(databaseName);
    await seedDocument(repository, initial);
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

    const recovered = await Effect.runPromise(repository.bootstrap());
    const loaded = await Effect.runPromise(repository.loadDocument(initial.id));
    const entriesAfterRecovery = await readLegacyEntries(databaseName);
    const repeated = await Effect.runPromise(repository.bootstrap());
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

  it("preserves an unrecoverable corrupt head and reports the library empty", async () => {
    const databaseName = nextDatabaseName();
    const initial = makeDocument("unrecoverable-head", "Unrecoverable");
    const repository = makeRepository(databaseName);
    await seedDocument(repository, initial);
    await corruptHeadWidth(databaseName, initial.id);

    const recovered = await Effect.runPromise(repository.bootstrap());
    const documents = await Effect.runPromise(repository.listDocuments());
    const entries = await readLegacyEntries(databaseName);

    expect(recovered).toMatchObject({
      activeDocumentId: null,
      documents: [],
      migration: {
        status: "blocked",
        reason: expect.stringContaining("recovery-head-"),
      },
    });
    expect(documents).toEqual([]);
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
    await seedDocument(repository, initial);
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
