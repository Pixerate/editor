import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  PIXERATE_DOCUMENT_MIME,
  getClipboardData,
  readRichClipboard,
  serializeRichClipboardPayload,
} from "../serializers/clipboard";
import { handleTablePasteWithoutNesting } from "./table/nesting";

export interface RichClipboardOptions {
  /** MIME type for the slice JSON (default `application/x.pixerate.document+json`). */
  mimeType?: string;
  /**
   * Never paste the rich payload; leave paste to the existing plain-text
   * handling. `EditorController` sets this automatically in `plainTextMode`.
   */
  plainTextMode?: boolean;
}

export interface RichClipboardStorage {
  plainTextMode: boolean;
}

export const richClipboardPluginKey = new PluginKey("richClipboard");

/**
 * Writes the selection to the clipboard event as HTML, plain text and the
 * custom slice JSON. Mirrors ProseMirror's own copy handler (which would
 * otherwise clear the extra MIME type) and returns `false` when the event has
 * no writable clipboard data, so ProseMirror's handler runs instead.
 */
export function writeRichClipboard(
  view: EditorView,
  event: ClipboardEvent,
  options: { cut?: boolean; mimeType?: string } = {},
): boolean {
  const { state } = view;
  if (state.selection.empty) return false;
  const data = getClipboardData(event);
  if (!data || typeof data.setData !== "function") return false;
  const slice = state.selection.content();
  const { dom, text } = view.serializeForClipboard(slice);
  event.preventDefault();
  data.clearData?.();
  data.setData("text/html", dom.innerHTML);
  data.setData("text/plain", text);
  data.setData(options.mimeType ?? PIXERATE_DOCUMENT_MIME, serializeRichClipboardPayload(slice, state.schema));
  if (options.cut && view.editable) {
    view.dispatch(state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
  }
  return true;
}

/**
 * Internal rich-text clipboard. On copy/cut it also writes the selection as a
 * ProseMirror slice under `application/x.pixerate.document+json` together
 * with the schema signature; on paste it prefers that payload when the
 * signature matches the target editor and otherwise falls back to the normal
 * HTML / plain-text handling.
 *
 * Opt-in: add it to `extensions` or pass `richClipboard: true` to
 * `createRichTextPreset`.
 */
export const RichClipboard = Extension.create<RichClipboardOptions, RichClipboardStorage>({
  name: "richClipboard",

  addOptions() {
    return {
      mimeType: PIXERATE_DOCUMENT_MIME,
      plainTextMode: false,
    };
  },

  addStorage() {
    return { plainTextMode: !!this.options.plainTextMode };
  },

  addProseMirrorPlugins() {
    const mimeType = this.options.mimeType ?? PIXERATE_DOCUMENT_MIME;
    const storage = this.storage;
    return [
      new Plugin({
        key: richClipboardPluginKey,
        props: {
          handleDOMEvents: {
            copy: (view, event) => writeRichClipboard(view, event, { mimeType }),
            cut: (view, event) => writeRichClipboard(view, event, { cut: true, mimeType }),
          },
          handlePaste(view, event) {
            if (storage.plainTextMode) return false;
            const slice = readRichClipboard(event, view.state.schema, mimeType);
            if (!slice) return false;
            event.preventDefault();
            // In a table: fill cells with a copied table, or put content
            // that contains a table after the table instead of nesting it.
            if (handleTablePasteWithoutNesting(view, event, slice)) return true;
            view.dispatch(
              view.state.tr
                .replaceSelection(slice)
                .scrollIntoView()
                .setMeta("paste", true)
                .setMeta("uiEvent", "paste"),
            );
            return true;
          },
        },
      }),
    ];
  },
});
