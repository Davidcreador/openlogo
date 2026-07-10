import { Effect } from "effect";
import { createId, type LogoDocument } from "@openlogo/core";
import {
  DEFAULT_AUTOMATIC_VERSION_LIMIT,
  DocumentArchivedError,
  DocumentAlreadyExistsError,
  DocumentIdMismatchError,
  DocumentNotFoundError,
  DocumentRepositoryError,
  DocumentRevisionConflict,
  LastUnarchivedDocumentError,
  type ArchiveDocumentResult,
  type CommitDocumentRequest,
  type CommitDocumentResult,
  type CreateDocumentRequest,
  type CreateVersionRequest,
  type DocumentRepository,
  type DocumentRepositoryBootstrap,
  type DocumentRepositoryFailure,
  type DocumentRepositoryOperation,
  type DocumentSummary,
  type DocumentVersion,
  cloneLogoDocument,
  decodeRepositoryDocument,
  documentSummary,
  isDocumentRepositoryFailure,
  normalizeDocumentSummary,
  sortDocumentSummaries,
  sortDocumentVersions,
} from "./document-repository";

type HeadRecord = {
  document: LogoDocument;
  revision: number;
};

export type MemoryDocumentRepositoryOptions = {
  now?: () => number;
  createId?: (prefix: string) => string;
  automaticVersionLimit?: number;
};

/** Deterministic non-persistent adapter for lifecycle and contract tests. */
export class MemoryDocumentRepository implements DocumentRepository {
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly automaticVersionLimit: number;
  private readonly heads = new Map<string, HeadRecord>();
  private readonly summaries = new Map<string, DocumentSummary>();
  private readonly versions = new Map<string, DocumentVersion>();
  private activeDocumentId: string | null = null;

  constructor(options: MemoryDocumentRepositoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.makeId = options.createId ?? createId;
    this.automaticVersionLimit = Math.max(
      1,
      Math.floor(
        options.automaticVersionLimit ?? DEFAULT_AUTOMATIC_VERSION_LIMIT,
      ),
    );
  }

  bootstrap(
    initialDocument: LogoDocument,
  ): Effect.Effect<DocumentRepositoryBootstrap, DocumentRepositoryFailure> {
    return this.attempt("migrate", () => {
      if (this.heads.size === 0) {
        this.insertInitial(initialDocument, true);
      }
      const unarchived = this.sortedSummaries().filter(
        (summary) => summary.archivedAt === null,
      );
      if (unarchived.length === 0) {
        const fallback = this.sortedSummaries()[0]!;
        this.summaries.set(fallback.documentId, {
          ...fallback,
          archivedAt: null,
        });
      }
      if (
        !this.activeDocumentId ||
        !this.heads.has(this.activeDocumentId) ||
        this.summaries.get(this.activeDocumentId)?.archivedAt !== null
      ) {
        this.activeDocumentId = this.sortedSummaries().find(
          (summary) => summary.archivedAt === null,
        )!.documentId;
      }
      return {
        activeDocumentId: this.activeDocumentId,
        documents: this.sortedSummaries(),
        migration: { status: "none" },
      };
    });
  }

  listDocuments(): Effect.Effect<
    DocumentSummary[],
    DocumentRepositoryFailure
  > {
    return this.attempt("read", () => this.sortedSummaries());
  }

  loadDocument(
    documentId: string,
  ): Effect.Effect<
    { document: LogoDocument; revision: number },
    DocumentRepositoryFailure
  > {
    return this.attempt("read", () => {
      const head = this.requireHead(documentId);
      return {
        document: cloneLogoDocument(head.document),
        revision: head.revision,
      };
    });
  }

