import {
  createInitialDocument,
  type DocumentChangeKind,
  type LogoDocument,
} from "@openlogo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentLoadTimeoutError,
  DocumentSession,
  type DocumentSessionFailure,
  type DocumentSessionState,
  type DocumentSessionStore,
} from "./document-session";

function makeDocument(name: string): LogoDocument {
  return { ...createInitialDocument(), id: `doc-${name}`, name };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

class FakeDocumentStore implements DocumentSessionStore {
  document: LogoDocument;
  readonly resets: LogoDocument[] = [];
  private readonly listeners = new Set<
    (document: LogoDocument, kind: DocumentChangeKind) => void
  >();

  constructor(initial: LogoDocument) {
    this.document = initial;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  reset(document: LogoDocument): void {
    this.resets.push(document);
    this.emit(document, "committed");
  }

  subscribe(
    listener: (document: LogoDocument, kind: DocumentChangeKind) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(document: LogoDocument, kind: DocumentChangeKind): void {
    this.document = document;
    for (const listener of this.listeners) {
      listener(document, kind);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DocumentSession", () => {
  it("starts once and restores before reporting ready", async () => {
    const initial = makeDocument("initial");
    const restored = makeDocument("restored");
    const store = new FakeDocumentStore(initial);
    const states: DocumentSessionState[] = [];
    const load = vi.fn(async () => restored);
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load,
      save,
      onStateChange: (state) => states.push(state),
      lifecycleTarget: null,
    });

    const firstStart = session.start();
    const secondStart = session.start();

    expect(secondStart).toBe(firstStart);
    await firstStart;

    expect(load).toHaveBeenCalledOnce();
    expect(store.document).toBe(restored);
    expect(store.resets).toEqual([restored]);
    expect(save).not.toHaveBeenCalled();
    expect(states).toEqual(["loading", "saved"]);
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("adopts a repository-backed Document Head without scheduling an autosave", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const adopted = makeDocument("adopted");
    const store = new FakeDocumentStore(initial);
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10,
      lifecycleTarget: null,
    });
    await session.start();

    session.adoptDocument(adopted);
    await vi.advanceTimersByTimeAsync(20);
    await session.flush();

    expect(session.document).toBe(adopted);
    expect(store.resets).toEqual([adopted]);
    expect(save).not.toHaveBeenCalled();
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("adopts the authoritative head after a stale write was preserved", async () => {
    const initial = makeDocument("initial");
    const local = makeDocument("local");
    const authoritative = makeDocument("authoritative");
    // Repository conflicts are always within one document identity.
    local.id = initial.id;
    authoritative.id = initial.id;
    const conflict = { _tag: "DocumentRevisionConflict" };
    const store = new FakeDocumentStore(initial);
    const failures: DocumentSessionFailure[] = [];
    const save = vi.fn(async () => ({
      status: "conflict-recovered" as const,
      authoritativeDocument: authoritative,
      error: conflict,
    }));
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10_000,
      onFailure: (failure) => failures.push(failure),
      lifecycleTarget: null,
    });
    await session.start();

    store.emit(local, "committed");
    await session.flush();

    expect(store.document).toBe(authoritative);
    expect(store.resets).toEqual([authoritative]);
    expect(session.state).toBe("saved");
    expect(failures).toEqual([{ phase: "save", error: conflict }]);

    session.dispose();
  });

  it("never replaces a preview that began while a conflict was resolving", async () => {
    const initial = makeDocument("initial");
    const local = { ...makeDocument("local"), id: initial.id };
    const preview = { ...makeDocument("preview"), id: initial.id };
    const committed = { ...makeDocument("committed"), id: initial.id };
    const authoritative = {
      ...makeDocument("authoritative"),
      id: initial.id,
    };
    const firstSave = deferred<{
      status: "conflict-recovered";
      authoritativeDocument: LogoDocument;
      error: unknown;
    }>();
    const store = new FakeDocumentStore(initial);
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10_000,
      lifecycleTarget: null,
    });
    await session.start();

    store.emit(local, "committed");
    const flushing = session.flush();
    await drainMicrotasks();
    store.emit(preview, "preview");
    firstSave.resolve({
      status: "conflict-recovered",
      authoritativeDocument: authoritative,
      error: { _tag: "DocumentRevisionConflict" },
    });
    await flushing;

    expect(store.document).toBe(preview);
    expect(store.resets).toEqual([]);
    expect(session.state).toBe("error");

    store.emit(committed, "committed");
    await session.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(committed);
    expect(store.document).toBe(committed);
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("keeps a committed edit when restore resolves late", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const restored = makeDocument("restored");
    const edited = makeDocument("edited");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      delayMs: 20,
      lifecycleTarget: null,
    });

    const started = session.start();
    store.emit(edited, "committed");
    loadGate.resolve(restored);
    await started;

    expect(store.document).toBe(edited);
    expect(store.resets).toEqual([]);

    await vi.advanceTimersByTimeAsync(20);
    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(edited);

    session.dispose();
  });

  it("unblocks after the restore deadline without overwriting either version", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const restored = makeDocument("restored");
    const edited = makeDocument("edited");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const failures: DocumentSessionFailure[] = [];
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      loadTimeoutMs: 50,
      onFailure: (failure) => failures.push(failure),
      lifecycleTarget: null,
    });

    let ready = false;
    const started = session.start().then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(ready).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(ready).toBe(true);
    expect(session.state).toBe("error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBeInstanceOf(DocumentLoadTimeoutError);

    // A user can edit after fallback, but the unresolved persistence slot is
    // quarantined and a later stored document cannot replace that edit.
    store.emit(edited, "committed");
    await session.flush();
    expect(save).not.toHaveBeenCalled();

    loadGate.resolve(restored);
    await drainMicrotasks();
    expect(store.document).toBe(edited);
    expect(store.resets).toEqual([]);
    await session.flush();
    expect(save).not.toHaveBeenCalled();

    session.dispose();
  });

  it("does not reset beneath a preview gesture after restore timeout", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const preview = makeDocument("preview");
    const restored = makeDocument("restored");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      loadTimeoutMs: 20,
      lifecycleTarget: null,
    });

    const started = session.start();
    await vi.advanceTimersByTimeAsync(20);
    await started;

    store.emit(preview, "preview");
    loadGate.resolve(restored);
    await drainMicrotasks();
    await session.flush();

    expect(store.document).toBe(preview);
    expect(store.resets).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(session.state).toBe("error");

    session.dispose();
  });

  it("saves fallback edits once a late restore proves storage is empty", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const edited = makeDocument("edited");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      loadTimeoutMs: 20,
      lifecycleTarget: null,
    });

    const started = session.start();
    await vi.advanceTimersByTimeAsync(20);
    await started;
    store.emit(edited, "committed");
    expect(save).not.toHaveBeenCalled();

    loadGate.resolve(null);
    await drainMicrotasks();
    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(edited);
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("adopts a late restored document when fallback has not been edited", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const restored = makeDocument("restored");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      loadTimeoutMs: 20,
      lifecycleTarget: null,
    });

    const started = session.start();
    await vi.advanceTimersByTimeAsync(20);
    await started;
    expect(store.document).toBe(initial);

    loadGate.resolve(restored);
    await drainMicrotasks();
    expect(store.document).toBe(restored);
    expect(store.resets).toEqual([restored]);
    expect(save).not.toHaveBeenCalled();
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("blocks autosave when restore fails so unreadable storage survives", async () => {
    const initial = makeDocument("initial");
    const edited = makeDocument("edited");
    const loadError = new Error("storage unavailable");
    const store = new FakeDocumentStore(initial);
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: async () => {
        throw loadError;
      },
      save,
      lifecycleTarget: null,
    });

    await session.start();
    store.emit(edited, "committed");
    await session.flush();

    expect(session.state).toBe("error");
    expect(store.document).toBe(edited);
    expect(save).not.toHaveBeenCalled();

    session.dispose();
  });

  it("ignores previews and debounces committed changes", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const preview = makeDocument("preview");
    const superseded = makeDocument("superseded");
    const committed = makeDocument("committed");
    const store = new FakeDocumentStore(initial);
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      lifecycleTarget: null,
    });
    await session.start();

    store.emit(preview, "preview");
    await vi.advanceTimersByTimeAsync(100);
    expect(save).not.toHaveBeenCalled();

    store.emit(superseded, "committed");
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();

    store.emit(committed, "committed");
    store.emit(preview, "preview");
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(committed);

    session.dispose();
  });

  it("serializes saves and ignores stale completion state", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const first = makeDocument("first");
    const second = makeDocument("second");
    const store = new FakeDocumentStore(initial);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const states: DocumentSessionState[] = [];
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const save = vi.fn((document: LogoDocument) => {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      const gate = document === first ? firstGate : secondGate;
      return gate.promise.finally(() => {
        activeSaves -= 1;
      });
    });
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 30,
      onStateChange: (state) => states.push(state),
      lifecycleTarget: null,
    });
    await session.start();
    states.length = 0;

    store.emit(first, "committed");
    await vi.advanceTimersByTimeAsync(29);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, first);

    store.emit(second, "committed");
    await vi.advanceTimersByTimeAsync(30);
    expect(save).toHaveBeenCalledTimes(1);

    const flushed = session.flush();
    firstGate.resolve();
    await drainMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, second);
    expect(states).toEqual(["saving"]);

    secondGate.resolve();
    await flushed;
    expect(maxActiveSaves).toBe(1);
    expect(states).toEqual(["saving", "saved"]);

    session.dispose();
  });

  it("flushes on pagehide and only hidden visibility changes", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const pagehideDocument = makeDocument("pagehide");
    const hiddenDocument = makeDocument("hidden");
    const store = new FakeDocumentStore(initial);
    const target = new EventTarget();
    const save = vi.fn(async () => undefined);
    let visibility = "visible";
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10_000,
      lifecycleTarget: target,
      getVisibilityState: () => visibility,
    });
    await session.start();

    store.emit(pagehideDocument, "committed");
    target.dispatchEvent(new Event("pagehide"));
    await session.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(pagehideDocument);

    store.emit(hiddenDocument, "committed");
    target.dispatchEvent(new Event("visibilitychange"));
    await drainMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    target.dispatchEvent(new Event("visibilitychange"));
    await session.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(hiddenDocument);

    session.dispose();
  });

  it("reports save failures and lets a newer edit supersede the retry", async () => {
    const initial = makeDocument("initial");
    const first = makeDocument("first");
    const second = makeDocument("second");
    const store = new FakeDocumentStore(initial);
    const saveError = new Error("save failed");
    const failures: DocumentSessionFailure[] = [];
    const states: DocumentSessionState[] = [];
    const save = vi
      .fn<(document: LogoDocument) => Promise<void>>()
      .mockRejectedValueOnce(saveError)
      .mockResolvedValue(undefined);
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10_000,
      onFailure: (failure) => failures.push(failure),
      onStateChange: (state) => states.push(state),
      lifecycleTarget: null,
    });

    await expect(session.start()).resolves.toBeUndefined();
    expect(session.state).toBe("saved");

    store.emit(first, "committed");
    await expect(session.flush()).resolves.toBeUndefined();
    expect(session.state).toBe("error");

    store.emit(second, "committed");
    await expect(session.flush()).resolves.toBeUndefined();
    expect(session.state).toBe("saved");
    expect(save).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([{ phase: "save", error: saveError }]);
    expect(states).toEqual([
      "loading",
      "saved",
      "saving",
      "error",
      "saving",
      "saved",
    ]);

    session.dispose();
  });

  it("retains the latest failed save for a later flush retry", async () => {
    const initial = makeDocument("initial");
    const edited = makeDocument("edited");
    const store = new FakeDocumentStore(initial);
    const saveError = new Error("transient save failure");
    const save = vi
      .fn<(document: LogoDocument) => Promise<void>>()
      .mockRejectedValueOnce(saveError)
      .mockResolvedValue(undefined);
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 10_000,
      lifecycleTarget: null,
    });
    await session.start();

    store.emit(edited, "committed");
    await session.flush();
    expect(session.state).toBe("error");
    expect(save).toHaveBeenCalledOnce();

    await session.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, edited);
    expect(save).toHaveBeenNthCalledWith(2, edited);
    expect(session.state).toBe("saved");

    session.dispose();
  });

  it("disposes listeners and silently flushes the pending document", async () => {
    vi.useFakeTimers();
    const initial = makeDocument("initial");
    const pending = makeDocument("pending");
    const ignored = makeDocument("ignored");
    const store = new FakeDocumentStore(initial);
    const target = new EventTarget();
    const disposeSaveError = new Error("dispose save failed");
    const save = vi.fn(async () => {
      throw disposeSaveError;
    });
    const states: DocumentSessionState[] = [];
    const failures: DocumentSessionFailure[] = [];
    const session = new DocumentSession({
      store,
      load: async () => null,
      save,
      delayMs: 100,
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      lifecycleTarget: target,
    });
    const flushSpy = vi.spyOn(session, "flush");

    await session.start();
    store.emit(pending, "committed");
    expect(store.listenerCount).toBe(1);
    const callbackCountAtDispose = states.length;

    session.dispose();
    expect(store.listenerCount).toBe(0);
    await session.flush();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(pending);
    expect(store.resets).toEqual([]);
    expect(states).toHaveLength(callbackCountAtDispose);
    expect(failures).toEqual([]);

    store.emit(ignored, "committed");
    target.dispatchEvent(new Event("pagehide"));
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    expect(save).toHaveBeenCalledOnce();
    expect(flushSpy).toHaveBeenCalledOnce();
  });

  it("does not flush edits over a restore that is still unreadable", async () => {
    const initial = makeDocument("initial");
    const pending = makeDocument("pending");
    const restored = makeDocument("restored");
    const store = new FakeDocumentStore(initial);
    const loadGate = deferred<LogoDocument | null>();
    const save = vi.fn(async () => undefined);
    const session = new DocumentSession({
      store,
      load: () => loadGate.promise,
      save,
      loadTimeoutMs: 10_000,
      lifecycleTarget: null,
    });

    const started = session.start();
    store.emit(pending, "committed");
    session.dispose();
    await started;

    expect(save).not.toHaveBeenCalled();
    loadGate.resolve(restored);
    await drainMicrotasks();
    expect(store.document).toBe(pending);
    expect(store.resets).toEqual([]);
  });
});
