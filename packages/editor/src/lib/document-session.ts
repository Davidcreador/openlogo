import type {
  DocumentChangeKind,
  LogoDocument,
} from "@openlogo/core";

const DEFAULT_AUTOSAVE_DELAY_MS = 800;
const DEFAULT_LOAD_TIMEOUT_MS = 5_000;

export class DocumentLoadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Local document restore exceeded ${timeoutMs} ms.`);
    this.name = "DocumentLoadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type DocumentSessionState =
  | "loading"
  | "saving"
  | "saved"
  | "error";

export type DocumentSessionFailurePhase = "load" | "save";

export type DocumentSessionFailure = {
  phase: DocumentSessionFailurePhase;
  error: unknown;
};

/** A stale optimistic write was preserved, and this is the authoritative head. */
export type DocumentSaveResult =
  | void
  | {
      status: "conflict-recovered";
      authoritativeDocument: LogoDocument;
      error: unknown;
    };

export type DocumentSessionStore = {
  readonly document: LogoDocument;
  reset(document: LogoDocument): void;
  subscribe(
    listener: (document: LogoDocument, kind: DocumentChangeKind) => void,
  ): () => void;
};

export type DocumentSessionOptions = {
  store: DocumentSessionStore;
  load: () => Promise<LogoDocument | null>;
  save: (document: LogoDocument) => Promise<DocumentSaveResult>;
  delayMs?: number;
  /** Open the editor after this deadline while the original load continues. */
  loadTimeoutMs?: number;
  onStateChange?: (state: DocumentSessionState) => void;
  onFailure?: (failure: DocumentSessionFailure) => void;
  /** Pass null to disable lifecycle listeners. */
  lifecycleTarget?: EventTarget | null;
  getVisibilityState?: () => string;
};

type PendingSave = {
  document: LogoDocument;
  revision: number;
  activityRevision: number;
};

/**
 * Coordinates document restoration, committed-change autosave, and final
 * lifecycle flushes. The class owns no document data; the supplied store stays
 * the synchronous source of truth for editor and renderer consumers.
 */
export class DocumentSession {
  private readonly store: DocumentSessionStore;
  private readonly loadDocument: () => Promise<LogoDocument | null>;
  private readonly saveDocument: (
    document: LogoDocument,
  ) => Promise<DocumentSaveResult>;
  private readonly delayMs: number;
  private readonly loadTimeoutMs: number;
  private readonly onStateChange:
    | ((state: DocumentSessionState) => void)
    | undefined;
  private readonly onFailure:
    | ((failure: DocumentSessionFailure) => void)
    | undefined;
  private readonly pagehideTarget: EventTarget | null;
  private readonly visibilityTarget: EventTarget | null;
  private readonly getVisibilityState: () => string;

  private currentState: DocumentSessionState = "loading";
  private startPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveStart: (() => void) | null = null;
  private pendingSave: PendingSave | null = null;
  private saveTail: Promise<void> = Promise.resolve();
  /** Any document activity, including unsaved gesture previews. */
  private activityRevision = 0;
  /** Committed snapshots only; used to serialize and supersede saves. */
  private revision = 0;
  private restoring = false;
  private loadFinished = false;
  private loadTimedOut = false;
  private persistenceBlocked = false;
  private disposed = false;

  constructor(options: DocumentSessionOptions) {
    this.store = options.store;
    this.loadDocument = options.load;
    this.saveDocument = options.save;
    const requestedDelay = options.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
    this.delayMs = Number.isFinite(requestedDelay)
      ? Math.max(0, requestedDelay)
      : DEFAULT_AUTOSAVE_DELAY_MS;
    const requestedLoadTimeout =
      options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.loadTimeoutMs = Number.isFinite(requestedLoadTimeout)
      ? Math.max(0, requestedLoadTimeout)
      : DEFAULT_LOAD_TIMEOUT_MS;
    this.onStateChange = options.onStateChange;
    this.onFailure = options.onFailure;

    if (options.lifecycleTarget !== undefined) {
      this.pagehideTarget = options.lifecycleTarget;
      this.visibilityTarget = options.lifecycleTarget;
    } else {
      this.pagehideTarget =
        typeof window === "undefined" ? null : window;
      this.visibilityTarget =
        typeof document === "undefined" ? null : document;
    }

    this.getVisibilityState =
      options.getVisibilityState ??
      (() =>
        typeof document === "undefined" ? "visible" : document.visibilityState);
  }

  get state(): DocumentSessionState {
    return this.currentState;
  }

  get document(): LogoDocument {
    return this.store.document;
  }

  /** Subscribe to changes before loading so edits made during restore win. */
  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.disposed) {
      this.startPromise = Promise.resolve();
      return this.startPromise;
    }

    this.unsubscribe = this.store.subscribe(this.handleStoreChange);
    this.pagehideTarget?.addEventListener("pagehide", this.handlePagehide);
    this.visibilityTarget?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.publishState("loading", true);

    const loadActivityRevision = this.activityRevision;
    this.startPromise = new Promise<void>((resolve) => {
      let resolved = false;
      const resolveOnce = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.resolveStart = null;
        resolve();
      };
      this.resolveStart = resolveOnce;

      this.loadTimer = setTimeout(() => {
        this.loadTimer = null;
        if (this.disposed || this.loadFinished) {
          resolveOnce();
          return;
        }

        // The editor may open, but autosave stays quarantined until the load
        // proves storage is empty/readable. Otherwise a fresh document could
        // overwrite work that is merely slow or temporarily inaccessible.
        this.loadTimedOut = true;
        this.persistenceBlocked = true;
        this.clearTimer();
        this.publishFailure({
          phase: "load",
          error: new DocumentLoadTimeoutError(this.loadTimeoutMs),
        });
        this.publishState("error");
        resolveOnce();
      }, this.loadTimeoutMs);

      void Promise.resolve()
        .then(() => this.loadDocument())
        .then(
          (restored) => this.finishLoad(restored, loadActivityRevision),
          (error: unknown) => this.finishLoadFailure(error),
        )
        .catch((error: unknown) => this.finishLoadFailure(error))
        .finally(resolveOnce);
    });

    return this.startPromise;
  }

  /** Save the latest committed snapshot immediately, after older writes. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.disposed) {
      return this.saveTail;
    }
    return this.enqueuePendingSave();
  }

  /**
   * Adopt a repository-backed Document Head without treating the reset as a
   * user edit. Callers must flush the old document before using this method.
   */
  adoptDocument(document: LogoDocument): void {
    if (this.disposed) {
      throw new Error("Cannot adopt a document after the session was disposed.");
    }
    this.clearTimer();
    this.pendingSave = null;
    // Invalidate any save that was in flight when a recovered repository head
    // was adopted. Normal switches are already flushed, so this is harmless.
    this.activityRevision += 1;
    this.revision += 1;
    this.restoring = true;
    try {
      this.store.reset(document);
    } finally {
      this.restoring = false;
    }
    this.publishState("saved");
  }

  /**
   * Detach synchronously, then best-effort the last committed snapshot. No
   * callbacks fire after disposal, including from already-running operations.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    // Queue the last committed snapshot before setting disposed. performSave
    // observes disposal by the time its microtask runs, so it stays silent.
    const finalSave = this.enqueuePendingSave();
    this.disposed = true;
    this.clearTimer();
    this.clearLoadTimer();
    this.resolveStart?.();
    this.resolveStart = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pagehideTarget?.removeEventListener("pagehide", this.handlePagehide);
    this.visibilityTarget?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    void finalSave;
  }

  private readonly handleStoreChange = (
    document: LogoDocument,
    kind: DocumentChangeKind,
  ): void => {
    if (this.disposed || this.restoring) {
      return;
    }

    this.activityRevision += 1;
    if (kind !== "committed") {
      return;
    }

    this.revision += 1;
    this.pendingSave = {
      document,
      revision: this.revision,
      activityRevision: this.activityRevision,
    };
    this.clearTimer();

    // Never write until restore proves the persistence slot is readable.
    // A failed/timed-out load keeps the latest edit in memory and leaves the
    // unknown IndexedDB value untouched for recovery on a later launch.
    if (!this.loadFinished || this.persistenceBlocked) {
      this.publishState(this.persistenceBlocked ? "error" : "saving");
      return;
    }

    this.schedulePendingSave();
  };

  private readonly handlePagehide = (): void => {
    void this.flush();
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.getVisibilityState() === "hidden") {
      void this.flush();
    }
  };

  private enqueuePendingSave(): Promise<void> {
    if (this.persistenceBlocked || !this.loadFinished) {
      return this.saveTail;
    }

    const pending = this.pendingSave;
    if (!pending) {
      return this.saveTail;
    }
    this.pendingSave = null;

    const operation = this.saveTail.then(() => this.performSave(pending));
    // Keep the queue live even if an unexpected callback/runtime error escapes.
    this.saveTail = operation.catch(() => undefined);
    return operation;
  }

  private async performSave(pending: PendingSave): Promise<void> {
    if (!this.disposed) {
      this.publishState("saving");
    }

    try {
      const result = await this.saveDocument(pending.document);
      if (result && result.status === "conflict-recovered") {
        if (!this.disposed) {
          this.publishFailure({ phase: "save", error: result.error });
        }
        const noNewActivity =
          pending.revision === this.revision &&
          pending.activityRevision === this.activityRevision;
        if (noNewActivity && !this.disposed) {
          this.adoptDocument(result.authoritativeDocument);
        } else if (!this.pendingSave && !this.disposed) {
          // A preview is still based on the stale head. Keep it visible, but
          // require its eventual commit/cancel before claiming Saved.
          this.publishState("error");
        }
        return;
      }
      if (!this.disposed && pending.revision === this.revision) {
        this.publishState("saved");
      }
    } catch (error: unknown) {
      if (this.disposed) {
        return;
      }
      this.publishFailure({ phase: "save", error });
      if (pending.revision === this.revision) {
        // Keep the latest failed snapshot available for pagehide, visibility,
        // or an explicit later flush. A newer edit supersedes it naturally.
        if (
          !this.pendingSave ||
          this.pendingSave.revision <= pending.revision
        ) {
          this.pendingSave = pending;
        }
        this.publishState("error");
      }
    }
  }

  private finishLoad(
    restored: LogoDocument | null,
    loadActivityRevision: number,
  ): void {
    if (this.disposed) {
      return;
    }

    this.loadFinished = true;
    this.clearLoadTimer();
    const activeDuringLoad = this.activityRevision !== loadActivityRevision;

    // Any activity after loading began may carry live gesture snapshots. A
    // late reset must not replace their base document beneath pointer-up.
    if (restored && !activeDuringLoad) {
      this.restoring = true;
      try {
        this.store.reset(restored);
      } finally {
        this.restoring = false;
      }
    }

    if (this.loadTimedOut && restored && activeDuringLoad) {
      // Both versions now matter: keep live edits in memory, leave the stored
      // document untouched, and require an explicit file save by the user.
      this.persistenceBlocked = true;
      this.clearTimer();
      this.publishState("error");
      return;
    }

    this.persistenceBlocked = false;
    if (this.pendingSave) {
      this.schedulePendingSave();
    } else {
      this.publishState("saved");
    }
  }

  private finishLoadFailure(error: unknown): void {
    if (this.disposed) {
      return;
    }

    this.loadFinished = true;
    this.persistenceBlocked = true;
    this.clearLoadTimer();
    this.clearTimer();
    this.publishFailure({ phase: "load", error });
    this.publishState("error");
  }

  private schedulePendingSave(): void {
    this.publishState("saving");
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueuePendingSave();
    }, this.delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
  }

  private publishState(state: DocumentSessionState, force = false): void {
    if (this.disposed || (!force && state === this.currentState)) {
      return;
    }
    this.currentState = state;
    try {
      this.onStateChange?.(state);
    } catch (error) {
      console.error("DocumentSession state callback failed.", error);
    }
  }

  private publishFailure(failure: DocumentSessionFailure): void {
    try {
      this.onFailure?.(failure);
    } catch (error) {
      console.error("DocumentSession failure callback failed.", error);
    }
  }
}
