import {
  createInitialDocument,
  type DocumentChangeKind,
  type LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentLibraryController,
  DocumentTransitionBlockedError,
} from "./document-library";
import {
  DocumentRepositoryError,
  type CommitDocumentRequest,
  type CommitDocumentResult,
  type DocumentRepositoryFailure,
} from "./document-repository";
import {
  DocumentSession,
  type DocumentSessionStore,
} from "./document-session";
import { MemoryDocumentRepository } from "./memory-document-repository";

function makeDocument(id: string, name: string): LogoDocument {
  return { ...createInitialDocument(), id, name };
}

class FakeDocumentStore implements DocumentSessionStore {
  document: LogoDocument;
  private readonly listeners = new Set<
    (document: LogoDocument, kind: DocumentChangeKind) => void
  >();

  constructor(initial: LogoDocument) {
    this.document = initial;
  }

  reset(document: LogoDocument): void {
    this.emit(document, "committed");
  }

  subscribe(
    listener: (document: LogoDocument, kind: DocumentChangeKind) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(document: LogoDocument): void {
    this.emit(document, "committed");
  }

  private emit(document: LogoDocument, kind: DocumentChangeKind): void {
    this.document = document;
    for (const listener of this.listeners) {
      listener(document, kind);
    }
  }
}

class FailingCommitRepository extends MemoryDocumentRepository {
  failCommits = false;

