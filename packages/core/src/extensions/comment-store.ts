/**
 * Who made a comment, reply or tracked change.
 */
export interface ReviewAuthor {
  id: string;
  name: string;
  color?: string;
  avatarUrl?: string;
}

/**
 * Where a comment thread is attached in the document. `from`/`to` are
 * ProseMirror positions and `quote` is the commented text at the time the
 * anchor was last synced. Positions are only meaningful for the current
 * document; the `comment` mark in the document is the source of truth.
 */
export interface CommentAnchor {
  from: number;
  to: number;
  quote: string;
}

export interface CommentReply {
  id: string;
  author: ReviewAuthor;
  body: string;
  createdAt: number;
  editedAt?: number;
}

export interface CommentThread {
  id: string;
  /** `null` while the thread has no text in the document (see `orphaned`). */
  anchor: CommentAnchor | null;
  author: ReviewAuthor;
  createdAt: number;
  /** An empty body marks a draft that has not been posted yet. */
  body: string;
  editedAt?: number;
  replies: CommentReply[];
  resolved: boolean;
  resolvedAt?: number;
  resolvedBy?: ReviewAuthor;
  /**
   * True when the commented text was deleted from the document. Undoing the
   * deletion re-attaches the thread.
   */
  orphaned: boolean;
  /** The quote the thread had before it was orphaned. */
  lastQuote?: string;
}

export interface CommentStoreSnapshot {
  /** Threads in document order (anchored first), then orphaned threads. */
  threads: readonly CommentThread[];
  activeThreadId: string | null;
}

/** JSON shape produced by `CommentStore.toJSON()`. */
export interface SerializedComments {
  version: 1;
  threads: CommentThread[];
}

export interface CommentStoreOptions {
  threads?: CommentThread[] | SerializedComments;
  generateId?: () => string;
  now?: () => number;
}

export interface CreateThreadInput {
  id?: string;
  body: string;
  author: ReviewAuthor;
  anchor?: CommentAnchor | null;
  createdAt?: number;
}

export type CommentStoreListener = (snapshot: CommentStoreSnapshot) => void;

let idCounter = 0;

/**
 * Generates a reasonably unique id without depending on `crypto`.
 */
export function createReviewId(prefix = "c"): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function sameAnchor(a: CommentAnchor | null, b: CommentAnchor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.from === b.from && a.to === b.to && a.quote === b.quote;
}

function normalizeThread(raw: any): CommentThread {
  return {
    id: String(raw.id),
    anchor: raw.anchor ?? null,
    author: raw.author ?? { id: "unknown", name: "Unknown" },
    createdAt: Number(raw.createdAt ?? 0),
    body: String(raw.body ?? ""),
    ...(raw.editedAt !== undefined ? { editedAt: raw.editedAt } : {}),
    replies: Array.isArray(raw.replies) ? raw.replies.map((r: any) => ({ ...r })) : [],
    resolved: !!raw.resolved,
    ...(raw.resolvedAt !== undefined ? { resolvedAt: raw.resolvedAt } : {}),
    ...(raw.resolvedBy !== undefined ? { resolvedBy: raw.resolvedBy } : {}),
    orphaned: !!raw.orphaned,
    ...(raw.lastQuote !== undefined ? { lastQuote: String(raw.lastQuote) } : {}),
  };
}

/**
 * Headless, framework-agnostic store of comment threads.
 *
 * The store never talks to a server: persist `toJSON()` yourself and pass it
 * back via `new CommentStore({ threads })` or `load()`. Snapshots are
 * immutable and only replaced when something changes, so `getSnapshot` is safe
 * to use with React's `useSyncExternalStore`. `subscribe` calls the listener
 * immediately (Svelte store contract).
 */
export class CommentStore {
  private threads: CommentThread[] = [];
  private activeThreadId: string | null = null;
  private snapshot: CommentStoreSnapshot;
  private listeners = new Set<CommentStoreListener>();
  /** Deleted threads, kept so undoing a "Delete Comment" can restore them. */
  private deleted = new Map<string, CommentThread>();
  private generateId: () => string;
  private now: () => number;

  constructor(options: CommentStoreOptions = {}) {
    this.generateId = options.generateId ?? (() => createReviewId("comment"));
    this.now = options.now ?? (() => Date.now());
    if (options.threads) {
      this.threads = CommentStore.parse(options.threads);
    }
    this.snapshot = this.computeSnapshot();
  }

  /** Parses `toJSON()` output (or a plain thread array). */
  static parse(json: string | CommentThread[] | SerializedComments): CommentThread[] {
    const value = typeof json === "string" ? JSON.parse(json) : json;
    const list = Array.isArray(value) ? value : value?.threads;
    if (!Array.isArray(list)) return [];
    return list.filter((t: any) => t && t.id != null).map(normalizeThread);
  }

