import {
  createId,
  createInitialDocument,
  type LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import {
  DEFAULT_AUTOMATIC_VERSION_LIMIT,
  DocumentRevisionConflict,
  cloneLogoDocument,
  sortDocumentFolders,
  sortDocumentSummaries,
  sortDocumentVersions,
  type DocumentFolder,
  type DocumentRepository,
  type DocumentRepositoryFailure,
  type DocumentSummary,
  type DocumentVersion,
  type LegacyMigrationResult,
} from "./document-repository";
import type {
  DocumentSaveResult,
  DocumentSession,
} from "./document-session";
import { renderDocumentThumbnail } from "./document-thumbnail";
import { IndexedDbDocumentRepository } from "./indexeddb-document-repository";

async function runRepositoryEffect<A>(
  effect: Effect.Effect<A, DocumentRepositoryFailure>,
): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") {
    throw result.left;
  }
  return result.right;
}

export type DocumentLibraryOperation =
  | "create"
  | "duplicate"
  | "import"
  | "rename"
  | "switch"
  | "archive"
  | "unarchive"
  | "version"
  | "restore"
  | "folder"
  | "move"
  | null;

export type DocumentLibraryState = {
  ready: boolean;
  activeDocumentId: string | null;
  readonly documents: readonly DocumentSummary[];
  readonly folders: readonly DocumentFolder[];
  readonly versions: readonly DocumentVersion[];
  operation: DocumentLibraryOperation;
  notice: string | null;
  error: string | null;
};

export class DocumentTransitionBlockedError extends Error {
  constructor() {
    super(
      "OpenLogo could not finish saving this document. The document change was cancelled; retry the save or export a .openlogo copy.",
    );
    this.name = "DocumentTransitionBlockedError";
  }
}

export class DocumentLibraryBusyError extends Error {
  constructor(operation: Exclude<DocumentLibraryOperation, null>) {
    super(`A document ${operation} operation is already running.`);
    this.name = "DocumentLibraryBusyError";
  }
}

function isRevisionConflict(error: unknown): error is DocumentRevisionConflict {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "DocumentRevisionConflict"
  );
}

export function documentLibraryErrorMessage(error: unknown): string {
  if (error instanceof DocumentTransitionBlockedError) {
    return error.message;
  }
  if (isRevisionConflict(error)) {
    return (
      "A newer local revision was found. This edit was preserved in Version " +
      "history, and the stored document was left unchanged."
    );
  }
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "LastUnarchivedDocumentError"
  ) {
    return "Keep at least one document available in the main library.";
  }
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "DocumentArchivedError"
  ) {
    return "operation" in error &&
      error.operation === "commit" &&
      "recoveryVersionId" in error &&
      typeof error.recoveryVersionId === "string"
      ? "This document was archived in another tab. Your edit was preserved in Version history; restore the document before editing it again."
      : "Restore this archived document before opening or editing it.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "The local document library could not complete that operation.";
}

function replaceSummary(
  summaries: readonly DocumentSummary[],
  summary: DocumentSummary,
): DocumentSummary[] {
  return sortDocumentSummaries([
    ...summaries.filter((item) => item.documentId !== summary.documentId),
    structuredClone(summary),
  ]);
}

/**
 * Coordinates the IndexedDB repository with the live DocumentSession.
 *
 * The controller deliberately stays outside React: autosave, optimistic
 * revisions, document switches, and recovery checkpoints remain serial and
 * testable while the UI observes one immutable snapshot.
 */
export class DocumentLibraryController {
  private readonly repository: DocumentRepository;
  private readonly thumbnailRenderer: (
    document: LogoDocument,
  ) => Promise<string>;
  private readonly thumbnailDelayMs: number;
  private session: DocumentSession | null = null;
  private activeRevision: number | null = null;
  /** Current head revision already protected by any recovery version. */
  private checkpointedRevision: number | null = null;
  /** Avoid cloning a large document into history on every 800 ms autosave. */
  private lastCheckpointAt = 0;
  private readonly listeners = new Set<() => void>();
  private thumbnailTimer: ReturnType<typeof setTimeout> | null = null;
  private thumbnailGeneration = 0;
  private readonly thumbnailBackfills = new Set<string>();
  private current: DocumentLibraryState = {
    ready: false,
    activeDocumentId: null,
    documents: [],
    folders: [],
    versions: [],
    operation: null,
    notice: null,
    error: null,
  };

