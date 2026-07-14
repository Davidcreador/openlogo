import { Effect } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createInitialDocument, type LogoDocument } from "@openlogo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRepository } from "./document-repository";
import { IndexedDbDocumentRepository } from "./indexeddb-document-repository";
import { MemoryDocumentRepository } from "./memory-document-repository";

type RepositoryFixture = {
  repository: DocumentRepository;
  cleanup: () => Promise<void>;
};

let databaseSequence = 0;

function makeDocument(id: string, name: string): LogoDocument {
  return { ...createInitialDocument(), id, name };
}

function deterministicOptions() {
  let timestamp = 1_000;
  let id = 0;
  return {
    now: () => timestamp++,
    createId: (prefix: string) => `${prefix}-${++id}`,
    automaticVersionLimit: 2,
  };
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database deletion blocked."));
  });
}

const adapters: Array<{
  name: string;
  create: () => RepositoryFixture;
}> = [
  {
    name: "memory",
    create: () => ({
      repository: new MemoryDocumentRepository(deterministicOptions()),
      cleanup: async () => undefined,
    }),
  },
  {
    name: "IndexedDB",
    create: () => {
      const databaseName = `openlogo-contract-${++databaseSequence}`;
      return {
        repository: new IndexedDbDocumentRepository({
          ...deterministicOptions(),
          databaseName,
          indexedDB,
          keyRange: IDBKeyRange,
        }),
        cleanup: () => deleteDatabase(databaseName),
      };
    },
  },
];

