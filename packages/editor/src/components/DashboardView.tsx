import { FIELD_INPUT } from "./field-styles";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Archive,
  ArrowUpRight,
  Clock3,
  Copy,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  createId,
  createInitialDocument,
  type LogoDocument,
} from "@openlogo/core";
import {
  OPENLOGO_EXTENSION,
  openDocumentFileWithToast,
} from "../lib/document-file";
import {
  documentLibrary,
  documentLibraryErrorMessage,
} from "../lib/document-library";
import type {
  DocumentFolder,
  DocumentSummary,
} from "../lib/document-repository";
import { MAX_SVG_IMPORT_BYTES } from "../lib/svg-import";
import { useModalDialog } from "../lib/use-modal-dialog";
import { useEditorStore } from "../state/editor-store";

const SECONDARY_BUTTON =
  "inline-flex h-34 items-center justify-center gap-7 rounded-field border border-field-border bg-card px-12 text-[12px] text-ink transition-[border-color,color,background-color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-default disabled:opacity-40";
const PRIMARY_BUTTON =
  "inline-flex h-34 items-center justify-center gap-7 rounded-field bg-accent px-13 text-[12px] font-semibold text-white transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-default disabled:opacity-45";
const DOCUMENT_DRAG_TYPE = "application/x-openlogo-document";
const THUMBNAIL_BACKFILL_INITIAL_DELAY_MS = 500;
const THUMBNAIL_BACKFILL_INTERVAL_MS = 750;
const TemplateGallery = lazy(() => import("./TemplateGallery"));

type DashboardTab = "projects" | "folders" | "archived";
type DashboardSort = "recent" | "name" | "created";
type RenameTarget =
  | { kind: "document"; id: string; name: string }
  | { kind: "folder"; id: string; name: string };

export type DashboardViewProps = {
  onEnterDocument(document: LogoDocument, openHistory?: boolean): void;
  onImportSvg(file: File): Promise<void>;
  onRetryBootstrap(): void;
};

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

function blankDocument(
  names: readonly string[],
  width?: number,
  height?: number,
  artboardName?: string,
): LogoDocument {
  const document = createInitialDocument();
  const artboard = document.artboards[0]!;
  document.name = nextUntitledName(names);
  document.nodes = {};
  artboard.nodeIds = [];
  if (width !== undefined && height !== undefined) {
    artboard.width = width;
    artboard.height = height;
  }
  if (artboardName) {
    artboard.name = artboardName;
  }
  return document;
}

function relativeUpdated(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(value).getFullYear() === new Date().getFullYear()
      ? undefined
      : "numeric",
  }).format(new Date(value));
}

function sortDocuments(
  documents: readonly DocumentSummary[],
  sort: DashboardSort,
): DocumentSummary[] {
  return [...documents].sort((a, b) => {
    if (sort === "name") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (sort === "created") {
      return b.createdAt - a.createdAt || a.name.localeCompare(b.name);
    }
    return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);
  });
}