  constructor(
    repository: DocumentRepository,
    options: {
      thumbnailRenderer?: (document: LogoDocument) => Promise<string>;
      thumbnailDelayMs?: number;
    } = {},
  ) {
    this.repository = repository;
    this.thumbnailRenderer =
      options.thumbnailRenderer ?? renderDocumentThumbnail;
    const thumbnailDelayMs = options.thumbnailDelayMs ?? 2_000;
    this.thumbnailDelayMs = Number.isFinite(thumbnailDelayMs)
      ? Math.max(0, thumbnailDelayMs)
      : 2_000;
  }

  get snapshot(): DocumentLibraryState {
    return this.current;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DocumentLibraryState => this.current;

  attachSession(session: DocumentSession): void {
    this.session = session;
  }

  detachSession(session: DocumentSession): void {
    if (this.session === session) {
      this.session = null;
    }
  }

  /** Hydrate dashboard metadata without loading a head or starting a session. */
  async bootstrapLibrary(initialDocument: LogoDocument): Promise<void> {
    try {
      const bootstrap = await runRepositoryEffect(
        this.repository.bootstrap(initialDocument),
      );
      this.activeRevision = null;
      this.checkpointedRevision = null;
      this.lastCheckpointAt = 0;
      this.update({
        ready: true,
        activeDocumentId: bootstrap.activeDocumentId,
        documents: bootstrap.documents,
        folders: bootstrap.folders,
        versions: [],
        notice: this.migrationNotice(bootstrap.migration),
        error: null,
      });
    } catch (error: unknown) {
      this.update({ ready: false, error: documentLibraryErrorMessage(error) });
      throw error;
    }
  }

  /** Bootstrap v3, migrate a legacy v1 current document, and load the head. */
  async loadActiveDocument(initialDocument: LogoDocument): Promise<LogoDocument> {
    await this.bootstrapLibrary(initialDocument);
    return this.openDocument(this.requireActiveDocumentId());
  }

  /** Load one dashboard selection and prepare its optimistic session revision. */
  async openDocument(documentId: string): Promise<LogoDocument> {
    return this.runOperation("switch", async () => {
      const loaded = await runRepositoryEffect(
        this.repository.loadDocument(documentId),
      );
      const versions = await runRepositoryEffect(
        this.repository.listVersions(documentId),
      );
      await runRepositoryEffect(this.repository.setActiveDocument(documentId));
      const documents = await runRepositoryEffect(
        this.repository.listDocuments(),
      );

      this.activeRevision = loaded.revision;
      this.checkpointedRevision = versions.some(
        (version) => version.sourceRevision === loaded.revision,
      )
        ? loaded.revision
        : null;
      this.lastCheckpointAt =
        this.checkpointedRevision === null ? 0 : Date.now();
      this.update({
        ready: true,
        activeDocumentId: documentId,
        documents,
        versions,
        error: null,
      });
      return loaded.document;
    });
  }

  /** DocumentSession save callback: checkpoint the old head, then CAS commit. */
  async saveDocument(document: LogoDocument): Promise<DocumentSaveResult> {
    const documentId = this.requireActiveDocumentId();
    const revision = this.requireActiveRevision();
    if (document.id !== documentId) {
      throw new Error(
        `Refusing to save document ${document.id} over active document ${documentId}.`,
      );
    }

    try {
      await this.ensureAutomaticCheckpoint(documentId, revision);
      const result = await runRepositoryEffect(
        this.repository.commitDocument({
          documentId,
          expectedRevision: revision,
          document,
        }),
      );
      this.activeRevision = result.revision;
      this.update({
        documents: replaceSummary(this.current.documents, result.summary),
        error: null,
      });
      this.scheduleThumbnail(document);
    } catch (error: unknown) {
      if (isRevisionConflict(error)) {
        try {
          const [authoritative, versions, documents] = await Promise.all([
            runRepositoryEffect(this.repository.loadDocument(documentId)),
            runRepositoryEffect(this.repository.listVersions(documentId)),
            runRepositoryEffect(this.repository.listDocuments()),
          ]);
          this.activeRevision = authoritative.revision;
          this.checkpointedRevision = versions.some(
            (version) => version.sourceRevision === authoritative.revision,
          )
            ? authoritative.revision
            : null;
          this.lastCheckpointAt =
            this.checkpointedRevision === null ? 0 : Date.now();
          this.update({
            documents,
            versions,
            error: documentLibraryErrorMessage(error),
          });
          return {
            status: "conflict-recovered",
            authoritativeDocument: authoritative.document,
            error,
          };
        } catch (reconcileError) {
          console.warn(
            "A concurrent document edit was preserved, but the authoritative head could not be reloaded.",
            reconcileError,
          );
        }
      }
      this.update({ error: documentLibraryErrorMessage(error) });
      throw error;
    }
  }

  async createDocument(document?: LogoDocument): Promise<LogoDocument> {
    return this.runOperation("create", async () => {
      if (this.session) {
        await this.requireSavedTransition();
      }
      const next = cloneLogoDocument(document ?? createInitialDocument());
      const result = await runRepositoryEffect(
        this.repository.createDocument({ document: next, makeActive: true }),
      );
      this.activeRevision = result.revision;
      this.checkpointedRevision = null;
      this.lastCheckpointAt = 0;
      this.session?.adoptDocument(next);
      this.update({
        activeDocumentId: next.id,
        documents: replaceSummary(this.current.documents, result.summary),
        versions: [],
        error: null,
      });
      return next;
    });
  }

  async duplicateActiveDocument(
    source: LogoDocument,
  ): Promise<LogoDocument> {
    return this.runOperation("duplicate", async () => {
      await this.requireSavedTransition();
      const duplicate = cloneLogoDocument(source);
      duplicate.id = createId("doc");
      duplicate.name = `${source.name.trim() || "Untitled OpenLogo"} copy`;
      const result = await runRepositoryEffect(
        this.repository.createDocument({
          document: duplicate,
          makeActive: true,
        }),
      );
      this.activeRevision = result.revision;
      this.checkpointedRevision = null;
      this.lastCheckpointAt = 0;
      this.session!.adoptDocument(duplicate);
      this.update({
        activeDocumentId: duplicate.id,
        documents: replaceSummary(this.current.documents, result.summary),
        versions: [],
        error: null,
      });
      return duplicate;
    });
  }

  /** Dashboard duplicate: clone any retained head without opening it. */
  async duplicateDocument(documentId: string): Promise<LogoDocument> {
    return this.runOperation("duplicate", async () => {
      const loaded = await runRepositoryEffect(
        this.repository.loadDocument(documentId),
      );
      const duplicate = cloneLogoDocument(loaded.document);
      duplicate.id = createId("doc");
      duplicate.name = `${duplicate.name.trim() || "Untitled OpenLogo"} copy`;
      const result = await runRepositoryEffect(
        this.repository.createDocument({
          document: duplicate,
          makeActive: false,
        }),
      );
      this.update({
        documents: replaceSummary(this.current.documents, result.summary),
        error: null,
      });
      return duplicate;
    });
  }

  /** Dashboard rename: commit the selected head with optimistic revision. */
  async renameDocument(
    documentId: string,
    name: string,
  ): Promise<DocumentSummary> {
    return this.runOperation("rename", async () => {
      const normalized = name.trim().slice(0, 120);
      if (!normalized) {
        throw new Error("Document name cannot be empty.");
      }
      const loaded = await runRepositoryEffect(
        this.repository.loadDocument(documentId),
      );
      const result = await runRepositoryEffect(
        this.repository.commitDocument({
          documentId,
          expectedRevision: loaded.revision,
          document: { ...loaded.document, name: normalized },
        }),
      );
      if (documentId === this.current.activeDocumentId) {
        this.activeRevision = result.revision;
      }
      this.update({
        documents: replaceSummary(this.current.documents, result.summary),
        error: null,
      });
      return result.summary;
    });
  }

  /** Imported files become independent documents; an id collision creates a copy. */
  async importDocument(input: LogoDocument): Promise<LogoDocument> {
    return this.runOperation("import", async () => {
      if (this.session) {
        await this.requireSavedTransition();
      }
      const document = cloneLogoDocument(input);
      if (
        this.current.documents.some(
          (summary) => summary.documentId === document.id,
        )
      ) {
        document.id = createId("doc");
        document.name = `${document.name.trim() || "Untitled OpenLogo"} import`;
      }
      const result = await runRepositoryEffect(
        this.repository.createDocument({ document, makeActive: true }),
      );
      this.activeRevision = result.revision;
      this.checkpointedRevision = null;
      this.lastCheckpointAt = 0;
      this.session?.adoptDocument(document);
      this.update({
        activeDocumentId: document.id,
        documents: replaceSummary(this.current.documents, result.summary),
        versions: [],
        error: null,
      });
      return document;
    });
  }

  async switchDocument(documentId: string): Promise<LogoDocument> {
    if (documentId === this.current.activeDocumentId) {
      return this.sessionDocument();
    }
    return this.runOperation("switch", async () => {
      await this.requireSavedTransition();
      const [loaded, versions] = await Promise.all([
        runRepositoryEffect(this.repository.loadDocument(documentId)),
        runRepositoryEffect(this.repository.listVersions(documentId)),
      ]);
      await runRepositoryEffect(this.repository.setActiveDocument(documentId));

      this.activeRevision = loaded.revision;
      this.checkpointedRevision = versions.some(
        (version) => version.sourceRevision === loaded.revision,
      )
        ? loaded.revision
        : null;
      this.lastCheckpointAt =
        this.checkpointedRevision === null ? 0 : Date.now();
      this.session!.adoptDocument(loaded.document);
      this.update({
        activeDocumentId: documentId,
        versions,
        error: null,
      });
      return loaded.document;
    });
  }

  /**
   * Archive without deleting. Archiving the active head flushes first, then
   * adopts the repository-selected next head only after the atomic write.
   */
  async archiveDocument(documentId: string): Promise<{
    archivedSummary: DocumentSummary;
    activeDocument: LogoDocument | null;
  }> {
    return this.runOperation("archive", async () => {
      const wasActive = documentId === this.requireActiveDocumentId();
      if (wasActive && this.session) {
        await this.requireSavedTransition();
      }

      const result = await runRepositoryEffect(
        this.repository.archiveDocument(documentId),
      );
      let adopted: LogoDocument | null = null;
      let versions = this.current.versions;
      if (result.activeDocumentId !== this.current.activeDocumentId) {
        adopted = result.activeDocument.document;
        this.activeRevision = result.activeDocument.revision;
        this.checkpointedRevision = null;
        this.lastCheckpointAt = 0;
        this.session?.adoptDocument(adopted);
        try {
          versions = await runRepositoryEffect(
            this.repository.listVersions(result.activeDocumentId),
          );
          this.checkpointedRevision = versions.some(
            (version) =>
              version.sourceRevision === result.activeDocument.revision,
          )
            ? result.activeDocument.revision
            : null;
          this.lastCheckpointAt =
            this.checkpointedRevision === null ? 0 : Date.now();
        } catch (versionError) {
          versions = [];
          console.warn(
            "The next document opened, but its version history could not be loaded.",
            versionError,
          );
        }
      }

      this.update({
        activeDocumentId: result.activeDocumentId,
        documents: result.documents,
        versions,
        error: null,
      });
      return {
        archivedSummary: result.archivedSummary,
        activeDocument: adopted,
      };
    });
  }

  /** Unarchive only; the user explicitly opens the restored document later. */
  async restoreArchivedDocument(
    documentId: string,
  ): Promise<DocumentSummary> {
    return this.runOperation("unarchive", async () => {
      const summary = await runRepositoryEffect(
        this.repository.restoreArchivedDocument(documentId),
      );
      this.update({
        documents: replaceSummary(this.current.documents, summary),
        error: null,
      });
      return summary;
    });
  }

  async createFolder(name: string): Promise<DocumentFolder> {
    return this.runOperation("folder", async () => {
      const folder = await runRepositoryEffect(
        this.repository.createFolder(name),
      );
      this.update({
        folders: sortDocumentFolders([...this.current.folders, folder]),
        error: null,
      });
      return folder;
    });
  }

  async renameFolder(folderId: string, name: string): Promise<DocumentFolder> {
    return this.runOperation("folder", async () => {
      const folder = await runRepositoryEffect(
        this.repository.renameFolder(folderId, name),
      );
      this.update({
        folders: sortDocumentFolders([
          ...this.current.folders.filter((item) => item.folderId !== folderId),
          folder,
        ]),
        error: null,
      });
      return folder;
    });
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.runOperation("folder", async () => {
      await runRepositoryEffect(this.repository.deleteFolder(folderId));
      this.update({
        folders: this.current.folders.filter(
          (folder) => folder.folderId !== folderId,
        ),
        documents: this.current.documents.map((summary) =>
          summary.folderId === folderId
            ? { ...summary, folderId: null }
            : summary,
        ),
        error: null,
      });
    });
  }

  async moveDocument(
    documentId: string,
    folderId: string | null,
  ): Promise<DocumentSummary> {
    return this.runOperation("move", async () => {
      const summary = await runRepositoryEffect(
        this.repository.moveDocument(documentId, folderId),
      );
      this.update({
        documents: replaceSummary(this.current.documents, summary),
        error: null,
      });
      return summary;
    });
  }

  /** Best-effort legacy thumbnail fill; never occupies the UI operation slot. */
  async backfillThumbnail(documentId: string): Promise<void> {
    const initialSummary = this.current.documents.find(
      (summary) => summary.documentId === documentId,
    );
    if (
      !initialSummary ||
      initialSummary.thumbnail ||
      this.thumbnailBackfills.has(documentId)
    ) {
      return;
    }

    this.thumbnailBackfills.add(documentId);
    try {
      const loaded = await runRepositoryEffect(
        this.repository.loadDocument(documentId),
      );
      const dataUrl = await this.thumbnailRenderer(loaded.document);
      const latest = await runRepositoryEffect(
        this.repository.loadDocument(documentId),
      );
      const currentSummary = this.current.documents.find(
        (summary) => summary.documentId === documentId,
      );
      if (
        !currentSummary ||
        currentSummary.thumbnail ||
        currentSummary.revision !== loaded.revision ||
        latest.revision !== loaded.revision
      ) {
        return;
      }
      const summary = await runRepositoryEffect(
        this.repository.setThumbnail(documentId, dataUrl),
      );
      this.update({
        documents: replaceSummary(this.current.documents, summary),
      });
    } catch {
      // Derived previews are optional. Keep the placeholder without surfacing
      // repository or rendering failures to the dashboard.
    } finally {
      this.thumbnailBackfills.delete(documentId);
    }
  }

  async flushRename(): Promise<void> {
    await this.runOperation("rename", async () => {
      await this.requireSavedTransition();
    });
  }

  async createNamedVersion(label: string): Promise<DocumentVersion> {
    const normalized = label.trim();
    if (!normalized) {
      throw new Error("Enter a version name first.");
    }
    return this.runOperation("version", async () => {
      await this.requireSavedTransition();
      const documentId = this.requireActiveDocumentId();
      const version = await runRepositoryEffect(
        this.repository.createVersion({
          documentId,
          kind: "named",
          label: normalized.slice(0, 80),
        }),
      );
      this.checkpointedRevision = this.activeRevision;
      this.lastCheckpointAt = Date.now();
      this.update({
        versions: sortDocumentVersions([
          ...this.current.versions,
          version,
        ]),
        error: null,
      });
      return version;
    });
  }

  /** Commit the selected snapshot first; only then replace the live canvas. */
  async restoreVersion(versionId: string): Promise<LogoDocument> {
    return this.runOperation("restore", async () => {
      await this.requireSavedTransition();
      const documentId = this.requireActiveDocumentId();
      const versions = await runRepositoryEffect(
        this.repository.listVersions(documentId),
      );
      const version = versions.find((item) => item.versionId === versionId);
      if (!version) {
        throw new Error("That recovery version no longer exists.");
      }

      // Protect the current head, then atomically advance it to the selected
      // snapshot. The live store changes only after the repository succeeds.
      await this.ensureAutomaticCheckpoint(
        documentId,
        this.requireActiveRevision(),
        true,
      );
      const result = await runRepositoryEffect(
        this.repository.commitDocument({
          documentId,
          expectedRevision: this.requireActiveRevision(),
          document: version.document,
        }),
      );
      this.activeRevision = result.revision;
      this.session!.adoptDocument(version.document);
      this.update({
        documents: replaceSummary(this.current.documents, result.summary),
        error: null,
      });
      await this.refreshVersionsBestEffort(documentId);
      return version.document;
    });
  }

  clearError(): void {
    if (this.current.error) {
      this.update({ error: null });
    }
  }

  /** Flush editor commits before its runtime is torn down for the dashboard. */
  async prepareForDashboard(): Promise<void> {
    if (this.session) {
      await this.requireSavedTransition();
    }
  }

  private async ensureAutomaticCheckpoint(
    documentId: string,
    revision: number,
    force = false,
  ): Promise<void> {
    if (this.checkpointedRevision === revision) {
      return;
    }
    if (
      !force &&
      this.lastCheckpointAt > 0 &&
      Date.now() - this.lastCheckpointAt < 30_000
    ) {
      return;
    }

    // A checkpoint is best effort: head persistence must not be blocked by a
    // version-history quota failure. A failed head commit still propagates.
    try {
      const version = await runRepositoryEffect(
        this.repository.createVersion({
          documentId,
          kind: "automatic",
          label: null,
        }),
      );
      this.checkpointedRevision = revision;
      this.lastCheckpointAt = Date.now();
      this.update({
        versions: sortDocumentVersions([
          ...this.current.versions.filter(
            (item) => item.versionId !== version.versionId,
          ),
          version,
        ]).filter((item, _index, all) => {
          if (item.kind !== "automatic") {
            return true;
          }
          // Repository retention is authoritative; keep the UI bounded too.
          return (
            all
              .filter((candidate) => candidate.kind === "automatic")
              .findIndex(
                (candidate) => candidate.versionId === item.versionId,
              ) < DEFAULT_AUTOMATIC_VERSION_LIMIT
          );
        }),
      });
    } catch (error) {
      console.warn("Could not create an automatic recovery version.", error);
    }
  }

  private async requireSavedTransition(): Promise<void> {
    if (!this.session) {
      throw new Error("The document session is not ready.");
    }
    await this.session.flush();
    if (this.session.state !== "saved") {
      throw new DocumentTransitionBlockedError();
    }
  }

  private async refreshVersionsBestEffort(documentId: string): Promise<void> {
    try {
      const versions = await runRepositoryEffect(
        this.repository.listVersions(documentId),
      );
      this.update({ versions });
    } catch (refreshError) {
      console.warn("Could not refresh recovery versions.", refreshError);
    }
  }

  private scheduleThumbnail(document: LogoDocument): void {
    this.thumbnailGeneration += 1;
    const generation = this.thumbnailGeneration;
    if (this.thumbnailTimer) {
      clearTimeout(this.thumbnailTimer);
    }
    const snapshot = cloneLogoDocument(document);
    this.thumbnailTimer = setTimeout(() => {
      this.thumbnailTimer = null;
      void this.generateThumbnail(snapshot, generation);
    }, this.thumbnailDelayMs);
  }

  private async generateThumbnail(
    document: LogoDocument,
    generation: number,
  ): Promise<void> {
    try {
      const dataUrl = await this.thumbnailRenderer(document);
      if (generation !== this.thumbnailGeneration) {
        return;
      }
      const summary = await runRepositoryEffect(
        this.repository.setThumbnail(document.id, dataUrl),
      );
      if (generation === this.thumbnailGeneration) {
        this.update({
          documents: replaceSummary(this.current.documents, summary),
        });
      }
    } catch (error) {
      console.warn("Could not update the document thumbnail.", error);
    }
  }

  private async runOperation<A>(
    operation: Exclude<DocumentLibraryOperation, null>,
    run: () => Promise<A>,
  ): Promise<A> {
    if (this.current.operation) {
      throw new DocumentLibraryBusyError(this.current.operation);
    }
    this.update({ operation, error: null });
    try {
      return await run();
    } catch (error: unknown) {
      this.update({ error: documentLibraryErrorMessage(error) });
      throw error;
    } finally {
      this.update({ operation: null });
    }
  }

  private requireActiveDocumentId(): string {
    if (!this.current.activeDocumentId) {
      throw new Error("The local document library has not loaded yet.");
    }
    return this.current.activeDocumentId;
  }

  private requireActiveRevision(): number {
    if (this.activeRevision === null) {
      throw new Error("The active document revision is unavailable.");
    }
    return this.activeRevision;
  }

  private sessionDocument(): LogoDocument {
    if (!this.session) {
      throw new Error("The document session is not ready.");
    }
    return this.session.document;
  }

  private migrationNotice(migration: LegacyMigrationResult): string | null {
    if (migration.status === "migrated") {
      return "Your previous local document was migrated into the Document library and preserved as a recovery version.";
    }
    if (migration.status === "blocked") {
      return migration.reason;
    }
    return null;
  }

  private update(patch: Partial<DocumentLibraryState>): void {
    this.current = {
      ...this.current,
      ...patch,
      documents:
        patch.documents === undefined
          ? this.current.documents
          : patch.documents,
      folders:
        patch.folders === undefined ? this.current.folders : patch.folders,
      versions:
        patch.versions === undefined
          ? this.current.versions
          : patch.versions,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const documentLibrary = new DocumentLibraryController(
  new IndexedDbDocumentRepository(),
);
