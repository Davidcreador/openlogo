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
  type LegacyMigrationResult,
  cloneLogoDocument,
  decodeRepositoryDocument,
  documentSummary,
  isDocumentRepositoryFailure,
  normalizeDocumentSummary,
  sortDocumentSummaries,
  sortDocumentVersions,
} from "./document-repository";

export const OPENLOGO_DATABASE_NAME = "openlogo";
export const OPENLOGO_DATABASE_VERSION = 2;
export const LEGACY_DOCUMENT_STORE = "documents";
export const DOCUMENT_HEAD_STORE = "document-heads";
export const DOCUMENT_SUMMARY_STORE = "document-summaries";
export const DOCUMENT_VERSION_STORE = "document-versions";
export const WORKSPACE_STORE = "workspace";

const WORKSPACE_KEY = "state";
const LEGACY_CURRENT_KEY = "current";
const VERSION_BY_DOCUMENT = "by-document-created";
const VERSION_BY_DOCUMENT_KIND = "by-document-kind-created";

type HeadRecord = {
  documentId: string;
  document: LogoDocument;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type WorkspaceRecord = {
  key: typeof WORKSPACE_KEY;
  activeDocumentId: string;
  legacyMigration: LegacyMigrationResult;
  migrationVersion: 1;
};

export type IndexedDbDocumentRepositoryOptions = {
  databaseName?: string;
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  now?: () => number;
  createId?: (prefix: string) => string;
  automaticVersionLimit?: number;
};

/** IndexedDB v2 adapter for the local Document Library. */
export class IndexedDbDocumentRepository implements DocumentRepository {
  private readonly databaseName: string;
  private readonly factory: IDBFactory;
  private readonly keyRange: typeof IDBKeyRange;
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly automaticVersionLimit: number;

  constructor(options: IndexedDbDocumentRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? OPENLOGO_DATABASE_NAME;
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.keyRange = options.keyRange ?? globalThis.IDBKeyRange;
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
    return this.run("migrate", async (db) => {
      const snapshot = await runTransaction(
        db,
        [
          DOCUMENT_HEAD_STORE,
          DOCUMENT_SUMMARY_STORE,
          WORKSPACE_STORE,
          LEGACY_DOCUMENT_STORE,
        ],
        "readonly",
        async (transaction) => {
          const [heads, summaries, workspace, legacy] = await Promise.all([
            requestResult<HeadRecord[]>(
              transaction.objectStore(DOCUMENT_HEAD_STORE).getAll(),
            ),
            requestResult<DocumentSummary[]>(
              transaction.objectStore(DOCUMENT_SUMMARY_STORE).getAll(),
            ),
            requestResult<WorkspaceRecord | undefined>(
              transaction.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY),
            ),
            requestResult<unknown>(
              transaction
                .objectStore(LEGACY_DOCUMENT_STORE)
                .get(LEGACY_CURRENT_KEY),
            ),
          ]);
          return { heads, summaries, workspace, legacy };
        },
      );

      if (snapshot.heads.length > 0) {
        return this.recoverExistingWorkspace(db, initialDocument);
      }

      let document: LogoDocument;
      let migration: LegacyMigrationResult = { status: "none" };
      if (snapshot.legacy !== undefined && snapshot.legacy !== null) {
        try {
          document = decodeRepositoryDocument(snapshot.legacy);
          migration = { status: "migrated", documentId: document.id };
        } catch {
          document = decodeRepositoryDocument(initialDocument);
          migration = {
            status: "blocked",
            reason:
              "The legacy local document failed validation and was left untouched.",
          };
        }
      } else {
        document = decodeRepositoryDocument(initialDocument);
      }

      const result = await runTransaction(
        db,
        [
          DOCUMENT_HEAD_STORE,
          DOCUMENT_SUMMARY_STORE,
          DOCUMENT_VERSION_STORE,
          WORKSPACE_STORE,
        ],
        "readwrite",
        async (transaction) => {
          const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
          const summaryStore = transaction.objectStore(
            DOCUMENT_SUMMARY_STORE,
          );
          const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
          const concurrentHeads = await requestResult<HeadRecord[]>(
            headStore.getAll(),
          );
          if (concurrentHeads.length > 0) {
            const [concurrentSummaries, concurrentWorkspace] =
              await Promise.all([
                requestResult<DocumentSummary[]>(summaryStore.getAll()),
                requestResult<WorkspaceRecord | undefined>(
                  workspaceStore.get(WORKSPACE_KEY),
                ),
              ]);
            return {
              created: false as const,
              heads: concurrentHeads,
              summaries: concurrentSummaries,
              workspace: concurrentWorkspace,
            };
          }

          const timestamp = this.now();
          const head: HeadRecord = {
            documentId: document.id,
            document: cloneLogoDocument(document),
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const summary = documentSummary(
            document,
            1,
            timestamp,
            timestamp,
          );
          const workspace: WorkspaceRecord = {
            key: WORKSPACE_KEY,
            activeDocumentId: document.id,
            legacyMigration: migration,
            migrationVersion: 1,
          };

          headStore.put(head);
          // A workspace with no heads has no authoritative summaries. Remove
          // any orphaned derived metadata before publishing the new head.
          summaryStore.clear();
          summaryStore.put(summary);
          workspaceStore.put(workspace);

          if (migration.status === "migrated") {
            const version: DocumentVersion = {
              versionId: this.makeId("version"),
              documentId: document.id,
              kind: "migration",
              label: "Legacy local document",
              createdAt: timestamp,
              sourceRevision: 1,
              document: cloneLogoDocument(document),
            };
            transaction.objectStore(DOCUMENT_VERSION_STORE).put(version);
          }

          return { created: true as const, workspace, summary };
        },
      );

      if (!result.created) {
        return this.recoverExistingWorkspace(db, initialDocument);
      }
      return {
        activeDocumentId: result.workspace.activeDocumentId,
        documents: [structuredClone(result.summary)],
        migration: structuredClone(result.workspace.legacyMigration),
      };
    });
  }

  listDocuments(): Effect.Effect<
    DocumentSummary[],
    DocumentRepositoryFailure
  > {
    return this.run("read", (db) => this.listDocumentsFromDatabase(db));
  }

  loadDocument(
    documentId: string,
  ): Effect.Effect<
    { document: LogoDocument; revision: number },
    DocumentRepositoryFailure
  > {
    return this.run("read", async (db) => {
      const head = await runTransaction(
        db,
        [DOCUMENT_HEAD_STORE],
        "readonly",
        (transaction) =>
          requestResult<HeadRecord | undefined>(
            transaction.objectStore(DOCUMENT_HEAD_STORE).get(documentId),
          ),
      );
      if (!head) {
        throw new DocumentNotFoundError({ documentId });
      }
      return {
        document: this.decode(head.document),
        revision: head.revision,
      };
    });
  }

  createDocument(
    request: CreateDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure> {
    return this.run("write", async (db) => {
      const document = decodeRepositoryDocument(request.document);
      const timestamp = this.now();
      return runTransaction(
        db,
        [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
        "readwrite",
        async (transaction) => {
          const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
          const existing = await requestResult<HeadRecord | undefined>(
            headStore.get(document.id),
          );
          if (existing) {
            throw new DocumentAlreadyExistsError({ documentId: document.id });
          }

          const head: HeadRecord = {
            documentId: document.id,
            document,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const summary = documentSummary(
            document,
            1,
            timestamp,
            timestamp,
          );
          headStore.put(head);
          transaction.objectStore(DOCUMENT_SUMMARY_STORE).put(summary);

          const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
          const workspace = await requestResult<WorkspaceRecord | undefined>(
            workspaceStore.get(WORKSPACE_KEY),
          );
          if (request.makeActive || !workspace) {
            workspaceStore.put({
              key: WORKSPACE_KEY,
              activeDocumentId: document.id,
              legacyMigration: workspace?.legacyMigration ?? { status: "none" },
              migrationVersion: 1,
            } satisfies WorkspaceRecord);
          }
          return { revision: 1, summary: structuredClone(summary) };
        },
      );
    });
  }

  commitDocument(
    request: CommitDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure> {
    return this.run("write", async (db) => {
      if (request.document.id !== request.documentId) {
        throw new DocumentIdMismatchError({
          documentId: request.documentId,
          payloadDocumentId: request.document.id,
        });
      }
      const document = decodeRepositoryDocument(request.document);
      const timestamp = this.now();
      const outcome = await runTransaction(
        db,
        [
          DOCUMENT_HEAD_STORE,
          DOCUMENT_SUMMARY_STORE,
          DOCUMENT_VERSION_STORE,
        ],
        "readwrite",
        async (transaction) => {
          const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
          const head = await requestResult<HeadRecord | undefined>(
            headStore.get(request.documentId),
          );
          if (!head) {
            throw new DocumentNotFoundError({
              documentId: request.documentId,
            });
          }

          const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
          const storedSummary = await requestResult<
            DocumentSummary | undefined
          >(summaryStore.get(request.documentId));
          if (!storedSummary) {
            throw new DocumentNotFoundError({
              documentId: request.documentId,
            });
          }
          const previousSummary = normalizeDocumentSummary(storedSummary);
          if (previousSummary.archivedAt !== null) {
            const recovery: DocumentVersion = {
              versionId: this.makeId("version"),
              documentId: request.documentId,
              kind: "conflict",
              label: "Archived edit recovery",
              createdAt: timestamp,
              sourceRevision: request.expectedRevision,
              document,
            };
            transaction.objectStore(DOCUMENT_VERSION_STORE).put(recovery);
            return {
              status: "archived" as const,
              recoveryVersionId: recovery.versionId,
            };
          }

          if (head.revision !== request.expectedRevision) {
            const recovery: DocumentVersion = {
              versionId: this.makeId("version"),
              documentId: request.documentId,
              kind: "conflict",
              label: "Concurrent edit recovery",
              createdAt: timestamp,
              sourceRevision: request.expectedRevision,
              document,
            };
            transaction.objectStore(DOCUMENT_VERSION_STORE).put(recovery);
            return {
              status: "conflict" as const,
              actualRevision: head.revision,
              recoveryVersionId: recovery.versionId,
            };
          }

          const revision = head.revision + 1;
          const summary = documentSummary(
            document,
            revision,
            head.createdAt,
            timestamp,
            previousSummary.lastOpenedAt,
          );
          headStore.put({
            documentId: request.documentId,
            document,
            revision,
            createdAt: head.createdAt,
            updatedAt: timestamp,
          } satisfies HeadRecord);
          summaryStore.put(summary);
          return {
            status: "committed" as const,
            result: { revision, summary: structuredClone(summary) },
          };
        },
      );

      if (outcome.status === "archived") {
        throw new DocumentArchivedError({
          documentId: request.documentId,
          operation: "commit",
          recoveryVersionId: outcome.recoveryVersionId,
        });
      }
      if (outcome.status === "conflict") {
        throw new DocumentRevisionConflict({
          documentId: request.documentId,
          expectedRevision: request.expectedRevision,
          actualRevision: outcome.actualRevision,
          recoveryVersionId: outcome.recoveryVersionId,
        });
      }
      return outcome.result;
    });
  }

  setActiveDocument(
    documentId: string,
  ): Effect.Effect<void, DocumentRepositoryFailure> {
    return this.run("write", (db) =>
      runTransaction(
        db,
        [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
        "readwrite",
        async (transaction) => {
          const head = await requestResult<HeadRecord | undefined>(
            transaction.objectStore(DOCUMENT_HEAD_STORE).get(documentId),
          );
          if (!head) {
            throw new DocumentNotFoundError({ documentId });
          }

          const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
          const storedSummary = await requestResult<
            DocumentSummary | undefined
          >(summaryStore.get(documentId));
          if (!storedSummary) {
            throw new DocumentNotFoundError({ documentId });
          }
          const summary = normalizeDocumentSummary(storedSummary);
          if (summary.archivedAt !== null) {
            throw new DocumentArchivedError({
              documentId,
              operation: "activate",
            });
          }

          const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
          const workspace = await requestResult<WorkspaceRecord | undefined>(
            workspaceStore.get(WORKSPACE_KEY),
          );
          workspaceStore.put({
            key: WORKSPACE_KEY,
            activeDocumentId: documentId,
            legacyMigration: workspace?.legacyMigration ?? { status: "none" },
            migrationVersion: 1,
          } satisfies WorkspaceRecord);

          summaryStore.put({ ...summary, lastOpenedAt: this.now() });
        },
      ),
    );
  }

  archiveDocument(
    documentId: string,
  ): Effect.Effect<ArchiveDocumentResult, DocumentRepositoryFailure> {
    return this.run("write", (db) =>
      runTransaction(
        db,
        [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE, WORKSPACE_STORE],
        "readwrite",
        async (transaction) => {
          const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
          const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
          const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
          const [targetHead, rawSummaries, workspace] = await Promise.all([
            requestResult<HeadRecord | undefined>(headStore.get(documentId)),
            requestResult<DocumentSummary[]>(summaryStore.getAll()),
            requestResult<WorkspaceRecord | undefined>(
              workspaceStore.get(WORKSPACE_KEY),
            ),
          ]);
          if (!targetHead) {
            throw new DocumentNotFoundError({ documentId });
          }

          const summaries = rawSummaries.map(normalizeDocumentSummary);
          const targetIndex = summaries.findIndex(
            (summary) => summary.documentId === documentId,
          );
          if (targetIndex < 0) {
            throw new DocumentNotFoundError({ documentId });
          }

          const timestamp = this.now();
          const targetSummary = summaries[targetIndex]!;
          let archivedSummary = targetSummary;
          if (targetSummary.archivedAt === null) {
            if (
              summaries.filter((summary) => summary.archivedAt === null)
                .length <= 1
            ) {
              throw new LastUnarchivedDocumentError({ documentId });
            }
            archivedSummary = { ...targetSummary, archivedAt: timestamp };
            summaries[targetIndex] = archivedSummary;
            summaryStore.put(archivedSummary);
          }

          const unarchived = sortDocumentSummaries(summaries).filter(
            (summary) => summary.archivedAt === null,
          );
          const workspaceActive = workspace?.activeDocumentId;
          const activeStillUsable = unarchived.some(
            (summary) => summary.documentId === workspaceActive,
          );
          const activeDocumentId = activeStillUsable
            ? workspaceActive!
            : unarchived[0]!.documentId;
          const activeIndex = summaries.findIndex(
            (summary) => summary.documentId === activeDocumentId,
          );
          const activeSummary = {
            ...summaries[activeIndex]!,
            ...(workspaceActive === activeDocumentId
              ? {}
              : { lastOpenedAt: timestamp }),
          };
          summaries[activeIndex] = activeSummary;
          if (workspaceActive !== activeDocumentId) {
            summaryStore.put(activeSummary);
          }

          const activeHead = await requestResult<HeadRecord | undefined>(
            headStore.get(activeDocumentId),
          );
          if (!activeHead) {
            throw new DocumentNotFoundError({ documentId: activeDocumentId });
          }
          workspaceStore.put({
            key: WORKSPACE_KEY,
            activeDocumentId,
            legacyMigration: workspace?.legacyMigration ?? { status: "none" },
            migrationVersion: 1,
          } satisfies WorkspaceRecord);

          return {
            archivedSummary: structuredClone(archivedSummary),
            activeDocumentId,
            activeDocument: {
              document: this.decode(activeHead.document),
              revision: activeHead.revision,
            },
            documents: sortDocumentSummaries(summaries).map((summary) =>
              structuredClone(summary),
            ),
          };
        },
      ),
    );
  }

  restoreArchivedDocument(
    documentId: string,
  ): Effect.Effect<DocumentSummary, DocumentRepositoryFailure> {
    return this.run("write", (db) =>
      runTransaction(
        db,
        [DOCUMENT_HEAD_STORE, DOCUMENT_SUMMARY_STORE],
        "readwrite",
        async (transaction) => {
          const [head, storedSummary] = await Promise.all([
            requestResult<HeadRecord | undefined>(
              transaction.objectStore(DOCUMENT_HEAD_STORE).get(documentId),
            ),
            requestResult<DocumentSummary | undefined>(
              transaction
                .objectStore(DOCUMENT_SUMMARY_STORE)
                .get(documentId),
            ),
          ]);
          if (!head || !storedSummary) {
            throw new DocumentNotFoundError({ documentId });
          }
          const summary = normalizeDocumentSummary(storedSummary);
          const restored =
            summary.archivedAt === null
              ? summary
              : { ...summary, archivedAt: null };
          transaction.objectStore(DOCUMENT_SUMMARY_STORE).put(restored);
          return structuredClone(restored);
        },
      ),
    );
  }

  createVersion(
    request: CreateVersionRequest,
  ): Effect.Effect<DocumentVersion, DocumentRepositoryFailure> {
    return this.run("write", (db) =>
      runTransaction(
        db,
        [DOCUMENT_HEAD_STORE, DOCUMENT_VERSION_STORE],
        "readwrite",
        async (transaction) => {
          const head = await requestResult<HeadRecord | undefined>(
            transaction
              .objectStore(DOCUMENT_HEAD_STORE)
              .get(request.documentId),
          );
          if (!head) {
            throw new DocumentNotFoundError({
              documentId: request.documentId,
            });
          }

          const version: DocumentVersion = {
            versionId: this.makeId("version"),
            documentId: request.documentId,
            kind: request.kind,
            label: request.label ?? null,
            createdAt: this.now(),
            sourceRevision: head.revision,
            document: this.decode(head.document),
          };
          const versionStore = transaction.objectStore(
            DOCUMENT_VERSION_STORE,
          );

          if (version.kind === "automatic") {
            const existing = await requestResult<DocumentVersion[]>(
              versionStore
                .index(VERSION_BY_DOCUMENT_KIND)
                .getAll(this.versionKindRange(version.documentId, "automatic")),
            );
            const removeCount = Math.max(
              0,
              existing.length - this.automaticVersionLimit + 1,
            );
            const oldest = [...existing].sort(
              (a, b) =>
                a.createdAt - b.createdAt ||
                a.versionId.localeCompare(b.versionId),
            );
            for (const expired of oldest.slice(0, removeCount)) {
              versionStore.delete(expired.versionId);
            }
          }

          versionStore.put(version);
          return structuredClone(version);
        },
      ),
    );
  }

  listVersions(
    documentId: string,
  ): Effect.Effect<DocumentVersion[], DocumentRepositoryFailure> {
    return this.run("read", async (db) => {
      const outcome = await runTransaction(
        db,
        [
          DOCUMENT_HEAD_STORE,
          DOCUMENT_VERSION_STORE,
          LEGACY_DOCUMENT_STORE,
        ],
        "readwrite",
        async (transaction) => {
          const head = await requestResult<HeadRecord | undefined>(
            transaction.objectStore(DOCUMENT_HEAD_STORE).get(documentId),
          );
          if (!head) {
            throw new DocumentNotFoundError({ documentId });
          }
          const versionStore = transaction.objectStore(DOCUMENT_VERSION_STORE);
          const records = await requestResult<DocumentVersion[]>(
            versionStore
              .index(VERSION_BY_DOCUMENT)
              .getAll(this.versionDocumentRange(documentId)),
          );
          const versions: DocumentVersion[] = [];
          const recoveryKeys: string[] = [];
          const legacyStore = transaction.objectStore(LEGACY_DOCUMENT_STORE);
          for (const record of records) {
            try {
              const document = this.decode(record.document);
              if (document.id !== documentId) {
                throw new DocumentIdMismatchError({
                  documentId,
                  payloadDocumentId: document.id,
                });
              }
              versions.push({ ...structuredClone(record), document });
            } catch {
              const recoveryKey = `recovery-version-${record.versionId}-${this.makeId("snapshot")}`;
              legacyStore.add(structuredClone(record), recoveryKey);
              versionStore.delete(record.versionId);
              recoveryKeys.push(recoveryKey);
            }
          }
          return { versions, recoveryKeys };
        },
      );
      if (outcome.recoveryKeys.length > 0) {
        console.warn(
          `Corrupt document versions were preserved in IndexedDB store "${LEGACY_DOCUMENT_STORE}" under ${outcome.recoveryKeys.join(", ")}.`,
        );
      }
      return sortDocumentVersions(outcome.versions);
    });
  }

  private recoverExistingWorkspace(
    db: IDBDatabase,
    initialDocument: LogoDocument,
  ): Promise<DocumentRepositoryBootstrap> {
    // Summaries and the active pointer are derived metadata. Reconcile them
    // against the authoritative heads in one transaction so interrupted or
    // externally-corrupted metadata cannot hide a surviving document or make
    // an orphaned summary active. Re-reading here also avoids repairing from
    // a snapshot made stale by another tab between bootstrap transactions.
    return runTransaction(
      db,
      [
        DOCUMENT_HEAD_STORE,
        DOCUMENT_SUMMARY_STORE,
        DOCUMENT_VERSION_STORE,
        WORKSPACE_STORE,
        LEGACY_DOCUMENT_STORE,
      ],
      "readwrite",
      async (transaction) => {
        const headStore = transaction.objectStore(DOCUMENT_HEAD_STORE);
        const summaryStore = transaction.objectStore(DOCUMENT_SUMMARY_STORE);
        const versionStore = transaction.objectStore(DOCUMENT_VERSION_STORE);
        const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
        const legacyStore = transaction.objectStore(LEGACY_DOCUMENT_STORE);
        const [heads, summaries, workspace] = await Promise.all([
          requestResult<HeadRecord[]>(headStore.getAll()),
          requestResult<DocumentSummary[]>(summaryStore.getAll()),
          requestResult<WorkspaceRecord | undefined>(
            workspaceStore.get(WORKSPACE_KEY),
          ),
        ]);

        if (heads.length === 0) {
          throw new DocumentRepositoryError({
            operation: "migrate",
            cause: new Error("Document workspace has no authoritative head."),
          });
        }

        const existingSummaries = new Map(
          summaries
            .map(normalizeDocumentSummary)
            .map((summary) => [summary.documentId, summary]),
        );
        const validHeads: Array<{
          head: HeadRecord;
          document: LogoDocument;
        }> = [];
        const corruptHeads: HeadRecord[] = [];
        for (const head of heads) {
          try {
            const document = this.decode(head.document);
            if (document.id !== head.documentId) {
              throw new DocumentIdMismatchError({
                documentId: head.documentId,
                payloadDocumentId: document.id,
              });
            }
            validHeads.push({ head, document });
          } catch {
            corruptHeads.push(head);
          }
        }

        const recoveryKeys: string[] = [];
        if (corruptHeads.length > 0) {
          const recoveredAt = this.now();
          const recovered = await Promise.all(
            corruptHeads.map(async (head) => {
              const versions = sortDocumentVersions(
                await requestResult<DocumentVersion[]>(
                  versionStore
                    .index(VERSION_BY_DOCUMENT)
                    .getAll(this.versionDocumentRange(head.documentId)),
                ),
              );
              const candidates = [
                ...versions.filter(
                  (version) =>
                    version.kind !== "conflict" && version.kind !== "deleted",
                ),
                ...versions.filter((version) => version.kind === "conflict"),
              ];
              for (const version of candidates) {
                try {
                  const document = this.decode(version.document);
                  if (document.id === head.documentId) {
                    return { head, document };
                  }
                } catch {
                  // Try the next retained snapshot; the raw head is preserved below.
                }
              }
              return { head, document: null };
            }),
          );

          for (const item of recovered) {
            const recoveryKey = `recovery-head-${item.head.documentId}-${this.makeId("snapshot")}`;
            legacyStore.add(structuredClone(item.head), recoveryKey);
            recoveryKeys.push(recoveryKey);
            if (item.document) {
              const head: HeadRecord = {
                documentId: item.head.documentId,
                document: item.document,
                revision: item.head.revision + 1,
                createdAt: item.head.createdAt,
                updatedAt: recoveredAt,
              };
              headStore.put(head);
              validHeads.push({ head, document: item.document });
            } else {
              headStore.delete(item.head.documentId);
            }
          }

          if (validHeads.length === 0) {
            const document = this.decode(initialDocument);
            const head: HeadRecord = {
              documentId: document.id,
              document,
              revision: 1,
              createdAt: recoveredAt,
              updatedAt: recoveredAt,
            };
            headStore.put(head);
            validHeads.push({ head, document });
          }
        }

        let canonicalSummaries = validHeads.map(({ head, document }) =>
          documentSummary(
            document,
            head.revision,
            head.createdAt,
            head.updatedAt,
            existingSummaries.get(head.documentId)?.lastOpenedAt ??
              head.updatedAt,
            existingSummaries.get(head.documentId)?.archivedAt ?? null,
          ),
        );
        let sorted = sortDocumentSummaries(canonicalSummaries);
        if (!sorted.some((summary) => summary.archivedAt === null)) {
          const fallbackId = sorted[0]!.documentId;
          canonicalSummaries = canonicalSummaries.map((summary) =>
            summary.documentId === fallbackId
              ? { ...summary, archivedAt: null }
              : summary,
          );
          sorted = sortDocumentSummaries(canonicalSummaries);
        }
        const unarchivedIds = new Set(
          sorted
            .filter((summary) => summary.archivedAt === null)
            .map((summary) => summary.documentId),
        );
        const activeDocumentId =
          workspace && unarchivedIds.has(workspace.activeDocumentId)
            ? workspace.activeDocumentId
            : sorted.find((summary) => summary.archivedAt === null)!.documentId;
        const migration: LegacyMigrationResult =
          recoveryKeys.length > 0
            ? {
                status: "blocked",
                reason: `Corrupt document heads were preserved in IndexedDB store "${LEGACY_DOCUMENT_STORE}" under ${recoveryKeys.join(", ")}. The newest valid retained versions were restored when available.`,
              }
            : (workspace?.legacyMigration ?? { status: "none" });

        summaryStore.clear();
        for (const summary of canonicalSummaries) {
          summaryStore.put(summary);
        }
        workspaceStore.put({
          key: WORKSPACE_KEY,
          activeDocumentId,
          legacyMigration: migration,
          migrationVersion: 1,
        } satisfies WorkspaceRecord);

        return {
          activeDocumentId,
          documents: sorted.map((summary) => structuredClone(summary)),
          migration: structuredClone(migration),
        };
      },
    );
  }

  private async listDocumentsFromDatabase(
    db: IDBDatabase,
  ): Promise<DocumentSummary[]> {
    const summaries = await runTransaction(
      db,
      [DOCUMENT_SUMMARY_STORE],
      "readonly",
      (transaction) =>
        requestResult<DocumentSummary[]>(
          transaction.objectStore(DOCUMENT_SUMMARY_STORE).getAll(),
        ),
    );
    return sortDocumentSummaries(
      summaries.map((summary) => normalizeDocumentSummary(summary)),
    );
  }

  private decode(data: unknown): LogoDocument {
    return decodeRepositoryDocument(data);
  }

  private versionDocumentRange(documentId: string): IDBKeyRange {
    return this.keyRange.bound(
      [documentId, Number.MIN_SAFE_INTEGER],
      [documentId, Number.MAX_SAFE_INTEGER],
    );
  }

  private versionKindRange(
    documentId: string,
    kind: DocumentVersion["kind"],
  ): IDBKeyRange {
    return this.keyRange.bound(
      [documentId, kind, Number.MIN_SAFE_INTEGER],
      [documentId, kind, Number.MAX_SAFE_INTEGER],
    );
  }

  private run<A>(
    operation: DocumentRepositoryOperation,
    use: (database: IDBDatabase) => Promise<A>,
  ): Effect.Effect<A, DocumentRepositoryFailure> {
    return Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => openDatabase(this.factory, this.databaseName),
        catch: (cause) => this.failure("open", cause),
      }),
      (database) =>
        Effect.tryPromise({
          try: () => use(database),
          catch: (cause) => this.failure(operation, cause),
        }),
      (database) => Effect.sync(() => database.close()),
    );
  }

  private failure(
    operation: DocumentRepositoryOperation,
    cause: unknown,
  ): DocumentRepositoryFailure {
    return isDocumentRepositoryFailure(cause)
      ? cause
      : new DocumentRepositoryError({ operation, cause });
  }
}

function upgradeDatabase(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(LEGACY_DOCUMENT_STORE)) {
    database.createObjectStore(LEGACY_DOCUMENT_STORE);
  }
  if (!database.objectStoreNames.contains(DOCUMENT_HEAD_STORE)) {
    database.createObjectStore(DOCUMENT_HEAD_STORE, {
      keyPath: "documentId",
    });
  }
  if (!database.objectStoreNames.contains(DOCUMENT_SUMMARY_STORE)) {
    database.createObjectStore(DOCUMENT_SUMMARY_STORE, {
      keyPath: "documentId",
    });
  }
  if (!database.objectStoreNames.contains(DOCUMENT_VERSION_STORE)) {
    const versions = database.createObjectStore(DOCUMENT_VERSION_STORE, {
      keyPath: "versionId",
    });
    versions.createIndex(
      VERSION_BY_DOCUMENT,
      ["documentId", "createdAt"],
    );
    versions.createIndex(
      VERSION_BY_DOCUMENT_KIND,
      ["documentId", "kind", "createdAt"],
    );
  }
  if (!database.objectStoreNames.contains(WORKSPACE_STORE)) {
    database.createObjectStore(WORKSPACE_STORE, { keyPath: "key" });
  }
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(databaseName, OPENLOGO_DATABASE_VERSION);
    request.onupgradeneeded = () => upgradeDatabase(request.result);
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        reject(request.error ?? new Error("IndexedDB open failed."));
      }
    };
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "IndexedDB upgrade is blocked by another OpenLogo tab.",
          ),
        );
      }
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function runTransaction<A>(
  database: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  use: (transaction: IDBTransaction) => Promise<A>,
): Promise<A> {
  const transaction = database.transaction(storeNames, mode);
  const completion = transactionCompletion(transaction);
  try {
    const result = await use(transaction);
    await completion;
    return result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // Already completed/aborted; preserve the original failure.
    }
    await completion.catch(() => undefined);
    throw cause;
  }
}