  createDocument(
    request: CreateDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      const documentId = request.document.id;
      if (this.heads.has(documentId)) {
        throw new DocumentAlreadyExistsError({ documentId });
      }
      const summary = this.insertInitial(
        request.document,
        request.makeActive ?? false,
      );
      return { revision: 1, summary };
    });
  }

  commitDocument(
    request: CommitDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      if (request.document.id !== request.documentId) {
        throw new DocumentIdMismatchError({
          documentId: request.documentId,
          payloadDocumentId: request.document.id,
        });
      }

      const head = this.requireHead(request.documentId);
      const previousSummary = this.requireSummary(request.documentId);
      const document = decodeRepositoryDocument(request.document);
      if (previousSummary.archivedAt !== null) {
        const recovery = this.insertVersion({
          documentId: request.documentId,
          document,
          kind: "conflict",
          label: "Archived edit recovery",
          sourceRevision: request.expectedRevision,
        });
        throw new DocumentArchivedError({
          documentId: request.documentId,
          operation: "commit",
          recoveryVersionId: recovery.versionId,
        });
      }
      if (head.revision !== request.expectedRevision) {
        const recovery = this.insertVersion({
          documentId: request.documentId,
          document,
          kind: "conflict",
          label: "Concurrent edit recovery",
          sourceRevision: request.expectedRevision,
        });
        throw new DocumentRevisionConflict({
          documentId: request.documentId,
          expectedRevision: request.expectedRevision,
          actualRevision: head.revision,
          recoveryVersionId: recovery.versionId,
        });
      }

      const revision = head.revision + 1;
      const updatedAt = this.now();
      const summary = documentSummary(
        document,
        revision,
        previousSummary.createdAt,
        updatedAt,
        previousSummary.lastOpenedAt,
      );
      this.heads.set(request.documentId, { document, revision });
      this.summaries.set(request.documentId, summary);
      return { revision, summary: structuredClone(summary) };
    });
  }

  setActiveDocument(
    documentId: string,
  ): Effect.Effect<void, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      this.requireHead(documentId);
      const summary = this.requireSummary(documentId);
      if (summary.archivedAt !== null) {
        throw new DocumentArchivedError({
          documentId,
          operation: "activate",
        });
      }
      this.activeDocumentId = documentId;
      this.summaries.set(documentId, {
        ...summary,
        lastOpenedAt: this.now(),
      });
    });
  }

  archiveDocument(
    documentId: string,
  ): Effect.Effect<ArchiveDocumentResult, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      this.requireHead(documentId);
      const summary = this.requireSummary(documentId);
      const timestamp = this.now();

      let archivedSummary = summary;
      if (summary.archivedAt === null) {
        const unarchived = this.sortedSummaries().filter(
          (item) => item.archivedAt === null,
        );
        if (unarchived.length <= 1) {
          throw new LastUnarchivedDocumentError({ documentId });
        }
        archivedSummary = { ...summary, archivedAt: timestamp };
        this.summaries.set(documentId, archivedSummary);
      }

      if (this.activeDocumentId === documentId) {
        const next = this.sortedSummaries().find(
          (item) => item.archivedAt === null,
        )!;
        this.activeDocumentId = next.documentId;
        this.summaries.set(next.documentId, {
          ...next,
          lastOpenedAt: timestamp,
        });
      }

      const activeDocumentId = this.activeDocumentId!;
      const active = this.requireHead(activeDocumentId);
      return {
        archivedSummary: structuredClone(archivedSummary),
        activeDocumentId,
        activeDocument: {
          document: cloneLogoDocument(active.document),
          revision: active.revision,
        },
        documents: this.sortedSummaries(),
      };
    });
  }

  restoreArchivedDocument(
    documentId: string,
  ): Effect.Effect<DocumentSummary, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      this.requireHead(documentId);
      const summary = this.requireSummary(documentId);
      const restored =
        summary.archivedAt === null ? summary : { ...summary, archivedAt: null };
      this.summaries.set(documentId, restored);
      return structuredClone(restored);
    });
  }

  createVersion(
    request: CreateVersionRequest,
  ): Effect.Effect<DocumentVersion, DocumentRepositoryFailure> {
    return this.attempt("write", () => {
      const head = this.requireHead(request.documentId);
      return this.insertVersion({
        documentId: request.documentId,
        document: head.document,
        kind: request.kind,
        label: request.label ?? null,
        sourceRevision: head.revision,
      });
    });
  }

  listVersions(
    documentId: string,
  ): Effect.Effect<DocumentVersion[], DocumentRepositoryFailure> {
    return this.attempt("read", () => {
      this.requireHead(documentId);
      return sortDocumentVersions(
        [...this.versions.values()]
          .filter((version) => version.documentId === documentId)
          .map((version) => structuredClone(version)),
      );
    });
  }

  private insertInitial(
    input: LogoDocument,
    makeActive: boolean,
  ): DocumentSummary {
    const document = decodeRepositoryDocument(input);
    const timestamp = this.now();
    const summary = documentSummary(document, 1, timestamp, timestamp);
    this.heads.set(document.id, { document, revision: 1 });
    this.summaries.set(document.id, summary);
    if (makeActive || this.activeDocumentId === null) {
      this.activeDocumentId = document.id;
    }
    return structuredClone(summary);
  }

  private insertVersion(input: {
    documentId: string;
    document: LogoDocument;
    kind: DocumentVersion["kind"];
    label: string | null;
    sourceRevision: number;
  }): DocumentVersion {
    const version: DocumentVersion = {
      versionId: this.makeId("version"),
      documentId: input.documentId,
      kind: input.kind,
      label: input.label,
      createdAt: this.now(),
      sourceRevision: input.sourceRevision,
      document: cloneLogoDocument(input.document),
    };
    this.versions.set(version.versionId, version);
    if (version.kind === "automatic") {
      this.pruneAutomaticVersions(version.documentId);
    }
    return structuredClone(version);
  }

  private pruneAutomaticVersions(documentId: string): void {
    const automatic = [...this.versions.values()]
      .filter(
        (version) =>
          version.documentId === documentId && version.kind === "automatic",
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.versionId.localeCompare(b.versionId),
      );
    for (const version of automatic.slice(
      0,
      Math.max(0, automatic.length - this.automaticVersionLimit),
    )) {
      this.versions.delete(version.versionId);
    }
  }

  private requireHead(documentId: string): HeadRecord {
    const head = this.heads.get(documentId);
    if (!head) {
      throw new DocumentNotFoundError({ documentId });
    }
    return head;
  }

  private requireSummary(documentId: string): DocumentSummary {
    const summary = this.summaries.get(documentId);
    if (!summary) {
      throw new DocumentNotFoundError({ documentId });
    }
    return normalizeDocumentSummary(summary);
  }

  private sortedSummaries(): DocumentSummary[] {
    return sortDocumentSummaries(
      [...this.summaries.values()].map((summary) => structuredClone(summary)),
    );
  }

  private attempt<A>(
    operation: DocumentRepositoryOperation,
    run: () => A,
  ): Effect.Effect<A, DocumentRepositoryFailure> {
    return Effect.try({
      try: run,
      catch: (cause) =>
        isDocumentRepositoryFailure(cause)
          ? cause
          : new DocumentRepositoryError({ operation, cause }),
    });
  }
}
