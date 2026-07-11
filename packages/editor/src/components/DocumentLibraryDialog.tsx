import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Archive,
  Check,
  Clock3,
  Copy,
  FileText,
  FilePlus2,
  History,
  RotateCcw,
  X,
} from "lucide-react";
import {
  createInitialDocument,
  getActiveArtboard,
  type LogoDocument,
} from "@openlogo/core";
import { fitBounds } from "@openlogo/renderer";
import {
  documentLibrary,
  documentLibraryErrorMessage,
  type DocumentLibraryOperation,
} from "../lib/document-library";
import type { DocumentVersion } from "../lib/document-repository";
import { ensureDocumentFonts } from "../lib/text-to-path";
import { useModalDialog } from "../lib/use-modal-dialog";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const SECONDARY_BUTTON =
  "inline-flex h-30 items-center justify-center gap-6 rounded-field border border-field-border bg-card px-10 text-[12px] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-default disabled:opacity-40";
const PRIMARY_BUTTON =
  "inline-flex h-30 items-center justify-center gap-6 rounded-field bg-accent px-11 text-[12px] font-semibold text-white transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-default disabled:opacity-45";
const INPUT =
  "h-30 min-w-0 rounded-field border border-field-border bg-field px-9 text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const DOCUMENT_LIBRARY_TITLE_ID = "document-library-title";
const DOCUMENT_LIBRARY_DESCRIPTION_ID = "document-library-description";

