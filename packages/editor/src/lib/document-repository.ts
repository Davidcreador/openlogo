import { Data, Effect } from "effect";
import { parseDocument, type LogoDocument } from "@openlogo/core";

export const DEFAULT_AUTOMATIC_VERSION_LIMIT = 20;

export type DocumentVersionKind =
  | "automatic"
  | "named"
  | "migration"
  | "conflict"
  | "deleted";

export type DocumentSummary = {
  documentId: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  /** Null/missing in pre-archive repositories; archived heads remain recoverable. */
  archivedAt: number | null;
  activeArtboardName: string;
  activeArtboardWidth: number;
  activeArtboardHeight: number;
  /** Derived PNG preview; updating it never advances the document head. */
  thumbnail: string | null;
  /** Null means the Document Library root. */
  folderId: string | null;
};

export type DocumentFolder = {
  folderId: string;
  name: string;
  createdAt: number;
};

export type LoadedDocument = {
  document: LogoDocument;
  revision: number;
};

export type DocumentVersion = {
  versionId: string;
  documentId: string;
  kind: DocumentVersionKind;
  label: string | null;
  createdAt: number;
  sourceRevision: number;
  document: LogoDocument;
};

export type LegacyMigrationResult =
  | { status: "none" }
  | { status: "migrated"; documentId: string }
  | { status: "blocked"; reason: string };

export type DocumentRepositoryBootstrap = {
  activeDocumentId: string;
  documents: DocumentSummary[];
  folders: DocumentFolder[];
  migration: LegacyMigrationResult;
};

export type CreateDocumentRequest = {
  document: LogoDocument;
  makeActive?: boolean;
};

export type CommitDocumentRequest = {
  documentId: string;
  expectedRevision: number;
  document: LogoDocument;
};

export type CommitDocumentResult = {
  revision: number;
  summary: DocumentSummary;
};

export type CreateVersionRequest = {
  documentId: string;
  kind: DocumentVersionKind;
  label?: string | null;
};

export type ArchiveDocumentResult = {
  archivedSummary: DocumentSummary;
  /** Always points at an unarchived head after the atomic transaction. */
  activeDocumentId: string;
  activeDocument: LoadedDocument;
  /** Complete detached summary snapshot after the archive. */
  documents: DocumentSummary[];
};

export type DocumentRepositoryOperation =
  | "open"
  | "upgrade"
  | "read"
  | "write"
  | "decode"
  | "migrate";

export class DocumentRepositoryError extends Data.TaggedError(
  "DocumentRepositoryError",
)<{
  readonly operation: DocumentRepositoryOperation;
  readonly cause: unknown;
}> {}

export class DocumentNotFoundError extends Data.TaggedError(
  "DocumentNotFoundError",
)<{
  readonly documentId: string;
}> {}

export class FolderNotFoundError extends Data.TaggedError(
  "FolderNotFoundError",
)<{
  readonly folderId: string;
}> {}

export class DocumentAlreadyExistsError extends Data.TaggedError(
  "DocumentAlreadyExistsError",
)<{
  readonly documentId: string;
}> {}

export class DocumentIdMismatchError extends Data.TaggedError(
  "DocumentIdMismatchError",
)<{
  readonly documentId: string;
  readonly payloadDocumentId: string;
}> {}

export class DocumentRevisionConflict extends Data.TaggedError(
  "DocumentRevisionConflict",
)<{
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  /** Incoming snapshot preserved without replacing the authoritative head. */
  readonly recoveryVersionId: string;
}> {}

export class DocumentArchivedError extends Data.TaggedError(
  "DocumentArchivedError",
)<{
  readonly documentId: string;
  readonly operation: "activate" | "commit";
  /** Present for rejected commits whose incoming snapshot was preserved. */
  readonly recoveryVersionId?: string;
}> {}

export class LastUnarchivedDocumentError extends Data.TaggedError(
  "LastUnarchivedDocumentError",
)<{
  readonly documentId: string;
}> {}

export type DocumentRepositoryFailure =
  | DocumentRepositoryError
  | DocumentNotFoundError
  | FolderNotFoundError
  | DocumentAlreadyExistsError
  | DocumentIdMismatchError
  | DocumentRevisionConflict
  | DocumentArchivedError
  | LastUnarchivedDocumentError;

/**
 * Persistence seam for the local Document Library. Implementations own
 * transactions, cloning, optimistic revisions, migration, and retention.
 */
export interface DocumentRepository {
  bootstrap(
    initialDocument: LogoDocument,
  ): Effect.Effect<DocumentRepositoryBootstrap, DocumentRepositoryFailure>;

  listDocuments(): Effect.Effect<
    DocumentSummary[],
    DocumentRepositoryFailure
  >;

  loadDocument(
    documentId: string,
  ): Effect.Effect<LoadedDocument, DocumentRepositoryFailure>;

