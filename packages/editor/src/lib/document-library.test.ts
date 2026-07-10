import {
  createInitialDocument,
  type DocumentChangeKind,
  type LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
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
) {
  const store = new FakeDocumentStore(initial);
  const controller = new DocumentLibraryController(repository);
  const session = new DocumentSession({
    store,
    load: () => controller.loadActiveDocument(initial),
    save: (document) => controller.saveDocument(document),
    delayMs: 10_000,
    lifecycleTarget: null,
  });
  controller.attachSession(session);
  await session.start();
  return { controller, initial, repository, session, store };
}

describe("DocumentLibraryController", () => {
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
      repository.bootstrap(makeDocument("ignored", "Ignored")),
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