function operationLabel(operation: DocumentLibraryOperation): string {
  switch (operation) {
    case "create":
      return "Creating document…";
    case "duplicate":
      return "Duplicating document…";
    case "import":
      return "Importing document…";
    case "rename":
      return "Renaming document…";
    case "switch":
      return "Switching document…";
    case "archive":
      return "Archiving document…";
    case "unarchive":
      return "Restoring document…";
    case "version":
      return "Saving version…";
    case "restore":
      return "Restoring version…";
    default:
      return "";
  }
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function versionLabel(version: DocumentVersion): string {
  if (version.label) {
    return version.label;
  }
  switch (version.kind) {
    case "automatic":
      return "Automatic recovery";
    case "migration":
      return "Migrated local document";
    case "conflict":
      return "Concurrent edit recovery";
    case "deleted":
      return "Deleted document recovery";
    default:
      return "Saved version";
  }
}

function resetEditorContext(document: LogoDocument): void {
  documentStore.cancelPreview();
  const editor = useEditorStore.getState();
  editor.setSelection([]);
  editor.setActiveGroupId(null);
  editor.setEditingPathId(null);
  editor.setTool("select");
  editor.setDesignMateReview(null);
  editor.setDesignMateCanvasFocus(null);
  editor.setDesignMateStatus("idle");
  editor.setDesignMateError(null);
  const activeArtboard = getActiveArtboard(document);
  if (editor.viewport.width > 0 && editor.viewport.height > 0) {
    editor.setCamera(
      fitBounds(
        activeArtboard,
        editor.viewport.width,
        editor.viewport.height,
      ),
    );
  }
  ensureDocumentFonts();
}

function nextUntitledName(names: readonly string[]): string {
  const used = new Set(names.map((name) => name.toLocaleLowerCase()));
  const base = "Untitled OpenLogo";
  if (!used.has(base.toLocaleLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLocaleLowerCase())) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

export function DocumentLibraryDialog() {
  const open = useEditorStore((state) => state.documentLibraryOpen);
  const setOpen = useEditorStore((state) => state.setDocumentLibraryOpen);
  const setToast = useEditorStore((state) => state.setToast);
  const library = useSyncExternalStore(
    documentLibrary.subscribe,
    documentLibrary.getSnapshot,
  );
  const active = library.documents.find(
    (summary) =>
      summary.documentId === library.activeDocumentId &&
      summary.archivedAt === null,
  );
  const availableDocuments = library.documents.filter(
    (summary) => summary.archivedAt === null,
  );
  const archivedDocuments = library.documents.filter(
    (summary) => summary.archivedAt !== null,
  );
  const [nameDraft, setNameDraft] = useState("");
  const [versionDraft, setVersionDraft] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const busy = library.operation !== null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  function requestClose() {
    if (busy) {
      return;
    }
    if (confirmRestoreId) {
      setConfirmRestoreId(null);
      return;
    }
    if (confirmArchiveId) {
      setConfirmArchiveId(null);
      return;
    }
    setOpen(false);
  }

  useModalDialog({
    open,
    onClose: requestClose,
    dialogRef,
    initialFocusRef,
  });

  useEffect(() => {
    setNameDraft(active?.name ?? "");
  }, [active?.documentId, active?.name]);

  useEffect(() => {
    if (!open) {
      setConfirmRestoreId(null);
      setConfirmArchiveId(null);
      setVersionDraft("");
      documentLibrary.clearError();
    }
  }, [open]);

  if (!open) {
    if (!library.operation) {
      return null;
    }
    return (
      <div
        className="fixed inset-0 z-50 grid cursor-wait place-items-center bg-[rgb(16_14_20/0.28)]"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy="true"
      >
        <span className="rounded-[9px] border border-chrome-hairline bg-chrome px-14 py-9 text-[12.5px] text-chrome-text shadow-[0_4px_16px_rgb(8_6_12/0.4)]">
          {operationLabel(library.operation)}
        </span>
      </div>
    );
  }

  function reportFailure(error: unknown) {
    console.warn("Document library operation failed", error);
    setToast(documentLibraryErrorMessage(error));
  }

  async function createDocument() {
    const document = createInitialDocument();
    document.name = nextUntitledName(
      library.documents.map((summary) => summary.name),
    );
    try {
      const created = await documentLibrary.createDocument(document);
      resetEditorContext(created);
      setToast(`Created “${created.name}”.`);
      setOpen(false);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function duplicateDocument() {
    try {
      const duplicate = await documentLibrary.duplicateActiveDocument(
        documentStore.committedDocument,
      );
      resetEditorContext(duplicate);
      setToast(`Created “${duplicate.name}”.`);
      setOpen(false);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function switchDocument(documentId: string) {
    if (documentId === library.activeDocumentId) {
      return;
    }
    try {
      const document = await documentLibrary.switchDocument(documentId);
      resetEditorContext(document);
      setToast(`Opened “${document.name}”.`);
      setOpen(false);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function renameDocument() {
    const name = nameDraft.trim();
    if (!name || !active) {
      setNameDraft(active?.name ?? "");
      return;
    }
    if (name === active.name) {
      return;
    }
    documentStore.apply({ type: "rename-document", name: name.slice(0, 120) });
    try {
      await documentLibrary.flushRename();
      setToast(`Renamed document to “${name.slice(0, 120)}”.`);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function saveNamedVersion() {
    const label = versionDraft.trim();
    if (!label) {
      setToast("Enter a version name first.");
      return;
    }
    try {
      await documentLibrary.createNamedVersion(label);
      setVersionDraft("");
      setToast(`Saved version “${label.slice(0, 80)}”.`);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function restoreVersion(version: DocumentVersion) {
    if (confirmRestoreId !== version.versionId) {
      setConfirmRestoreId(version.versionId);
      return;
    }
    try {
      const document = await documentLibrary.restoreVersion(version.versionId);
      resetEditorContext(document);
      setToast(`Restored “${versionLabel(version)}”.`);
      setOpen(false);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function archiveDocument(summary: (typeof library.documents)[number]) {
    if (confirmArchiveId !== summary.documentId) {
      setConfirmArchiveId(summary.documentId);
      return;
    }
    try {
      const result = await documentLibrary.archiveDocument(summary.documentId);
      setConfirmArchiveId(null);
      if (result.activeDocument) {
        resetEditorContext(result.activeDocument);
        setToast(
          `Archived “${summary.name}” and opened “${result.activeDocument.name}”.`,
        );
        setOpen(false);
      } else {
        setToast(`Archived “${summary.name}”.`);
      }
    } catch (error) {
      reportFailure(error);
    }
  }

  async function restoreArchivedDocument(
    summary: (typeof library.documents)[number],
  ) {
    try {
      await documentLibrary.restoreArchivedDocument(summary.documentId);
      setToast(`Restored “${summary.name}” to Documents.`);
    } catch (error) {
      reportFailure(error);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="overlay-in fixed inset-0 z-50 grid place-items-center bg-[rgb(16_14_20/0.68)] p-20 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={DOCUMENT_LIBRARY_TITLE_ID}
      aria-describedby={DOCUMENT_LIBRARY_DESCRIPTION_ID}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          requestClose();
        }
      }}
    >
      <section
        className="dialog-in flex max-h-[min(720px,calc(100vh-40px))] w-[min(880px,calc(100vw-40px))] flex-col overflow-hidden rounded-panel border border-panel-hairline bg-panel shadow-[0_28px_90px_rgb(0_0_0/0.52)]"
        aria-busy={busy}
      >
        <header className="flex items-center justify-between border-b border-panel-hairline px-18 py-14">
          <div>
            <h2
              id={DOCUMENT_LIBRARY_TITLE_ID}
              className="m-0 text-[15px] font-[680] text-ink"
            >
              Documents
            </h2>
            <p
              id={DOCUMENT_LIBRARY_DESCRIPTION_ID}
              className="mb-0 mt-3 text-[11.5px] text-ink-dim"
            >
              Local-first files with automatic recovery and named versions
            </p>
          </div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={requestClose}
            disabled={busy}
            aria-label="Close document library"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        {library.notice && (
          <div
            className="border-b border-[rgb(72_107_255/0.22)] bg-[rgb(72_107_255/0.08)] px-18 py-9 text-[11.5px] text-ink-dim"
            role="status"
          >
            {library.notice}
          </div>
        )}
        {library.error && (
          <div
            className="border-b border-red-500/20 bg-red-500/8 px-18 py-9 text-[11.5px] text-red-700"
            role="alert"
          >
            {library.error}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(260px,0.9fr)_minmax(360px,1.35fr)] md:overflow-hidden">
          <div className="flex min-h-[240px] max-h-[280px] flex-col border-b border-panel-hairline p-14 md:min-h-0 md:max-h-none md:border-b-0 md:border-r">
            <div className="mb-10 flex gap-7">
              <button
                ref={initialFocusRef}
                type="button"
                className={`${PRIMARY_BUTTON} flex-1`}
                onClick={() => void createDocument()}
                disabled={busy}
              >
                <FilePlus2 size={14} aria-hidden="true" /> New document
              </button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void duplicateDocument()}
                disabled={busy || !active}
                title="Duplicate active document"
              >
                <Copy size={14} aria-hidden="true" /> Duplicate
              </button>
            </div>

            <p className="sr-only" role="status" aria-live="polite">
              {confirmArchiveId
                ? "Archive requested. Activate Confirm archive to move this document to Archived, or press Escape to cancel."
                : ""}
            </p>
            <div className="min-h-0 flex-1 space-y-8 overflow-y-auto pr-3">
              <section aria-labelledby="available-documents-heading">
                <h3
                  id="available-documents-heading"
                  className="mb-6 mt-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint"
                >
                  Documents · {availableDocuments.length}
                </h3>
                <div className="space-y-6">
                  {availableDocuments.map((document) => {
                    const selected =
                      document.documentId === library.activeDocumentId;
                    const confirming =
                      confirmArchiveId === document.documentId;
                    return (
                      <div key={document.documentId} className="space-y-4">
                        <div className="flex items-stretch gap-5">
                          <button
                            type="button"
                            className={`group flex min-w-0 flex-1 items-start gap-9 rounded-m border px-10 py-9 text-left transition-[border-color,background-color] duration-120 ease-studio ${
                              selected
                                ? "border-accent/55 bg-accent/8"
                                : "border-panel-hairline bg-card/45 hover:border-field-border hover:bg-card"
                            }`}
                            onClick={() => {
                              setConfirmArchiveId(null);
                              void switchDocument(document.documentId);
                            }}
                            disabled={busy}
                            aria-current={selected ? "page" : undefined}
                            aria-pressed={selected}
                          >
                            <span
                              className={`mt-1 grid h-24 w-24 shrink-0 place-items-center rounded-[7px] ${
                                selected
                                  ? "bg-accent text-white"
                                  : "bg-field text-ink-dim"
                              }`}
                            >
                              {selected ? (
                                <Check size={13} aria-hidden="true" />
                              ) : (
                                <FileText size={13} aria-hidden="true" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <strong className="block truncate text-[12.5px] font-[620] text-ink">
                                {document.name}
                              </strong>
                              <small className="mt-2 block text-[10.5px] text-ink-dim">
                                {document.activeArtboardWidth} ×{" "}
                                {document.activeArtboardHeight}
                                {" · r"}
                                {document.revision}
                              </small>
                              <small className="mt-1 block text-[10px] text-ink-faint">
                                Updated {formatTimestamp(document.updatedAt)}
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`${SECONDARY_BUTTON} h-auto w-32 px-0`}
                            onClick={() => {
                              setConfirmArchiveId(document.documentId);
                              setConfirmRestoreId(null);
                            }}
                            disabled={busy || availableDocuments.length <= 1}
                            title={
                              availableDocuments.length <= 1
                                ? "Keep at least one document available"
                                : `Archive ${document.name}`
                            }
                            aria-label={`Archive ${document.name}`}
                            aria-expanded={confirming}
                          >
                            <Archive size={13} aria-hidden="true" />
                          </button>
                        </div>
                        {confirming && (
                          <div
                            className="grid gap-6 rounded-m border border-amber-500/25 bg-amber-500/8 px-8 py-7"
                            role="alert"
                          >
                            <span className="min-w-0 text-[10.5px] leading-[1.4] text-ink-dim">
                              Archive “{document.name}”? You can restore it later.
                            </span>
                            <span className="flex justify-end gap-5">
                              <button
                                type="button"
                                className={SECONDARY_BUTTON}
                                onClick={() => setConfirmArchiveId(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className={PRIMARY_BUTTON}
                                onClick={() => void archiveDocument(document)}
                                disabled={busy}
                              >
                                Confirm archive
                              </button>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {archivedDocuments.length > 0 && (
                <section aria-labelledby="archived-documents-heading">
                  <h3
                    id="archived-documents-heading"
                    className="mb-6 mt-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint"
                  >
                    Archived · {archivedDocuments.length}
                  </h3>
                  <div className="space-y-6">
                    {archivedDocuments.map((document) => (
                      <div
                        key={document.documentId}
                        className="flex items-center gap-8 rounded-m border border-panel-hairline bg-card/30 px-9 py-8"
                      >
                        <span className="grid h-24 w-24 shrink-0 place-items-center rounded-[7px] bg-field text-ink-faint">
                          <Archive size={13} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-[12px] font-[600] text-ink-dim">
                            {document.name}
                          </strong>
                          <small className="mt-1 block text-[10px] text-ink-faint">
                            Archived {formatTimestamp(document.archivedAt!)}
                          </small>
                        </span>
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={() =>
                            void restoreArchivedDocument(document)
                          }
                          disabled={busy}
                          aria-label={`Restore ${document.name} to Documents`}
                        >
                          <RotateCcw size={12} aria-hidden="true" /> Restore
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>

          <div className="flex min-h-[430px] flex-col p-14 md:min-h-0">
            <div className="mb-12">
              <label className="mb-5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Document name
              </label>
              <div className="flex gap-7">
                <input
                  className={`${INPUT} min-w-0 flex-1`}
                  value={nameDraft}
                  maxLength={120}
                  disabled={busy || !active}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void renameDocument();
                    }
                  }}
                  aria-label="Document name"
                />
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => void renameDocument()}
                  disabled={
                    busy ||
                    !active ||
                    !nameDraft.trim() ||
                    nameDraft.trim() === active.name
                  }
                >
                  Rename
                </button>
              </div>
            </div>

            <div className="mb-9 flex items-end gap-7">
              <label className="min-w-0 flex-1">
                <span className="mb-5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  Named version
                </span>
                <input
                  className={`${INPUT} w-full`}
                  value={versionDraft}
                  maxLength={80}
                  placeholder="e.g. Client review"
                  disabled={busy || !active}
                  onChange={(event) => setVersionDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void saveNamedVersion();
                    }
                  }}
                  aria-label="Version name"
                />
              </label>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => void saveNamedVersion()}
                disabled={busy || !versionDraft.trim() || !active}
              >
                <History size={14} aria-hidden="true" /> Save version
              </button>
            </div>

            <div className="mb-6 flex items-center justify-between">
              <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Version history
              </h3>
              {busy && (
                <span className="text-[10.5px] text-ink-dim" role="status">
                  {operationLabel(library.operation)}
                </span>
              )}
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              {confirmRestoreId
                ? "Restore requested. Activate Confirm to replace the current document with that version, or press Escape to cancel."
                : ""}
            </p>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-3">
              {active && (
                <div className="flex items-center gap-9 rounded-m border border-accent/30 bg-accent/6 px-10 py-9">
                  <span className="grid h-26 w-26 shrink-0 place-items-center rounded-full bg-accent text-white">
                    <Clock3 size={13} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-[12px] font-[620] text-ink">
                      Current document
                    </strong>
                    <small className="mt-1 block text-[10.5px] text-ink-dim">
                      Revision {active.revision} · saved locally
                    </small>
                  </span>
                </div>
              )}

              {library.versions.length === 0 && (
                <div className="rounded-m border border-dashed border-field-border px-12 py-16 text-center text-[11.5px] text-ink-dim">
                  Recovery versions appear after edits. Name important milestones
                  so they are never pruned.
                </div>
              )}

              {library.versions.map((version) => {
                const confirming = confirmRestoreId === version.versionId;
                return (
                  <div
                    key={version.versionId}
                    className="flex items-center gap-9 rounded-m border border-panel-hairline bg-card/55 px-10 py-8"
                  >
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[11.8px] font-[600] text-ink">
                        {versionLabel(version)}
                      </strong>
                      <small className="mt-1 block text-[10px] text-ink-dim">
                        {formatTimestamp(version.createdAt)} · revision {version.sourceRevision}
                        {version.kind === "named" ? " · named" : ""}
                        {version.kind === "conflict" ? " · recovery" : ""}
                      </small>
                    </span>
                    <button
                      type="button"
                      className={confirming ? PRIMARY_BUTTON : SECONDARY_BUTTON}
                      onClick={() => void restoreVersion(version)}
                      disabled={busy}
                      aria-label={`${confirming ? "Confirm restore" : "Restore"} ${versionLabel(version)}`}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      {confirming ? "Confirm" : "Restore"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