describe.each(adapters)("DocumentRepository contract: $name", ({ create }) => {
  let fixture: RepositoryFixture;

  beforeEach(() => {
    fixture = create();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("bootstraps exactly once and returns detached snapshots", async () => {
    const initial = makeDocument("doc-initial", "Initial");

    const first = await Effect.runPromise(
      fixture.repository.bootstrap(initial),
    );
    first.documents[0]!.name = "Mutated outside repository";
    const second = await Effect.runPromise(
      fixture.repository.bootstrap(makeDocument("doc-other", "Other")),
    );

    expect(first.activeDocumentId).toBe(initial.id);
    expect(second.activeDocumentId).toBe(initial.id);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]).toMatchObject({
      documentId: initial.id,
      name: "Initial",
      revision: 1,
      thumbnail: null,
      folderId: null,
    });
    expect(second.folders).toEqual([]);
  });

  it("manages folders and derived thumbnails without advancing head revisions", async () => {
    const initial = makeDocument("doc-dashboard", "Dashboard document");
    await Effect.runPromise(fixture.repository.bootstrap(initial));

    const folder = await Effect.runPromise(
      fixture.repository.createFolder("  Client work  "),
    );
    const moved = await Effect.runPromise(
      fixture.repository.moveDocument(initial.id, folder.folderId),
    );
    const thumbnail = "data:image/png;base64,iVBORw0KGgo=";
    const thumbnailed = await Effect.runPromise(
      fixture.repository.setThumbnail(initial.id, thumbnail),
    );
    const committed = await Effect.runPromise(
      fixture.repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 1,
        document: { ...initial, name: "Saved after metadata" },
      }),
    );
    const renamed = await Effect.runPromise(
      fixture.repository.renameFolder(folder.folderId, "Approved"),
    );
    const bootstrap = await Effect.runPromise(
      fixture.repository.bootstrap(makeDocument("ignored", "Ignored")),
    );

    expect(folder).toMatchObject({
      folderId: expect.any(String),
      name: "Client work",
      createdAt: expect.any(Number),
    });
    expect(moved).toMatchObject({ revision: 1, folderId: folder.folderId });
    expect(thumbnailed).toMatchObject({ revision: 1, thumbnail });
    expect(committed).toMatchObject({
      revision: 2,
      summary: {
        name: "Saved after metadata",
        thumbnail,
        folderId: folder.folderId,
      },
    });
    expect(renamed).toMatchObject({
      folderId: folder.folderId,
      name: "Approved",
      createdAt: folder.createdAt,
    });
    expect(bootstrap.folders).toEqual([renamed]);
    expect(bootstrap.documents[0]).toMatchObject({
      revision: 2,
      thumbnail,
      folderId: folder.folderId,
    });

    await Effect.runPromise(fixture.repository.deleteFolder(folder.folderId));
    const afterDelete = await Effect.runPromise(
      fixture.repository.bootstrap(initial),
    );
    expect(afterDelete.folders).toEqual([]);
    expect(afterDelete.documents[0]?.folderId).toBeNull();
    expect(afterDelete.documents[0]?.thumbnail).toBe(thumbnail);
  });

  it("rejects moves to missing folders without changing document metadata", async () => {
    const initial = makeDocument("doc-missing-folder", "No folder");
    await Effect.runPromise(fixture.repository.bootstrap(initial));

    const outcome = await Effect.runPromise(
      Effect.either(
        fixture.repository.moveDocument(initial.id, "folder-missing"),
      ),
    );
    const documents = await Effect.runPromise(
      fixture.repository.listDocuments(),
    );

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { _tag: "FolderNotFoundError", folderId: "folder-missing" },
    });
    expect(documents[0]?.folderId).toBeNull();
  });

  it("creates, lists, loads, and activates independent documents", async () => {
    const first = makeDocument("doc-first", "First");
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(fixture.repository.bootstrap(first));

    await Effect.runPromise(
      fixture.repository.createDocument({ document: second }),
    );
    await Effect.runPromise(fixture.repository.setActiveDocument(second.id));
    const loaded = await Effect.runPromise(
      fixture.repository.loadDocument(second.id),
    );
    loaded.document.name = "Mutated outside repository";

    const documents = await Effect.runPromise(
      fixture.repository.listDocuments(),
    );
    const bootstrapped = await Effect.runPromise(
      fixture.repository.bootstrap(first),
    );
    const reloaded = await Effect.runPromise(
      fixture.repository.loadDocument(second.id),
    );

    expect(documents.map((document) => document.documentId).sort()).toEqual([
      first.id,
      second.id,
    ]);
    expect(bootstrapped.activeDocumentId).toBe(second.id);
    expect(reloaded).toMatchObject({ revision: 1 });
    expect(reloaded.document.name).toBe("Second");
    expect(documents.every((document) => document.archivedAt === null)).toBe(
      true,
    );
  });

  it("archives the active head atomically and selects the deterministic next document", async () => {
    const first = makeDocument("doc-first", "First");
    const second = makeDocument("doc-second", "Second");
    const third = makeDocument("doc-third", "Third");
    await Effect.runPromise(fixture.repository.bootstrap(first));
    await Effect.runPromise(
      fixture.repository.createDocument({ document: second }),
    );
    await Effect.runPromise(
      fixture.repository.createDocument({ document: third }),
    );

    const result = await Effect.runPromise(
      fixture.repository.archiveDocument(first.id),
    );
    const bootstrapped = await Effect.runPromise(
      fixture.repository.bootstrap(makeDocument("ignored", "Ignored")),
    );

    expect(result).toMatchObject({
      archivedSummary: {
        documentId: first.id,
        archivedAt: expect.any(Number),
      },
      activeDocumentId: third.id,
      activeDocument: {
        revision: 1,
        document: { id: third.id, name: "Third" },
      },
    });
    expect(result.documents).toHaveLength(3);
    expect(bootstrapped.activeDocumentId).toBe(third.id);
    result.activeDocument.document.name = "Mutated outside repository";
    const reloaded = await Effect.runPromise(
      fixture.repository.loadDocument(third.id),
    );
    expect(reloaded.document.name).toBe("Third");
  });

  it("keeps archived heads recoverable but read-only until restored", async () => {
    const first = makeDocument("doc-first", "First");
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(fixture.repository.bootstrap(first));
    await Effect.runPromise(
      fixture.repository.createDocument({ document: second }),
    );
    await Effect.runPromise(fixture.repository.archiveDocument(second.id));

    const activate = await Effect.runPromise(
      Effect.either(fixture.repository.setActiveDocument(second.id)),
    );
    const commit = await Effect.runPromise(
      Effect.either(
        fixture.repository.commitDocument({
          documentId: second.id,
          expectedRevision: 1,
          document: { ...second, name: "Forbidden edit" },
        }),
      ),
    );
    const archivedHead = await Effect.runPromise(
      fixture.repository.loadDocument(second.id),
    );
    const versions = await Effect.runPromise(
      fixture.repository.listVersions(second.id),
    );
    expect(activate).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentArchivedError",
        operation: "activate",
      },
    });
    expect(commit).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentArchivedError",
        operation: "commit",
        recoveryVersionId: expect.any(String),
      },
    });
    expect(archivedHead).toMatchObject({
      revision: 1,
      document: { name: "Second" },
    });
    expect(versions).toEqual([
      expect.objectContaining({
        versionId:
          commit._tag === "Left" &&
          commit.left._tag === "DocumentArchivedError"
            ? commit.left.recoveryVersionId
            : "missing-recovery",
        documentId: second.id,
        kind: "conflict",
        label: "Archived edit recovery",
        sourceRevision: 1,
        document: expect.objectContaining({ name: "Forbidden edit" }),
      }),
    ]);

    const restored = await Effect.runPromise(
      fixture.repository.restoreArchivedDocument(second.id),
    );
    expect(restored.archivedAt).toBeNull();
    await Effect.runPromise(fixture.repository.setActiveDocument(second.id));
    const bootstrapped = await Effect.runPromise(
      fixture.repository.bootstrap(first),
    );
    expect(bootstrapped.activeDocumentId).toBe(second.id);
  });

  it("rejects archiving the final unarchived document without changing state", async () => {
    const only = makeDocument("doc-only", "Only document");
    await Effect.runPromise(fixture.repository.bootstrap(only));

    const outcome = await Effect.runPromise(
      Effect.either(fixture.repository.archiveDocument(only.id)),
    );
    const documents = await Effect.runPromise(
      fixture.repository.listDocuments(),
    );
    const bootstrapped = await Effect.runPromise(
      fixture.repository.bootstrap(only),
    );

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { _tag: "LastUnarchivedDocumentError", documentId: only.id },
    });
    expect(documents).toEqual([
      expect.objectContaining({ documentId: only.id, archivedAt: null }),
    ]);
    expect(bootstrapped.activeDocumentId).toBe(only.id);
  });

  it("serializes competing archives so exactly one unarchived head survives", async () => {
    const first = makeDocument("doc-first", "First");
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(fixture.repository.bootstrap(first));
    await Effect.runPromise(
      fixture.repository.createDocument({ document: second }),
    );

    const outcomes = await Promise.all([
      Effect.runPromise(
        Effect.either(fixture.repository.archiveDocument(first.id)),
      ),
      Effect.runPromise(
        Effect.either(fixture.repository.archiveDocument(second.id)),
      ),
    ]);
    const documents = await Effect.runPromise(
      fixture.repository.listDocuments(),
    );
    const bootstrapped = await Effect.runPromise(
      fixture.repository.bootstrap(first),
    );
    const unarchived = documents.filter(
      (document) => document.archivedAt === null,
    );

    expect(outcomes.filter((outcome) => outcome._tag === "Right")).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome._tag === "Left")).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({
          _tag: "LastUnarchivedDocumentError",
        }),
      }),
    ]);
    expect(unarchived).toHaveLength(1);
    expect(bootstrapped.activeDocumentId).toBe(unarchived[0]!.documentId);
  });

  it("increments revisions and preserves stale writes as conflict versions", async () => {
    const initial = makeDocument("doc-conflict", "Initial");
    await Effect.runPromise(fixture.repository.bootstrap(initial));

    const committed = await Effect.runPromise(
      fixture.repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 1,
        document: { ...initial, name: "Committed" },
      }),
    );
    const staleWrite = fixture.repository.commitDocument({
      documentId: initial.id,
      expectedRevision: 1,
      document: { ...initial, name: "Recovered stale edit" },
    });

    const conflict = await Effect.runPromise(Effect.either(staleWrite));
    expect(conflict).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentRevisionConflict",
        documentId: initial.id,
        expectedRevision: 1,
        actualRevision: 2,
        recoveryVersionId: expect.any(String),
      },
    });

    const authoritative = await Effect.runPromise(
      fixture.repository.loadDocument(initial.id),
    );
    const versions = await Effect.runPromise(
      fixture.repository.listVersions(initial.id),
    );

    expect(committed.revision).toBe(2);
    expect(authoritative.revision).toBe(2);
    expect(authoritative.document.name).toBe("Committed");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      kind: "conflict",
      sourceRevision: 1,
      document: { name: "Recovered stale edit" },
    });
  });

  it("bounds automatic versions without pruning named or conflict recovery", async () => {
    const initial = makeDocument("doc-retention", "Retention");
    await Effect.runPromise(fixture.repository.bootstrap(initial));
    await Effect.runPromise(
      fixture.repository.createVersion({
        documentId: initial.id,
        kind: "named",
        label: "Milestone",
      }),
    );

    for (let index = 0; index < 3; index += 1) {
      await Effect.runPromise(
        fixture.repository.createVersion({
          documentId: initial.id,
          kind: "automatic",
        }),
      );
    }

    const conflict = await Effect.runPromise(
      Effect.either(
        fixture.repository.commitDocument({
          documentId: initial.id,
          expectedRevision: 0,
          document: { ...initial, name: "Conflict" },
        }),
      ),
    );
    expect(conflict).toMatchObject({
      _tag: "Left",
      left: { _tag: "DocumentRevisionConflict" },
    });

    const versions = await Effect.runPromise(
      fixture.repository.listVersions(initial.id),
    );
    expect(versions.filter((version) => version.kind === "automatic")).toHaveLength(
      2,
    );
    expect(versions.filter((version) => version.kind === "named")).toHaveLength(
      1,
    );
    expect(versions.filter((version) => version.kind === "conflict")).toHaveLength(
      1,
    );
    expect(versions.find((version) => version.kind === "named")?.label).toBe(
      "Milestone",
    );
  });

  it("rejects invalid snapshots without replacing the authoritative head", async () => {
    const initial = makeDocument("doc-invalid-write", "Valid head");
    await Effect.runPromise(fixture.repository.bootstrap(initial));
    const invalid = structuredClone(initial);
    invalid.name = "Invalid replacement";
    invalid.artboards[0]!.width = -1;
    const invalidNewDocument = structuredClone(invalid);
    invalidNewDocument.id = "doc-invalid-create";

    const commitOutcome = await Effect.runPromise(
      Effect.either(
        fixture.repository.commitDocument({
          documentId: initial.id,
          expectedRevision: 1,
          document: invalid,
        }),
      ),
    );
    const createOutcome = await Effect.runPromise(
      Effect.either(
        fixture.repository.createDocument({ document: invalidNewDocument }),
      ),
    );
    const authoritative = await Effect.runPromise(
      fixture.repository.loadDocument(initial.id),
    );
    const documents = await Effect.runPromise(
      fixture.repository.listDocuments(),
    );

    expect(commitOutcome).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentRepositoryError",
        operation: "decode",
      },
    });
    expect(createOutcome).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DocumentRepositoryError",
        operation: "decode",
      },
    });
    expect(authoritative).toMatchObject({
      revision: 1,
      document: {
        name: initial.name,
        artboards: [{ width: initial.artboards[0]!.width }],
      },
    });
    expect(documents.map((document) => document.documentId)).toEqual([
      initial.id,
    ]);
  });

  it("returns detached versions that can be restored as a new head revision", async () => {
    const initial = makeDocument("doc-version-restore", "Initial");
    await Effect.runPromise(fixture.repository.bootstrap(initial));
    await Effect.runPromise(
      fixture.repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 1,
        document: { ...initial, name: "Named state" },
      }),
    );
    const createdVersion = await Effect.runPromise(
      fixture.repository.createVersion({
        documentId: initial.id,
        kind: "named",
        label: "Client review",
      }),
    );
    createdVersion.document.name = "Mutated outside repository";
    await Effect.runPromise(
      fixture.repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 2,
        document: { ...initial, name: "Later state" },
      }),
    );

    const versions = await Effect.runPromise(
      fixture.repository.listVersions(initial.id),
    );
    const restored = await Effect.runPromise(
      fixture.repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 3,
        document: versions[0]!.document,
      }),
    );
    versions[0]!.document.name = "Also mutated outside repository";
    const reloaded = await Effect.runPromise(
      fixture.repository.loadDocument(initial.id),
    );
    const persistedVersions = await Effect.runPromise(
      fixture.repository.listVersions(initial.id),
    );

    expect(restored.revision).toBe(4);
    expect(reloaded).toMatchObject({
      revision: 4,
      document: { name: "Named state" },
    });
    expect(persistedVersions[0]).toMatchObject({
      label: "Client review",
      sourceRevision: 2,
      document: { name: "Named state" },
    });
  });
});
