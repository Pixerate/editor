import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { defaultImportRegistry, type DocumentImport } from "../import/adapters";
import { importFilesIntoEditor } from "../import/editor";
import type { FileLike, ImportAdapterRegistry, ImportOutcome } from "../import/registry";

export interface FileImportOptions {
  /** Registry used to match files (default: the shared default registry). */
  registry?: ImportAdapterRegistry;
  /** Per-adapter options keyed by adapter id, e.g. `{ pdf: { structure: false } }`. */
  adapterOptions?: Record<string, unknown>;
  /** Insert extracted plain text instead of HTML (plain-text / prompt editors). */
  asPlainText?: boolean;
  /** Import files dropped onto the editor (default `true`). */
  enableDrop?: boolean;
  /** Import files pasted into the editor, e.g. copied in a file manager (default `true`). */
  enablePaste?: boolean;
  /** Called after each imported file has been inserted. */
  onImport?: (outcome: ImportOutcome<DocumentImport>, file: FileLike) => void;
  /** Called when a file fails to import. */
  onImportError?: (error: Error, file: FileLike) => void;
}

export const fileImportPluginKey = new PluginKey("fileImport");

/**
 * Returns the files that `registry` can import as documents, or `null` when
 * the list is empty or contains a file no document adapter accepts (so other
 * handlers, such as image upload, can take the drop).
 */
function getImportableFiles(files: FileList | File[] | undefined | null, registry: ImportAdapterRegistry): File[] | null {
  const list = Array.from(files ?? []);
  if (list.length === 0) return null;
  return list.every((file) => registry.canImport(file, "document")) ? list : null;
}

function dropPosition(view: EditorView, event: DragEvent): number | undefined {
  try {
    return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    // posAtCoords needs layout APIs that are missing in some environments.
    return undefined;
  }
}

/**
 * Imports files dropped or pasted into the editor through the import adapter
 * registry (markdown, HTML, plain text and RTF by default) and inserts the
 * converted content at the drop position or selection.
 *
 * Opt-in: add it to `extensions` or pass `fileImport: true` to
 * `createRichTextPreset`. Only drops where every file has a `document`
 * adapter are handled; anything else (e.g. images) falls through.
 */
export const FileImport = Extension.create<FileImportOptions>({
  name: "fileImport",

  addOptions() {
    return {
      registry: undefined,
      adapterOptions: undefined,
      asPlainText: false,
      enableDrop: true,
      enablePaste: true,
      onImport: undefined,
      onImportError: undefined,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const registry = () => options.registry ?? defaultImportRegistry;
    const run = (view: EditorView, files: File[], at?: number) => {
      void importFilesIntoEditor(view, files, {
        registry: registry(),
        at,
        asPlainText: options.asPlainText,
        adapterOptions: options.adapterOptions,
        onImport: options.onImport,
        onError: options.onImportError,
      });
    };

    return [
      new Plugin({
        key: fileImportPluginKey,
        props: {
          handleDrop(view, event, _slice, moved) {
            if (!options.enableDrop || moved) return false;
            const files = getImportableFiles(event.dataTransfer?.files, registry());
            if (!files) return false;
            event.preventDefault();
            run(view, files, dropPosition(view, event));
            return true;
          },
          handlePaste(view, event) {
            if (!options.enablePaste) return false;
            const files = getImportableFiles(event.clipboardData?.files, registry());
            if (!files) return false;
            event.preventDefault();
            run(view, files);
            return true;
          },
        },
      }),
    ];
  },
});
