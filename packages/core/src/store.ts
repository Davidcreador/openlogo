import { type Command, type NodePatch, applyCommand } from "./commands";
import type { LogoDocument } from "./types";

export type DocumentListener = (document: LogoDocument) => void;

type HistoryEntry = {
  inverse: Command;
  redo: Command;
};

const HISTORY_LIMIT = 200;

/**
 * Owns the live document. All persistent edits go through `apply(command)`;
 * per-frame edits during a drag go through `preview(...)` and are committed
 * as a single command at gesture end, so history stays one-entry-per-gesture
 * and undo is patch-based rather than snapshot-based.
 *
 * Deliberately framework-free: React subscribes via `subscribe`, the
 * renderer reads `document` directly on its own frame loop.
 */
export class DocumentStore {
  private current: LogoDocument;
  /** Document as of the last committed command; preview never touches it. */
  private committed: LogoDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<DocumentListener>();

  constructor(initial: LogoDocument) {
    this.current = initial;
    this.committed = initial;
  }

  get document(): LogoDocument {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persistent edit. Pushes exactly one history entry. */
  apply(command: Command): void {
    this.cancelPreview();
    const result = applyCommand(this.committed, command);
    this.committed = result.document;
    this.current = result.document;
    this.undoStack.push({ inverse: result.inverse, redo: command });
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit();
  }

  /**
   * Transient edit for live drags: cheap node patches applied on top of the
   * last committed document. No history entry. Call `apply` (or
   * `cancelPreview`) when the gesture ends.
   */
  preview(updates: Array<{ nodeId: string; patch: NodePatch }>): void {
    const nodes = { ...this.committed.nodes };
    for (const update of updates) {
      const node = nodes[update.nodeId];
      if (node) {
        nodes[update.nodeId] = { ...node, ...update.patch } as typeof node;
      }
    }
    this.current = { ...this.committed, nodes };
    this.emit();
  }

  cancelPreview(): void {
    if (this.current !== this.committed) {
      this.current = this.committed;
      this.emit();
    }
  }

  undo(): void {
    this.cancelPreview();
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }
    const result = applyCommand(this.committed, entry.inverse);
    this.committed = result.document;
    this.current = result.document;
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    this.cancelPreview();
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }
    const result = applyCommand(this.committed, entry.redo);
    this.committed = result.document;
    this.current = result.document;
    this.undoStack.push({ inverse: result.inverse, redo: entry.redo });
    this.emit();
  }

  /** Replace the whole document (load from disk / new file). Clears history. */
  reset(document: LogoDocument): void {
    this.current = document;
    this.committed = document;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.current);
    }
  }
}