  createDocument(
    request: CreateDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure>;

  commitDocument(
    request: CommitDocumentRequest,
  ): Effect.Effect<CommitDocumentResult, DocumentRepositoryFailure>;

  /** Replace derived preview metadata without advancing the head revision. */
  setThumbnail(
    documentId: string,
    dataUrl: string,
  ): Effect.Effect<DocumentSummary, DocumentRepositoryFailure>;

  createFolder(
    name: string,
  ): Effect.Effect<DocumentFolder, DocumentRepositoryFailure>;

  renameFolder(
    folderId: string,
    name: string,
  ): Effect.Effect<DocumentFolder, DocumentRepositoryFailure>;

  /** Delete folder metadata and move its documents back to the root. */
  deleteFolder(
    folderId: string,
  ): Effect.Effect<void, DocumentRepositoryFailure>;

  moveDocument(
    documentId: string,
    folderId: string | null,
  ): Effect.Effect<DocumentSummary, DocumentRepositoryFailure>;

  setActiveDocument(
    documentId: string,
  ): Effect.Effect<void, DocumentRepositoryFailure>;

  /** Archive without deleting; active switches atomically when necessary. */
  archiveDocument(
    documentId: string,
  ): Effect.Effect<ArchiveDocumentResult, DocumentRepositoryFailure>;

  /** Return an archived head to the main library without activating it. */
  restoreArchivedDocument(
    documentId: string,
  ): Effect.Effect<DocumentSummary, DocumentRepositoryFailure>;

  createVersion(
    request: CreateVersionRequest,
  ): Effect.Effect<DocumentVersion, DocumentRepositoryFailure>;

  listVersions(
    documentId: string,
  ): Effect.Effect<DocumentVersion[], DocumentRepositoryFailure>;
}

export function cloneLogoDocument(document: LogoDocument): LogoDocument {
  return structuredClone(document);
}

/** Validate every persistence-boundary snapshot before it can replace a head. */
export function decodeRepositoryDocument(data: unknown): LogoDocument {
  try {
    return parseDocument(data);
  } catch (cause) {
    throw new DocumentRepositoryError({ operation: "decode", cause });
  }
}

export function assertDocumentId(
  documentId: string,
  document: LogoDocument,
): Effect.Effect<void, DocumentIdMismatchError> {
  return document.id === documentId
    ? Effect.void
    : Effect.fail(
        new DocumentIdMismatchError({
          documentId,
          payloadDocumentId: document.id,
        }),
      );
}

export function documentSummary(
  document: LogoDocument,
  revision: number,
  createdAt: number,
  updatedAt: number,
  lastOpenedAt = updatedAt,
  archivedAt: number | null = null,
  thumbnail: string | null = null,
  folderId: string | null = null,
): DocumentSummary {
  const activeArtboard =
    document.artboards.find(
      (artboard) => artboard.id === document.activeArtboardId,
    ) ?? document.artboards[0];

  if (!activeArtboard) {
    throw new Error(`Document ${document.id} has no artboards.`);
  }

  return {
    documentId: document.id,
    name: document.name,
    revision,
    createdAt,
    updatedAt,
    lastOpenedAt,
    archivedAt,
    activeArtboardName: activeArtboard.name,
    activeArtboardWidth: activeArtboard.width,
    activeArtboardHeight: activeArtboard.height,
    thumbnail,
    folderId,
  };
}

/** Backward-compatible read for summaries written before archive/dashboard metadata. */
export function normalizeDocumentSummary(
  summary:
    | DocumentSummary
    | (Omit<
        DocumentSummary,
        "archivedAt" | "thumbnail" | "folderId"
      > & {
        archivedAt?: unknown;
        thumbnail?: unknown;
        folderId?: unknown;
      }),
): DocumentSummary {
  return {
    ...structuredClone(summary),
    archivedAt:
      typeof summary.archivedAt === "number" &&
      Number.isFinite(summary.archivedAt)
        ? summary.archivedAt
        : null,
    thumbnail:
      typeof summary.thumbnail === "string" && isPngDataUrl(summary.thumbnail)
        ? summary.thumbnail
        : null,
    folderId: typeof summary.folderId === "string" ? summary.folderId : null,
  } as DocumentSummary;
}

export function isPngDataUrl(value: string): boolean {
  return /^data:image\/png(?:;[^,]*)?,/i.test(value);
}

export function sortDocumentFolders(
  folders: readonly DocumentFolder[],
): DocumentFolder[] {
  return folders
    .map((folder) => structuredClone(folder))
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt || a.folderId.localeCompare(b.folderId),
    );
}

export function sortDocumentSummaries(
  summaries: readonly DocumentSummary[],
): DocumentSummary[] {
  return summaries.map(normalizeDocumentSummary).sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || a.documentId.localeCompare(b.documentId),
  );
}

export function sortDocumentVersions(
  versions: readonly DocumentVersion[],
): DocumentVersion[] {
  return [...versions].sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      b.versionId.localeCompare(a.versionId),
  );
}

export function isDocumentRepositoryFailure(
  cause: unknown,
): cause is DocumentRepositoryFailure {
  if (!cause || typeof cause !== "object" || !("_tag" in cause)) {
    return false;
  }
  return [
    "DocumentRepositoryError",
    "DocumentNotFoundError",
    "FolderNotFoundError",
    "DocumentAlreadyExistsError",
    "DocumentIdMismatchError",
    "DocumentRevisionConflict",
    "DocumentArchivedError",
    "LastUnarchivedDocumentError",
  ].includes(String(cause._tag));
}