  override commitDocument(
    request: CommitDocumentRequest,
  ): Effect.Effect<
    CommitDocumentResult,
    DocumentRepositoryFailure
  > {
    if (this.failCommits) {
      return Effect.fail(
        new DocumentRepositoryError({
          operation: "write",
          cause: new Error(`blocked ${request.documentId}`),
        }),
      );
    }
    return super.commitDocument(request);
  }
}

function deterministicRepository(): MemoryDocumentRepository {
  let timestamp = 1_000;
  let id = 0;
  return new MemoryDocumentRepository({
    now: () => timestamp++,
    createId: (prefix) => `${prefix}-${++id}`,
    automaticVersionLimit: 20,
  });
}

async function setup(
  initial = makeDocument("doc-initial", "Initial"),
  repository: MemoryDocumentRepository = deterministicRepository(),
  controllerOptions: ConstructorParameters<typeof DocumentLibraryController>[1] = {
    thumbnailRenderer: async () => "data:image/png;base64,dGVzdA==",
    thumbnailDelayMs: 0,
  },
) {
  const store = new FakeDocumentStore(initial);
  const controller = new DocumentLibraryController(
    repository,
    controllerOptions,
  );
  // Mirror production: the dashboard bootstraps an (empty) library, the user
  // creates the first document, and only then does a session adopt it.
  await controller.bootstrapLibrary();
  await controller.createDocument(initial);
  const session = new DocumentSession({
    store,
    load: async () => store.document,
    save: (document) => controller.saveDocument(document),
    delayMs: 10_000,
    lifecycleTarget: null,
  });
  controller.attachSession(session);
  await session.start();
  return { controller, initial, repository, session, store };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DocumentLibraryController", () => {
  it("bootstraps dashboard metadata without loading a document head", async () => {
    const initial = makeDocument("doc-dashboard-boot", "Dashboard boot");
    const repository = deterministicRepository();
    const loadDocument = vi.spyOn(repository, "loadDocument");
    const listVersions = vi.spyOn(repository, "listVersions");
    const controller = new DocumentLibraryController(repository, {
      thumbnailRenderer: async () => "data:image/png;base64,dGVzdA==",
      thumbnailDelayMs: 0,
    });

    await controller.bootstrapLibrary();

    expect(controller.snapshot).toMatchObject({
      ready: true,
      activeDocumentId: null,
      documents: [],
      folders: [],
      versions: [],
      notice: null,
    });
    expect(loadDocument).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();

    await controller.createDocument(initial);
    expect(controller.snapshot).toMatchObject({
      activeDocumentId: initial.id,
      documents: [{ documentId: initial.id, name: initial.name }],
    });
    expect(loadDocument).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();

    const opened = await controller.openDocument(initial.id);
    expect(opened).toEqual(initial);
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledTimes(1);
  });

  it("supports dashboard document operations without an attached session", async () => {
    const initial = makeDocument("doc-dashboard-initial", "Initial");
    const repository = deterministicRepository();
    const controller = new DocumentLibraryController(repository, {
      thumbnailRenderer: async () => "data:image/png;base64,dGVzdA==",
      thumbnailDelayMs: 0,
    });
    await controller.bootstrapLibrary();
    await controller.createDocument(initial);

    const created = await controller.createDocument(
      makeDocument("doc-dashboard-created", "Created"),
    );
    const renamed = await controller.renameDocument(created.id, "Renamed");
    const duplicate = await controller.duplicateDocument(initial.id);
    const archived = await controller.archiveDocument(created.id);

    expect(renamed).toMatchObject({
      documentId: created.id,
      name: "Renamed",
      revision: 2,
    });
    expect(duplicate).toMatchObject({ name: "Initial copy" });
    expect(archived.archivedSummary).toMatchObject({
      documentId: created.id,
      archivedAt: expect.any(Number),
    });
    expect(controller.snapshot.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: initial.id }),
        expect.objectContaining({ documentId: duplicate.id }),
        expect.objectContaining({
          documentId: created.id,
          name: "Renamed",
          archivedAt: expect.any(Number),
        }),
      ]),
    );
  });

  it("backfills missing thumbnails without changing revisions or UI operation state", async () => {
    const initial = makeDocument("doc-backfill", "Legacy thumbnail");
    const repository = deterministicRepository();
    const thumbnailRenderer = vi.fn(
      async () => "data:image/png;base64,YmFja2ZpbGw=",
    );
    const controller = new DocumentLibraryController(repository, {
      thumbnailRenderer,
    });
    await controller.bootstrapLibrary();
    await controller.createDocument(initial);

    await controller.backfillThumbnail(initial.id);

    expect(thumbnailRenderer).toHaveBeenCalledOnce();
    expect(controller.snapshot.operation).toBeNull();
    expect(controller.snapshot.documents[0]).toMatchObject({
      revision: 1,
      thumbnail: "data:image/png;base64,YmFja2ZpbGw=",
    });
    const head = await Effect.runPromise(repository.loadDocument(initial.id));
    expect(head.revision).toBe(1);
  });

  it("silently leaves the placeholder when thumbnail backfill fails", async () => {
    const initial = makeDocument("doc-backfill-failure", "Legacy thumbnail");
    const repository = deterministicRepository();
    const controller = new DocumentLibraryController(repository, {
      thumbnailRenderer: async () => {
        throw new Error("thumbnail unavailable");
      },
    });
    await controller.bootstrapLibrary();
    await controller.createDocument(initial);

    await expect(controller.backfillThumbnail(initial.id)).resolves.toBeUndefined();

    expect(controller.snapshot).toMatchObject({
      operation: null,
      error: null,
      documents: [{ thumbnail: null }],
    });
  });

  it("autosaves with optimistic revisions and a bounded recovery checkpoint", async () => {
    const { controller, repository, session, store, initial } = await setup();
    const edited = { ...initial, name: "Edited" };

    store.commit(edited);
    await session.flush();

    const head = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );
    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    expect(head).toMatchObject({ revision: 2, document: { name: "Edited" } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      kind: "automatic",
      sourceRevision: 1,
      document: { name: "Initial" },
    });
    expect(controller.snapshot.documents[0]).toMatchObject({
      name: "Edited",
      revision: 2,
    });
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("throttles full-document automatic checkpoints across rapid autosaves", async () => {
    const { repository, session, store, initial } = await setup();

    store.commit({ ...initial, name: "Edit one" });
    await session.flush();
    store.commit({ ...initial, name: "Edit two" });
    await session.flush();

    const head = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );
    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    expect(head).toMatchObject({ revision: 3, document: { name: "Edit two" } });
    expect(versions.filter((version) => version.kind === "automatic")).toHaveLength(
      1,
    );

    session.dispose();
  });

  it("debounces thumbnails after committed saves without advancing revisions", async () => {
    vi.useFakeTimers();
    const thumbnailRenderer = vi.fn(async (document: LogoDocument) =>
      `data:image/png;base64,${btoa(document.name)}`,
    );
    const { controller, repository, session, store, initial } = await setup(
      makeDocument("doc-thumbnail", "Initial"),
      deterministicRepository(),
      { thumbnailRenderer, thumbnailDelayMs: 2_000 },
    );

    store.commit({ ...initial, name: "First edit" });
    await session.flush();
    store.commit({ ...initial, name: "Latest edit" });
    await session.flush();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(thumbnailRenderer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const documents = await Effect.runPromise(repository.listDocuments());
    expect(thumbnailRenderer).toHaveBeenCalledTimes(1);
    expect(thumbnailRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Latest edit" }),
    );
    expect(documents[0]).toMatchObject({
      revision: 3,
      thumbnail: `data:image/png;base64,${btoa("Latest edit")}`,
    });
    expect(controller.snapshot.documents[0]?.thumbnail).toBe(
      documents[0]?.thumbnail,
    );
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("never fails a committed save when thumbnail generation fails", async () => {
    vi.useFakeTimers();
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { repository, session, store, initial } = await setup(
      makeDocument("doc-thumbnail-failure", "Initial"),
      deterministicRepository(),
      {
        thumbnailRenderer: async () => {
          throw new Error("thumbnail unavailable");
        },
        thumbnailDelayMs: 2_000,
      },
    );

    store.commit({ ...initial, name: "Saved anyway" });
    await session.flush();
    await vi.advanceTimersByTimeAsync(2_000);

    const head = await Effect.runPromise(repository.loadDocument(initial.id));
    const documents = await Effect.runPromise(repository.listDocuments());
    expect(head).toMatchObject({
      revision: 2,
      document: { name: "Saved anyway" },
    });
    expect(documents[0]).toMatchObject({ revision: 2, thumbnail: null });
    expect(session.state).toBe("saved");
    expect(warning).toHaveBeenCalledWith(
      "Could not update the document thumbnail.",
      expect.any(Error),
    );

    session.dispose();
  });

  it("keeps controller folder state aligned with repository metadata", async () => {
    const { controller, repository, session, initial } = await setup();

    const folder = await controller.createFolder("Client");
    await controller.moveDocument(initial.id, folder.folderId);
    await controller.renameFolder(folder.folderId, "Approved");

    expect(controller.snapshot.folders).toEqual([
      expect.objectContaining({ folderId: folder.folderId, name: "Approved" }),
    ]);
    expect(controller.snapshot.documents[0]?.folderId).toBe(folder.folderId);

    await controller.deleteFolder(folder.folderId);
    const bootstrap = await Effect.runPromise(repository.bootstrap());
    expect(controller.snapshot.folders).toEqual([]);
    expect(controller.snapshot.documents[0]?.folderId).toBeNull();
    expect(bootstrap.folders).toEqual([]);
    expect(bootstrap.documents[0]?.folderId).toBeNull();

    session.dispose();
  });

  it("flushes before create, duplicate, and switch, then adopts without extra writes", async () => {
    const { controller, repository, session, store, initial } = await setup();
    store.commit({ ...initial, name: "First edited" });

    const second = makeDocument("doc-second", "Second");
    await controller.createDocument(second);
    expect(store.document).toEqual(second);

    const firstHead = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );
    expect(firstHead).toMatchObject({
      revision: 2,
      document: { name: "First edited" },
    });

    const reopened = await controller.switchDocument(initial.id);
    expect(reopened.name).toBe("First edited");
    expect(store.document).toEqual(reopened);

    const duplicate = await controller.duplicateActiveDocument(store.document);
    expect(duplicate.id).not.toBe(initial.id);
    expect(duplicate.name).toBe("First edited copy");
    expect(controller.snapshot.documents).toHaveLength(3);
    expect(store.document).toEqual(duplicate);

    const duplicateHead = await Effect.runPromise(
      repository.loadDocument(duplicate.id),
    );
    expect(duplicateHead.revision).toBe(1);

    session.dispose();
  });

  it("aborts a document switch when the current head cannot be flushed", async () => {
    const repository = new FailingCommitRepository();
    const { controller, session, store, initial } = await setup(
      makeDocument("doc-first", "First"),
      repository,
    );
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(
      repository.createDocument({ document: second, makeActive: false }),
    );
    repository.failCommits = true;
    const edited = { ...initial, name: "Unsaved edit" };
    store.commit(edited);

    await expect(controller.switchDocument(second.id)).rejects.toBeInstanceOf(
      DocumentTransitionBlockedError,
    );

    expect(controller.snapshot.activeDocumentId).toBe(initial.id);
    expect(store.document).toEqual(edited);
    expect(session.state).toBe("error");
    const bootstrap = await Effect.runPromise(
      repository.bootstrap(),
    );
    expect(bootstrap.activeDocumentId).toBe(initial.id);

    session.dispose();
  });

  it("flushes before archiving the active document and adopts the atomic next head", async () => {
    const { controller, repository, session, store, initial } = await setup();
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(
      repository.createDocument({ document: second, makeActive: false }),
    );
    store.commit({ ...initial, name: "Saved before archive" });

    const result = await controller.archiveDocument(initial.id);
    const firstHead = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );

    expect(result).toMatchObject({
      archivedSummary: {
        documentId: initial.id,
        name: "Saved before archive",
        revision: 2,
        archivedAt: expect.any(Number),
      },
      activeDocument: { id: second.id, name: second.name },
    });
    expect(firstHead).toMatchObject({
      revision: 2,
      document: { name: "Saved before archive" },
    });
    expect(store.document).toEqual(second);
    expect(controller.snapshot.activeDocumentId).toBe(second.id);
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("aborts active archive when the current head cannot be flushed", async () => {
    const repository = new FailingCommitRepository();
    const { controller, session, store, initial } = await setup(
      makeDocument("doc-first", "First"),
      repository,
    );
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(
      repository.createDocument({ document: second, makeActive: false }),
    );
    repository.failCommits = true;
    const edited = { ...initial, name: "Unsaved archive attempt" };
    store.commit(edited);

    await expect(controller.archiveDocument(initial.id)).rejects.toBeInstanceOf(
      DocumentTransitionBlockedError,
    );

    const documents = await Effect.runPromise(repository.listDocuments());
    expect(
      documents.find((document) => document.documentId === initial.id)
        ?.archivedAt,
    ).toBeNull();
    expect(controller.snapshot.activeDocumentId).toBe(initial.id);
    expect(store.document).toEqual(edited);
    expect(session.state).toBe("error");

    session.dispose();
  });

  it("archives and restores an inactive document without switching or flushing", async () => {
    const repository = new FailingCommitRepository();
    const { controller, session, store, initial } = await setup(
      makeDocument("doc-first", "First"),
      repository,
    );
    const second = makeDocument("doc-second", "Second");
    await Effect.runPromise(
      repository.createDocument({ document: second, makeActive: false }),
    );
    repository.failCommits = true;
    const pending = { ...initial, name: "Still editing" };
    store.commit(pending);

    const archived = await controller.archiveDocument(second.id);
    expect(archived.activeDocument).toBeNull();
    expect(controller.snapshot.activeDocumentId).toBe(initial.id);
    expect(store.document).toEqual(pending);
    expect(
      controller.snapshot.documents.find(
        (document) => document.documentId === second.id,
      )?.archivedAt,
    ).toEqual(expect.any(Number));

    const restored = await controller.restoreArchivedDocument(second.id);
    expect(restored.archivedAt).toBeNull();
    expect(controller.snapshot.activeDocumentId).toBe(initial.id);
    expect(store.document).toEqual(pending);

    session.dispose();
  });

  it("preserves an autosave when another tab archives the active head", async () => {
    const { controller, repository, session, store, initial } = await setup();
    const available = makeDocument("doc-available", "Available");
    await Effect.runPromise(
      repository.createDocument({ document: available, makeActive: false }),
    );

    // Simulate another tab archiving the head while this session still edits it.
    await Effect.runPromise(repository.archiveDocument(initial.id));
    const localEdit = { ...initial, name: "Unsaved work from this tab" };
    store.commit(localEdit);
    await session.flush();

    const head = await Effect.runPromise(repository.loadDocument(initial.id));
    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    expect(session.state).toBe("error");
    expect(store.document).toEqual(localEdit);
    expect(head).toMatchObject({
      revision: 1,
      document: { name: initial.name },
    });
    expect(versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conflict",
          label: "Archived edit recovery",
          sourceRevision: 1,
          document: expect.objectContaining({ name: localEdit.name }),
        }),
      ]),
    );
    expect(controller.snapshot.error).toContain("preserved in Version history");

    session.dispose();
  });

  it("creates named versions and restores only after protecting the current head", async () => {
    const { controller, repository, session, store, initial } = await setup();
    const milestoneDocument = { ...initial, name: "Milestone state" };
    store.commit(milestoneDocument);
    await session.flush();
    const milestone = await controller.createNamedVersion("Client approved");

    const laterDocument = { ...initial, name: "Later state" };
    store.commit(laterDocument);
    await session.flush();
    const restored = await controller.restoreVersion(milestone.versionId);

    expect(restored.name).toBe("Milestone state");
    expect(store.document.name).toBe("Milestone state");
    const head = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );
    expect(head).toMatchObject({
      revision: 4,
      document: { name: "Milestone state" },
    });
    const versions = await Effect.runPromise(
      repository.listVersions(initial.id),
    );
    expect(versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "named",
          label: "Client approved",
          document: expect.objectContaining({ name: "Milestone state" }),
        }),
        expect.objectContaining({
          kind: "automatic",
          sourceRevision: 3,
          document: expect.objectContaining({ name: "Later state" }),
        }),
      ]),
    );

    session.dispose();
  });

  it("keeps a concurrent local edit in conflict history without replacing the head", async () => {
    const { controller, repository, session, store, initial } = await setup();
    await Effect.runPromise(
      repository.commitDocument({
        documentId: initial.id,
        expectedRevision: 1,
        document: { ...initial, name: "Other tab" },
      }),
    );
    store.commit({ ...initial, name: "This tab" });

    await session.flush();

    expect(session.state).toBe("saved");
    expect(store.document.name).toBe("Other tab");
    const head = await Effect.runPromise(
      repository.loadDocument(initial.id),
    );
    expect(head.document.name).toBe("Other tab");
    expect(controller.snapshot.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conflict",
          document: expect.objectContaining({ name: "This tab" }),
        }),
      ]),
    );

    session.dispose();
  });
});