  subscribe = (listener: CommentStoreListener): (() => void) => {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CommentStoreSnapshot => this.snapshot;

  getThread(id: string): CommentThread | undefined {
    return this.threads.find((t) => t.id === id);
  }

  createThread(input: CreateThreadInput): CommentThread {
    const thread: CommentThread = {
      id: input.id ?? this.generateId(),
      anchor: input.anchor ?? null,
      author: input.author,
      createdAt: input.createdAt ?? this.now(),
      body: input.body,
      replies: [],
      resolved: false,
      orphaned: false,
    };
    this.threads = [...this.threads.filter((t) => t.id !== thread.id), thread];
    this.deleted.delete(thread.id);
    this.emit();
    return thread;
  }

  /** Edits the thread's body, or one of its replies when `replyId` is given. */
  editComment(threadId: string, body: string, replyId?: string): boolean {
    const editedAt = this.now();
    return this.updateThread(threadId, (t) => {
      if (!replyId) return { ...t, body, editedAt };
      if (!t.replies.some((r) => r.id === replyId)) return t;
      return {
        ...t,
        replies: t.replies.map((r) => (r.id === replyId ? { ...r, body, editedAt } : r)),
      };
    });
  }

  addReply(
    threadId: string,
    input: { body: string; author: ReviewAuthor; id?: string },
  ): CommentReply | null {
    const reply: CommentReply = {
      id: input.id ?? this.generateId(),
      author: input.author,
      body: input.body,
      createdAt: this.now(),
    };
    const ok = this.updateThread(threadId, (t) => ({
      ...t,
      replies: [...t.replies, reply],
      // Replying to a resolved thread re-opens it, as in Word and Pages.
      resolved: false,
      resolvedAt: undefined,
      resolvedBy: undefined,
    }));
    return ok ? reply : null;
  }

  deleteReply(threadId: string, replyId: string): boolean {
    return this.updateThread(threadId, (t) =>
      t.replies.some((r) => r.id === replyId)
        ? { ...t, replies: t.replies.filter((r) => r.id !== replyId) }
        : t,
    );
  }

  resolveThread(id: string, resolved = true, by?: ReviewAuthor): boolean {
    return this.updateThread(id, (t) =>
      t.resolved === resolved
        ? t
        : resolved
          ? { ...t, resolved, resolvedAt: this.now(), ...(by ? { resolvedBy: by } : {}) }
          : { ...t, resolved, resolvedAt: undefined, resolvedBy: undefined },
    );
  }

  deleteThread(id: string): boolean {
    const thread = this.getThread(id);
    if (!thread) return false;
    this.deleted.set(id, thread);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) this.activeThreadId = null;
    this.emit();
    return true;
  }

  /** Deletes every thread whose text is no longer in the document. */
  removeOrphanedThreads(): string[] {
    const ids = this.threads.filter((t) => t.orphaned).map((t) => t.id);
    if (ids.length === 0) return ids;
    ids.forEach((id) => this.deleted.set(id, this.getThread(id)!));
    this.threads = this.threads.filter((t) => !t.orphaned);
    if (this.activeThreadId && ids.includes(this.activeThreadId)) {
      this.activeThreadId = null;
    }
    this.emit();
    return ids;
  }

  setActiveThread(id: string | null): void {
    const next = id && this.getThread(id) ? id : null;
    if (next === this.activeThreadId) return;
    this.activeThreadId = next;
    this.emit();
  }

  /**
   * Updates anchors from the document. Threads missing from `anchors` become
   * orphaned. Threads that were deleted but whose mark re-appeared (e.g. after
   * undoing "Delete Comment") are restored. Returns true if anything changed.
   */
  syncAnchors(anchors: Map<string, CommentAnchor>): boolean {
    let changed = false;
    const restored: CommentThread[] = [];
    anchors.forEach((_anchor, id) => {
      if (!this.getThread(id) && this.deleted.has(id)) {
        restored.push(this.deleted.get(id)!);
        this.deleted.delete(id);
      }
    });
    const next = [...this.threads, ...restored].map((t) => {
      const anchor = anchors.get(t.id) ?? null;
      const orphaned = anchor === null;
      if (sameAnchor(t.anchor, anchor) && t.orphaned === orphaned) return t;
      changed = true;
      // Keep the last known anchor quote for orphaned threads so the UI can
      // still show what was commented on.
      return orphaned
        ? { ...t, anchor: null, orphaned, ...(t.anchor ? { lastQuote: t.anchor.quote } : {}) }
        : { ...t, anchor, orphaned };
    });
    if (!changed && restored.length === 0) return false;
    this.threads = next;
    this.emit();
    return true;
  }

  /** Replaces all threads, e.g. with data loaded from a server. */
  load(json: string | CommentThread[] | SerializedComments): void {
    this.threads = CommentStore.parse(json);
    this.deleted.clear();
    if (this.activeThreadId && !this.getThread(this.activeThreadId)) {
      this.activeThreadId = null;
    }
    this.emit();
  }

  clear(): void {
    this.threads = [];
    this.deleted.clear();
    this.activeThreadId = null;
    this.emit();
  }

  toJSON(): SerializedComments {
    return {
      version: 1,
      threads: this.threads.map((t) => ({ ...t, replies: t.replies.map((r) => ({ ...r })) })),
    };
  }

  private updateThread(id: string, fn: (t: CommentThread) => CommentThread): boolean {
    const index = this.threads.findIndex((t) => t.id === id);
    if (index === -1) return false;
    const updated = fn(this.threads[index]);
    if (updated === this.threads[index]) return true;
    this.threads = this.threads.map((t, i) => (i === index ? updated : t));
    this.emit();
    return true;
  }

  private computeSnapshot(): CommentStoreSnapshot {
    const threads = [...this.threads].sort((a, b) => {
      if (a.anchor && b.anchor) {
        return a.anchor.from - b.anchor.from || a.createdAt - b.createdAt;
      }
      if (a.anchor) return -1;
      if (b.anchor) return 1;
      return a.createdAt - b.createdAt;
    });
    return { threads, activeThreadId: this.activeThreadId };
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[CommentStore] Error in listener:", err);
      }
    });
  }
}

export function createCommentStore(options?: CommentStoreOptions): CommentStore {
  return new CommentStore(options);
}

/**
 * Short, human-readable timestamp for review UIs ("just now", "5m ago",
 * "3h ago", then a locale date). Shared by the React and Svelte components.
 */
export function formatReviewTime(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
