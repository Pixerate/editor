import {
  createEditorRemoteSync,
  type EditorDocument,
  type EditorRemoteSync,
  type EditorRemoteSyncOptions,
  type EditorRemoteSyncStatus,
} from "@pixerate/editor/persistence";

export interface CreateEditorSyncOptions<TDocument = unknown, TDiff = unknown>
  extends EditorRemoteSyncOptions<TDocument, TDiff> {
  /**
   * Flush pending debounced changes when the tab hides or unloads (`visibilitychange` to
   * `"hidden"`, `pagehide`; default `true`).
   */
  flushOnHide?: boolean;
}

export interface SvelteEditorSync<TDocument = unknown, TDiff = unknown> {
  readonly status: EditorRemoteSyncStatus;
  readonly version: number;
  readonly savedVersion: number;
  readonly dirty: boolean;
  readonly controller: EditorRemoteSync<TDocument, TDiff>;
  baseline(): TDocument;
  notify(): boolean;
  applyRemote<TResult>(fn: () => TResult, remoteVersion?: number): TResult;
  resetBaseline(remoteVersion?: number): void;
  flush(): Promise<boolean>;
  whenIdle(): Promise<void>;
  destroy(): void;
}

/**
 * Svelte 5 rune wrapping `createEditorRemoteSync`: subscribes to `doc` and exposes reactive
 * `status`, `version`, `savedVersion`, and `dirty` fields, plus optional `flushOnHide` listener.
 */
export function createEditorSync<TDocument = unknown, TDiff = unknown>(
  doc: EditorDocument<TDocument>,
  options: CreateEditorSyncOptions<TDocument, TDiff>,
): SvelteEditorSync<TDocument, TDiff> {
  const { flushOnHide = true, ...syncOptions } = options;
  const controller = createEditorRemoteSync(doc, syncOptions);

  let status = $state<EditorRemoteSyncStatus>(controller.status());
  const unsubscribe = controller.subscribe((next) => {
    status = next;
  });

  const unsubscribers: Array<() => void> = [unsubscribe];

  if (flushOnHide && typeof window !== "undefined") {
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        void controller.flush();
      }
    };
    const onPageHide = () => {
      void controller.flush();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      unsubscribers.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));
    }
    window.addEventListener("pagehide", onPageHide);
    unsubscribers.push(() => window.removeEventListener("pagehide", onPageHide));
  }

  return {
    get status() {
      return status;
    },
    get version() {
      return status.version;
    },
    get savedVersion() {
      return status.savedVersion;
    },
    get dirty() {
      return status.dirty;
    },
    controller,
    baseline: () => controller.baseline(),
    notify: () => controller.notify(),
    applyRemote: (fn, remoteVersion) => controller.applyRemote(fn, remoteVersion),
    resetBaseline: (remoteVersion) => controller.resetBaseline(remoteVersion),
    flush: () => controller.flush(),
    whenIdle: () => controller.whenIdle(),
    destroy() {
      unsubscribers.forEach((fn) => fn());
      unsubscribers.length = 0;
      controller.destroy();
    },
  };
}