function DocumentCard({
  summary,
  folders,
  busy,
  canArchive,
  onOpen,
  onRename,
  onDuplicate,
  onMove,
  onArchive,
  onRestore,
  onHistory,
  onDragStart,
  onDragEnd,
}: {
  summary: DocumentSummary;
  folders: readonly DocumentFolder[];
  busy: boolean;
  canArchive: boolean;
  onOpen(): void;
  onRename(): void;
  onDuplicate(): void;
  onMove(folderId: string | null): void;
  onArchive(): void;
  onRestore(): void;
  onHistory(): void;
  onDragStart(event: React.DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}) {
  const archived = summary.archivedAt !== null;
  const folder = folders.find((item) => item.folderId === summary.folderId);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article
      className={`group relative rounded-panel border border-panel-hairline bg-panel shadow-[0_10px_28px_rgb(19_16_25/0.08)] transition-[border-color,transform,box-shadow] duration-160 ease-studio hover:border-field-border hover:shadow-[0_16px_38px_rgb(19_16_25/0.13)] ${
        menuOpen ? "z-30" : "z-0 hover:-translate-y-1"
      } ${archived || busy ? "" : "cursor-grab active:cursor-grabbing"}`}
      draggable={!archived && !busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="block w-full text-left disabled:cursor-default"
        onClick={onOpen}
        disabled={busy || archived}
        aria-label={archived ? `${summary.name} is archived` : `Open ${summary.name}`}
      >
        <span className="relative grid aspect-[16/10] place-items-center overflow-hidden border-b border-panel-hairline bg-field/70">
          {summary.thumbnail ? (
            <img
              src={summary.thumbnail}
              alt=""
              className="h-full w-full object-contain p-12"
            />
          ) : (
            <span className="grid place-items-center gap-7 text-center text-ink-faint">
              <span className="grid h-42 w-42 place-items-center rounded-[12px] border border-field-border bg-card text-ink-dim">
                <FilePlus2 size={19} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <span className="text-[12px] font-medium text-ink-dim">
                {summary.activeArtboardWidth} × {summary.activeArtboardHeight}
              </span>
            </span>
          )}
          {archived && (
            <span className="absolute inset-0 grid place-items-center bg-panel/72 backdrop-blur-[1px]">
              <span className="inline-flex items-center gap-6 rounded-full border border-panel-hairline bg-card px-10 py-5 text-[11px] font-semibold text-ink-dim">
                <Archive size={12} aria-hidden="true" /> Archived
              </span>
            </span>
          )}
        </span>
      </button>

      <div className="flex items-start gap-8 p-12">
        <button
          type="button"
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          onClick={onOpen}
          disabled={busy || archived}
        >
          <strong className="block truncate text-[13px] font-[650] text-ink">
            {summary.name}
          </strong>
          <span className="mt-4 flex min-w-0 items-center gap-5 text-[10.5px] text-ink-faint">
            <Clock3 size={11} aria-hidden="true" /> Updated{" "}
            {relativeUpdated(summary.updatedAt)}
            {folder && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{folder.name}</span>
              </>
            )}
          </span>
        </button>

        <details
          className="relative shrink-0"
          onToggle={(event) => setMenuOpen(event.currentTarget.open)}
        >
          <summary
            className="grid h-28 w-28 cursor-pointer list-none place-items-center rounded-m text-ink-dim transition-colors hover:bg-field hover:text-ink [&::-webkit-details-marker]:hidden"
            aria-label={`Actions for ${summary.name}`}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </summary>
          <div className="absolute right-0 top-32 z-20 grid w-196 gap-2 rounded-panel border border-panel-hairline bg-panel p-5 shadow-[0_16px_44px_rgb(19_16_25/0.24)]">
            {!archived ? (
              <>
                <button
                  type="button"
                  className="menu-item"
                  onClick={onRename}
                  disabled={busy}
                >
                  <Pencil size={13} aria-hidden="true" /> Rename
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={onDuplicate}
                  disabled={busy}
                >
                  <Copy size={13} aria-hidden="true" /> Duplicate
                </button>
                <label className="grid gap-4 border-y border-panel-hairline px-8 py-7 text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                  Move to folder
                  <select
                    className="h-28 rounded-field border border-field-border bg-field px-7 text-[11.5px] font-normal normal-case tracking-normal text-ink outline-none focus:border-accent"
                    value={summary.folderId ?? ""}
                    onChange={(event) =>
                      onMove(event.target.value || null)
                    }
                    disabled={busy}
                    aria-label={`Move ${summary.name} to folder`}
                  >
                    <option value="">Projects root</option>
                    {folders.map((item) => (
                      <option key={item.folderId} value={item.folderId}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="menu-item"
                  onClick={onHistory}
                  disabled={busy}
                >
                  <History size={13} aria-hidden="true" /> Version history
                </button>
                <button
                  type="button"
                  className="menu-item text-amber-700 disabled:opacity-35"
                  onClick={onArchive}
                  disabled={busy || !canArchive}
                  title={canArchive ? undefined : "Keep at least one project available"}
                >
                  <Archive size={13} aria-hidden="true" /> Archive
                </button>
              </>
            ) : (
              <button
                type="button"
                className="menu-item"
                onClick={onRestore}
                disabled={busy}
              >
                <RotateCcw size={13} aria-hidden="true" /> Restore project
              </button>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}

export function DashboardView({
  onEnterDocument,
  onImportSvg,
  onRetryBootstrap,
}: DashboardViewProps) {
  const library = useSyncExternalStore(
    documentLibrary.subscribe,
    documentLibrary.getSnapshot,
  );
  const setToast = useEditorStore((state) => state.setToast);
  const [tab, setTab] = useState<DashboardTab>("projects");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DashboardSort>("recent");
  const [folderFilter, setFolderFilter] = useState("all");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(
    null,
  );
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customWidth, setCustomWidth] = useState("1200");
  const [customHeight, setCustomHeight] = useState("800");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const customDialogRef = useRef<HTMLDivElement>(null);
  const customFocusRef = useRef<HTMLInputElement>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templatesDialogRef = useRef<HTMLDivElement>(null);
  const templatesFocusRef = useRef<HTMLButtonElement>(null);
  const renameDialogRef = useRef<HTMLDivElement>(null);
  const renameFocusRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = library.operation !== null;

  useModalDialog({
    open: customOpen,
    onClose: () => setCustomOpen(false),
    dialogRef: customDialogRef,
    initialFocusRef: customFocusRef,
  });
  useModalDialog({
    open: renameTarget !== null,
    onClose: () => setRenameTarget(null),
    dialogRef: renameDialogRef,
    initialFocusRef: renameFocusRef,
  });
  useModalDialog({
    open: templatesOpen,
    onClose: () => setTemplatesOpen(false),
    dialogRef: templatesDialogRef,
    initialFocusRef: templatesFocusRef,
  });

  useEffect(() => {
    if (
      selectedFolderId &&
      !library.folders.some((folder) => folder.folderId === selectedFolderId)
    ) {
      setSelectedFolderId(null);
    }
  }, [library.folders, selectedFolderId]);

  useEffect(() => {
    if (!library.ready) {
      return;
    }
    const queue = library.documents
      .filter((summary) => summary.thumbnail === null)
      .map((summary) => summary.documentId);
    if (queue.length === 0) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const backfillNext = async () => {
      const documentId = queue.shift();
      if (!documentId || disposed) {
        return;
      }
      await documentLibrary.backfillThumbnail(documentId);
      if (!disposed && queue.length > 0) {
        timer = setTimeout(
          () => void backfillNext(),
          THUMBNAIL_BACKFILL_INTERVAL_MS,
        );
      }
    };
    timer = setTimeout(
      () => void backfillNext(),
      THUMBNAIL_BACKFILL_INITIAL_DELAY_MS,
    );
    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [library.ready]);

  const names = library.documents.map((summary) => summary.name);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingDocuments = useMemo(
    () =>
      sortDocuments(
        library.documents.filter((summary) =>
          summary.name.toLocaleLowerCase().includes(normalizedQuery),
        ),
        sort,
      ),
    [library.documents, normalizedQuery, sort],
  );
  const availableDocuments = matchingDocuments.filter(
    (summary) => summary.archivedAt === null,
  );
  const archivedDocuments = matchingDocuments.filter(
    (summary) => summary.archivedAt !== null,
  );
  const projectDocuments = availableDocuments.filter((summary) => {
    if (folderFilter === "all") {
      return true;
    }
    if (folderFilter === "root") {
      return summary.folderId === null;
    }
    return summary.folderId === folderFilter;
  });
  const selectedFolder = library.folders.find(
    (folder) => folder.folderId === selectedFolderId,
  );
  const folderDocuments = selectedFolder
    ? availableDocuments.filter(
        (summary) => summary.folderId === selectedFolder.folderId,
      )
    : [];

  function reportFailure(error: unknown): void {
    console.warn("Dashboard operation failed", error);
    setToast(documentLibraryErrorMessage(error));
  }

  async function createPreset(
    width?: number,
    height?: number,
    artboardName?: string,
  ): Promise<void> {
    try {
      const created = await documentLibrary.createDocument(
        blankDocument(names, width, height, artboardName),
      );
      onEnterDocument(created);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function createTemplateDocument(document: LogoDocument): Promise<void> {
    try {
      const materialized = structuredClone(document);
      materialized.id = createId("doc");
      const created = await documentLibrary.createDocument(materialized);
      onEnterDocument(created);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function openDocument(
    summary: DocumentSummary,
    openHistory = false,
  ): Promise<void> {
    try {
      const document = await documentLibrary.openDocument(summary.documentId);
      onEnterDocument(document, openHistory);
    } catch (error) {
      reportFailure(error);
    }
  }

  async function submitRename(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!renameTarget || !renameDraft.trim()) {
      return;
    }
    try {
      if (renameTarget.kind === "document") {
        await documentLibrary.renameDocument(renameTarget.id, renameDraft);
      } else {
        await documentLibrary.renameFolder(renameTarget.id, renameDraft);
      }
      setRenameTarget(null);
    } catch (error) {
      reportFailure(error);
    }
  }

  function requestRename(target: RenameTarget): void {
    setRenameDraft(target.name);
    setRenameTarget(target);
  }

  function allowFolderDrop(
    event: React.DragEvent<HTMLElement>,
    folderId: string | null,
  ): void {
    if (!draggedDocumentId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragOverFolderId(folderId ?? "root");
  }

  function dropIntoFolder(
    event: React.DragEvent<HTMLElement>,
    folderId: string | null,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const documentId =
      draggedDocumentId || event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
    setDraggedDocumentId(null);
    setDragOverFolderId(null);
    if (!documentId) {
      return;
    }
    void documentLibrary.moveDocument(documentId, folderId).catch(reportFailure);
  }

  async function handleFiles(files: FileList | readonly File[]): Promise<void> {
    const file = Array.from(files)[0];
    if (!file) {
      return;
    }
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(OPENLOGO_EXTENSION)) {
      openDocumentFileWithToast(file);
      return;
    }
    if (lowerName.endsWith(".svg") || file.type === "image/svg+xml") {
      if (file.size > MAX_SVG_IMPORT_BYTES) {
        setToast("SVG import is limited to 5 MB for reliable local editing.");
        return;
      }
      try {
        await onImportSvg(file);
      } catch (error) {
        reportFailure(error);
      }
      return;
    }
    setToast("Choose a .openlogo or SVG file.");
  }

  function renderCards(documents: readonly DocumentSummary[]) {
    if (documents.length === 0) {
      return (
        <div className="col-span-full grid min-h-220 place-items-center rounded-panel border border-dashed border-field-border bg-panel/45 p-24 text-center">
          <div>
            <FolderOpen
              className="mx-auto text-ink-faint"
              size={28}
              strokeWidth={1.4}
              aria-hidden="true"
            />
            <p className="mb-0 mt-10 text-[13px] font-semibold text-ink-dim">
              No projects here
            </p>
            <p className="mb-0 mt-4 text-[11.5px] text-ink-faint">
              Adjust search/filter, or create a new logo document.
            </p>
          </div>
        </div>
      );
    }

    const unarchivedCount = library.documents.filter(
      (summary) => summary.archivedAt === null,
    ).length;
    return documents.map((summary) => (
      <DocumentCard
        key={summary.documentId}
        summary={summary}
        folders={library.folders}
        busy={busy}
        canArchive={unarchivedCount > 1}
        onOpen={() => void openDocument(summary)}
        onRename={() =>
          requestRename({
            kind: "document",
            id: summary.documentId,
            name: summary.name,
          })
        }
        onDuplicate={() => {
          void documentLibrary
            .duplicateDocument(summary.documentId)
            .then((duplicate) => setToast(`Created “${duplicate.name}”.`))
            .catch(reportFailure);
        }}
        onMove={(folderId) => {
          void documentLibrary
            .moveDocument(summary.documentId, folderId)
            .catch(reportFailure);
        }}
        onArchive={() => {
          void documentLibrary
            .archiveDocument(summary.documentId)
            .then(() => setToast(`Archived “${summary.name}”.`))
            .catch(reportFailure);
        }}
        onRestore={() => {
          void documentLibrary
            .restoreArchivedDocument(summary.documentId)
            .then(() => setToast(`Restored “${summary.name}”.`))
            .catch(reportFailure);
        }}
        onHistory={() => void openDocument(summary, true)}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, summary.documentId);
          setDraggedDocumentId(summary.documentId);
        }}
        onDragEnd={() => {
          setDraggedDocumentId(null);
          setDragOverFolderId(null);
        }}
      />
    ));
  }

  return (
    <main
      className="dashboard-shell min-h-screen bg-surface bg-[radial-gradient(var(--color-canvas-dot)_1px,transparent_1.15px)] bg-[size:20px_20px] text-ink"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void handleFiles(event.dataTransfer.files);
      }}
    >
      <header className="sticky top-0 z-30 border-b border-panel-hairline bg-panel/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1480px] items-center gap-14 px-20 py-12">
          <div className="flex shrink-0 items-center gap-9">
            <span className="grid h-34 w-34 place-items-center rounded-[10px] bg-[linear-gradient(135deg,#6a82f8,var(--color-accent)_55%,var(--color-accent-deep))] text-[12px] font-extrabold tracking-[-0.05em] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28)]">
              OL
            </span>
            <span>
              <strong className="block text-[14px] font-[680]">OpenLogo</strong>
              <small className="block text-[10.5px] text-ink-faint">
                Projects
              </small>
            </span>
          </div>

          <label className="relative ml-auto min-w-0 flex-1 md:max-w-[440px]">
            <Search
              className="pointer-events-none absolute left-11 top-1/2 -translate-y-1/2 text-ink-faint"
              size={14}
              aria-hidden="true"
            />
            <input
              type="search"
              className={`${FIELD_INPUT} w-full pl-34`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects by name"
            />
          </label>

          <button
            type="button"
            className="inline-flex h-36 items-center gap-6 rounded-field border border-field-border bg-card px-12 text-[12px] font-[620] text-ink transition-colors hover:border-accent/55 hover:text-accent"
            onClick={() => setTemplatesOpen(true)}
            aria-haspopup="dialog"
          >
            <Sparkles size={13} className="text-accent" aria-hidden="true" />
            Templates
          </button>

          <label className="hidden items-center gap-7 text-[11px] text-ink-dim sm:flex">
            Sort
            <select
              className={`${FIELD_INPUT} w-112 pr-7`}
              value={sort}
              onChange={(event) => setSort(event.target.value as DashboardSort)}
              aria-label="Sort projects"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="created">Created</option>
            </select>
          </label>

          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept={`${OPENLOGO_EXTENSION},application/json,.svg,image/svg+xml`}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length > 0) {
                void handleFiles(files);
              }
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <Upload size={14} aria-hidden="true" /> Import
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-[1480px] px-20 pb-40 pt-24">
        {library.notice && (
          <div
            className="mb-16 rounded-panel border border-accent/25 bg-accent/8 px-14 py-10 text-[11.5px] text-ink-dim"
            role="status"
          >
            {library.notice}
          </div>
        )}
        {library.error && (
          <div
            className="mb-16 flex items-center justify-between gap-12 rounded-panel border border-red-500/25 bg-red-500/8 px-14 py-10 text-[11.5px] text-red-700"
            role="alert"
          >
            <span>{library.error}</span>
            {!library.ready && (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={onRetryBootstrap}
              >
                Retry
              </button>
            )}
          </div>
        )}

        <section aria-labelledby="new-project-heading">
          <div className="mb-10 flex items-end justify-between gap-12">
            <div>
              <h1
                id="new-project-heading"
                className="m-0 text-[22px] font-[720] tracking-[-0.025em] text-ink"
              >
                Your projects
              </h1>
              <p className="mb-0 mt-5 text-[12px] text-ink-dim">
                Start with a production size, or reopen local work.
              </p>
            </div>
            {busy && (
              <span className="text-[11px] text-ink-dim" role="status">
                Working…
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-9 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: "New blank", size: "720 × 420" },
              { label: "Logo", size: "500 × 500", width: 500, height: 500 },
              {
                label: "Square",
                size: "1080 × 1080",
                width: 1080,
                height: 1080,
              },
              {
                label: "Wide",
                size: "1920 × 1080",
                width: 1920,
                height: 1080,
              },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="group flex min-h-82 items-center gap-11 rounded-panel border border-panel-hairline bg-panel px-13 text-left shadow-[0_6px_20px_rgb(19_16_25/0.06)] transition-[border-color,transform] duration-140 ease-studio hover:-translate-y-1 hover:border-accent/50 disabled:opacity-45"
                onClick={() =>
                  void createPreset(
                    preset.width,
                    preset.height,
                    preset.label === "New blank" ? "Primary logo" : preset.label,
                  )
                }
                disabled={busy || !library.ready}
              >
                <span className="grid h-38 w-38 shrink-0 place-items-center rounded-[11px] bg-accent/9 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                  <FilePlus2 size={17} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <strong className="block text-[12.5px] font-[650] text-ink">
                    {preset.label}
                  </strong>
                  <small className="mt-3 block text-[10.5px] text-ink-faint">
                    {preset.size}
                  </small>
                </span>
              </button>
            ))}
            <button
              type="button"
              className="group flex min-h-82 items-center gap-11 rounded-panel border border-dashed border-field-border bg-panel/65 px-13 text-left transition-[border-color,transform] duration-140 ease-studio hover:-translate-y-1 hover:border-accent/60 disabled:opacity-45"
              onClick={() => setCustomOpen(true)}
              disabled={busy || !library.ready}
            >
              <span className="grid h-38 w-38 shrink-0 place-items-center rounded-[11px] bg-field text-ink-dim group-hover:text-accent">
                <ArrowUpRight size={17} aria-hidden="true" />
              </span>
              <span>
                <strong className="block text-[12.5px] font-[650] text-ink">
                  Custom size
                </strong>
                <small className="mt-3 block text-[10.5px] text-ink-faint">
                  Up to 16,384 px
                </small>
              </span>
            </button>
          </div>
        </section>

        <section className="mt-28" aria-label="Document library">
          <div className="flex flex-wrap items-center gap-8 border-b border-panel-hairline">
            <div className="flex" role="tablist" aria-label="Project views">
              {(
                [
                  ["projects", "Projects", availableDocuments.length],
                  ["folders", "Folders", library.folders.length],
                  ["archived", "Archived", archivedDocuments.length],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`relative h-40 px-13 text-[12px] font-[620] transition-colors ${
                    tab === id ? "text-accent" : "text-ink-dim hover:text-ink"
                  }`}
                  onClick={() => setTab(id)}
                >
                  {label} <span className="text-[10px] text-ink-faint">{count}</span>
                  {tab === id && (
                    <span className="absolute inset-x-8 bottom-0 h-2 rounded-full bg-accent" />
                  )}
                </button>
              ))}
            </div>

            {tab === "projects" && (
              <label className="ml-auto flex items-center gap-7 pb-7 text-[10.5px] text-ink-dim">
                Folder
                <select
                  className="h-30 rounded-field border border-field-border bg-field px-8 text-[11.5px] text-ink outline-none focus:border-accent"
                  value={folderFilter}
                  onChange={(event) => setFolderFilter(event.target.value)}
                  aria-label="Filter projects by folder"
                >
                  <option value="all">All projects</option>
                  <option value="root">Projects root</option>
                  {library.folders.map((folder) => (
                    <option key={folder.folderId} value={folder.folderId}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {tab === "projects" && draggedDocumentId && (
            <div
              className="mt-12 flex flex-wrap items-center gap-7 rounded-panel border border-dashed border-accent/35 bg-accent/5 p-9"
              role="group"
              aria-label="Move project to folder"
            >
              <span className="px-4 text-[10.5px] font-semibold text-ink-dim">
                Drop into
              </span>
              {[{ folderId: null, name: "Projects root" }, ...library.folders].map(
                (folder) => {
                  const dropId = folder.folderId ?? "root";
                  return (
                    <div
                      key={dropId}
                      className={`inline-flex h-30 items-center gap-6 rounded-field border px-9 text-[11px] transition-colors ${
                        dragOverFolderId === dropId
                          ? "border-accent bg-accent text-white"
                          : "border-field-border bg-card text-ink-dim"
                      }`}
                      onDragOver={(event) =>
                        allowFolderDrop(event, folder.folderId)
                      }
                      onDragLeave={() => setDragOverFolderId(null)}
                      onDrop={(event) =>
                        dropIntoFolder(event, folder.folderId)
                      }
                    >
                      <Folder size={12} aria-hidden="true" /> {folder.name}
                    </div>
                  );
                },
              )}
            </div>
          )}

          {tab === "projects" && (
            <div
              role="tabpanel"
              className="grid grid-cols-1 gap-14 pt-16 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {renderCards(projectDocuments)}
            </div>
          )}

          {tab === "archived" && (
            <div
              role="tabpanel"
              className="grid grid-cols-1 gap-14 pt-16 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {renderCards(archivedDocuments)}
            </div>
          )}

          {tab === "folders" && (
            <div role="tabpanel" className="pt-16">
              <form
                className="mb-14 flex max-w-[420px] gap-8"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = folderDraft.trim();
                  if (!name) {
                    return;
                  }
                  void documentLibrary
                    .createFolder(name)
                    .then((folder) => {
                      setFolderDraft("");
                      setSelectedFolderId(folder.folderId);
                    })
                    .catch(reportFailure);
                }}
              >
                <input
                  className={`${FIELD_INPUT} flex-1`}
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  placeholder="New folder name"
                  maxLength={80}
                  aria-label="New folder name"
                  disabled={busy}
                />
                <button
                  type="submit"
                  className={PRIMARY_BUTTON}
                  disabled={busy || !folderDraft.trim()}
                >
                  <FolderPlus size={14} aria-hidden="true" /> Add folder
                </button>
              </form>

              {draggedDocumentId && (
                <div
                  className={`mb-10 flex min-h-48 items-center justify-center gap-7 rounded-panel border border-dashed text-[11.5px] transition-colors ${
                    dragOverFolderId === "root"
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-field-border bg-panel/55 text-ink-dim"
                  }`}
                  onDragOver={(event) => allowFolderDrop(event, null)}
                  onDragLeave={() => setDragOverFolderId(null)}
                  onDrop={(event) => dropIntoFolder(event, null)}
                >
                  <FolderOpen size={14} aria-hidden="true" /> Drop here to move
                  to Projects root
                </div>
              )}

              <div className="grid grid-cols-1 gap-10 md:grid-cols-2 xl:grid-cols-3">
                {library.folders.map((folder) => {
                  const count = library.documents.filter(
                    (summary) =>
                      summary.folderId === folder.folderId &&
                      summary.archivedAt === null,
                  ).length;
                  const selected = folder.folderId === selectedFolderId;
                  return (
                    <div
                      key={folder.folderId}
                      className={`flex items-center gap-10 rounded-panel border p-11 transition-colors ${
                        dragOverFolderId === folder.folderId
                          ? "border-accent bg-accent/12 shadow-ring"
                          : selected
                          ? "border-accent/50 bg-accent/7"
                          : "border-panel-hairline bg-panel hover:border-field-border"
                      }`}
                      onDragOver={(event) =>
                        allowFolderDrop(event, folder.folderId)
                      }
                      onDragLeave={() => setDragOverFolderId(null)}
                      onDrop={(event) =>
                        dropIntoFolder(event, folder.folderId)
                      }
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-10 text-left"
                        onClick={() => setSelectedFolderId(folder.folderId)}
                        aria-pressed={selected}
                      >
                        <span className="grid h-36 w-36 shrink-0 place-items-center rounded-[10px] bg-field text-ink-dim">
                          <Folder size={17} aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <strong className="block truncate text-[12.5px] text-ink">
                            {folder.name}
                          </strong>
                          <small className="mt-2 block text-[10.5px] text-ink-faint">
                            {count} {count === 1 ? "project" : "projects"}
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="grid h-28 w-28 place-items-center rounded-m text-ink-dim hover:bg-field hover:text-accent"
                        onClick={() =>
                          requestRename({
                            kind: "folder",
                            id: folder.folderId,
                            name: folder.name,
                          })
                        }
                        disabled={busy}
                        aria-label={`Rename folder ${folder.name}`}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="grid h-28 w-28 place-items-center rounded-m text-ink-faint hover:bg-red-500/8 hover:text-red-700"
                        onClick={() => {
                          void documentLibrary
                            .deleteFolder(folder.folderId)
                            .then(() =>
                              setToast(
                                `Deleted folder “${folder.name}”; its projects moved to root.`,
                              ),
                            )
                            .catch(reportFailure);
                        }}
                        disabled={busy}
                        aria-label={`Delete folder ${folder.name} and move its projects to root`}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {library.folders.length === 0 && (
                <div className="rounded-panel border border-dashed border-field-border bg-panel/50 p-24 text-center text-[12px] text-ink-dim">
                  Add a folder to group related logo documents.
                </div>
              )}

              {selectedFolder && (
                <section className="mt-22" aria-labelledby="folder-projects-heading">
                  <h2
                    id="folder-projects-heading"
                    className="m-0 text-[14px] font-[680] text-ink"
                  >
                    {selectedFolder.name}
                  </h2>
                  <div className="mt-12 grid grid-cols-1 gap-14 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {renderCards(folderDocuments)}
                  </div>
                </section>
              )}
            </div>
          )}
        </section>
      </div>

      {dragActive && (
        <div className="pointer-events-none fixed inset-10 z-50 grid place-items-center rounded-[20px] border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[2px]">
          <div className="rounded-panel border border-panel-hairline bg-panel px-24 py-18 text-center shadow-[0_24px_70px_rgb(19_16_25/0.24)]">
            <Upload className="mx-auto text-accent" size={25} aria-hidden="true" />
            <strong className="mt-9 block text-[14px] text-ink">
              Drop to import
            </strong>
            <span className="mt-4 block text-[11.5px] text-ink-dim">
              .openlogo or SVG
            </span>
          </div>
        </div>
      )}

      {templatesOpen && (
        <div
          ref={templatesDialogRef}
          className="overlay-in fixed inset-0 z-50 grid place-items-center bg-[rgb(16_14_20/0.68)] p-20 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="templates-dialog-title"
          tabIndex={-1}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setTemplatesOpen(false);
            }
          }}
        >
          <div className="dialog-in flex max-h-[calc(100vh-56px)] w-[min(1160px,calc(100vw-40px))] flex-col overflow-hidden rounded-panel border border-panel-hairline bg-panel shadow-[0_28px_90px_rgb(0_0_0/0.42)]">
            <div className="flex items-center justify-between gap-12 border-b border-panel-hairline px-18 py-12">
              <h2
                id="templates-dialog-title"
                className="m-0 text-[15px] font-[680] text-ink"
              >
                Templates
              </h2>
              <button
                ref={templatesFocusRef}
                type="button"
                className="grid h-28 w-28 place-items-center rounded-field text-ink-dim hover:bg-field hover:text-ink"
                onClick={() => setTemplatesOpen(false)}
                aria-label="Close templates"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto px-18 pb-18">
              <Suspense
                fallback={
                  <section
                    className="mt-16 rounded-panel border border-panel-hairline bg-panel/72 p-18"
                    aria-label="Loading template gallery"
                    aria-busy="true"
                  >
                    <div className="h-16 w-196 animate-pulse rounded-full bg-ink/8 motion-reduce:animate-none" />
                    <div className="mt-14 grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {Array.from({ length: 4 }, (_, index) => (
                        <div
                          key={index}
                          className="aspect-[4/3] animate-pulse rounded-panel bg-ink/6 motion-reduce:animate-none"
                        />
                      ))}
                    </div>
                  </section>
                }
              >
                <TemplateGallery
                  disabled={busy || !library.ready}
                  onCreateDocument={createTemplateDocument}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {customOpen && (
        <div
          ref={customDialogRef}
          className="overlay-in fixed inset-0 z-50 grid place-items-center bg-[rgb(16_14_20/0.68)] p-20 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-size-title"
          tabIndex={-1}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setCustomOpen(false);
            }
          }}
        >
          <form
            className="dialog-in w-[min(420px,calc(100vw-40px))] rounded-panel border border-panel-hairline bg-panel p-18 shadow-[0_28px_90px_rgb(0_0_0/0.42)]"
            onSubmit={(event) => {
              event.preventDefault();
              const width = Math.round(Number(customWidth));
              const height = Math.round(Number(customHeight));
              if (
                !Number.isFinite(width) ||
                !Number.isFinite(height) ||
                width < 1 ||
                height < 1 ||
                width > 16_384 ||
                height > 16_384
              ) {
                setToast("Custom dimensions must be between 1 and 16,384 px.");
                return;
              }
              setCustomOpen(false);
              void createPreset(width, height, "Custom");
            }}
          >
            <div className="flex items-start justify-between gap-12">
              <div>
                <h2 id="custom-size-title" className="m-0 text-[15px] font-[680] text-ink">
                  Custom project size
                </h2>
                <p className="mb-0 mt-4 text-[11.5px] text-ink-dim">
                  Creates one blank artboard.
                </p>
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => setCustomOpen(false)}
                aria-label="Close custom size dialog"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="mt-16 grid grid-cols-2 gap-10">
              <label className="grid gap-5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                Width
                <input
                  ref={customFocusRef}
                  className={FIELD_INPUT}
                  type="number"
                  min={1}
                  max={16_384}
                  value={customWidth}
                  onChange={(event) => setCustomWidth(event.target.value)}
                  required
                />
              </label>
              <label className="grid gap-5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                Height
                <input
                  className={FIELD_INPUT}
                  type="number"
                  min={1}
                  max={16_384}
                  value={customHeight}
                  onChange={(event) => setCustomHeight(event.target.value)}
                  required
                />
              </label>
            </div>
            <div className="mt-18 flex justify-end gap-8">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => setCustomOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
                Create project
              </button>
            </div>
          </form>
        </div>
      )}

      {renameTarget && (
        <div
          ref={renameDialogRef}
          className="overlay-in fixed inset-0 z-50 grid place-items-center bg-[rgb(16_14_20/0.68)] p-20 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dashboard-rename-title"
          tabIndex={-1}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setRenameTarget(null);
            }
          }}
        >
          <form
            className="dialog-in w-[min(420px,calc(100vw-40px))] rounded-panel border border-panel-hairline bg-panel p-18 shadow-[0_28px_90px_rgb(0_0_0/0.42)]"
            onSubmit={(event) => void submitRename(event)}
          >
            <h2 id="dashboard-rename-title" className="m-0 text-[15px] font-[680] text-ink">
              Rename {renameTarget.kind === "document" ? "project" : "folder"}
            </h2>
            <input
              ref={renameFocusRef}
              className={`${FIELD_INPUT} mt-14 w-full`}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={renameTarget.kind === "document" ? 120 : 80}
              aria-label={`New ${renameTarget.kind} name`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="mt-18 flex justify-end gap-8">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => setRenameTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={PRIMARY_BUTTON}
                disabled={busy || !renameDraft.trim()}
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
