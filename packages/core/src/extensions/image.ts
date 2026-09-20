import * as _Image from "@tiptap/extension-image";
import type { ImageOptions as TipTapImageOptions } from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const resolveExt = (mod: any, name: string) =>
  mod?.[name] ||
  mod?.default?.[name] ||
  mod?.default?.default ||
  mod?.default ||
  mod;

const BaseImage = resolveExt(_Image, "Image");

export interface ImageOptions extends Partial<TipTapImageOptions> {
  /**
   * Custom upload handler called when an image is pasted or dropped.
   * Resolves to the uploaded image URL string.
   */
  upload?: (file: File) => Promise<string> | string;

  /**
   * Whether to enable automatic image pasting from clipboard. Defaults to true.
   */
  enablePaste?: boolean;

  /**
   * Whether to enable automatic image drop. Defaults to true.
   */
  enableDrop?: boolean;
}

export const imagePastePluginKey = new PluginKey("imagePasteHandler");

/**
 * Inserts an image node into the editor view at the current selection.
 */
export function insertImageNode(view: any, src: string, alt?: string) {
  const { schema } = view.state;
  const imageType = schema.nodes.image;
  if (!imageType) return;
  const node = imageType.create({ src, alt: alt || "" });
  const tr = view.state.tr.replaceSelectionWith(node);
  view.dispatch(tr);
}

/**
 * Updates an existing image node's src attribute across document positions.
 */
export function updateImageSrc(view: any, oldSrc: string, newSrc: string) {
  const { doc } = view.state;
  let foundPos: number | null = null;
  let foundAttrs: any = null;

  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "image" && node.attrs.src === oldSrc) {
      foundPos = pos;
      foundAttrs = node.attrs;
      return false;
    }
  });

  if (foundPos !== null && foundAttrs) {
    const tr = view.state.tr.setNodeMarkup(foundPos, undefined, {
      ...foundAttrs,
      src: newSrc,
    });
    view.dispatch(tr);
  }
}

/**
 * Handles inserting a pasted or dropped image file, supporting both async upload
 * handlers and direct base64/object-URL fallbacks.
 */
export function handleImageInsertion(
  view: any,
  file: File,
  options: ImageOptions,
) {
  if (typeof options.upload === "function") {
    // Generate temporary preview URL if browser supports object URLs
    const hasObjectUrl =
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
    const tempUrl = hasObjectUrl ? URL.createObjectURL(file) : null;

    if (tempUrl) {
      insertImageNode(view, tempUrl, file.name);
    }

    Promise.resolve(options.upload(file))
      .then((uploadedUrl) => {
        if (!uploadedUrl) return;
        if (tempUrl) {
          updateImageSrc(view, tempUrl, uploadedUrl);
          if (typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(tempUrl);
          }
        } else {
          insertImageNode(view, uploadedUrl, file.name);
        }
      })
      .catch((err) => {
        console.error("Failed to upload pasted image:", err);
      });
  } else if (options.allowBase64 !== false) {
    if (typeof FileReader !== "undefined") {
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        if (src) {
          insertImageNode(view, src, file.name);
        }
      };
      reader.readAsDataURL(file);
    }
  }
}

export const Image = BaseImage.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      allowBase64: true,
      enablePaste: true,
      enableDrop: true,
      upload: undefined,
      HTMLAttributes: {
        class: "rounded-md max-w-full h-auto my-2",
      },
    };
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() || [];
    const options = this.options as ImageOptions;

    if (!options.enablePaste && !options.enableDrop) {
      return parentPlugins;
    }

    const pastePlugin = new Plugin({
      key: imagePastePluginKey,
      props: {
        handlePaste(view, event) {
          if (!options.enablePaste) return false;
          const items = Array.from(event.clipboardData?.items || []);
          const imageItems = items.filter(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          );
          if (imageItems.length === 0) return false;

          event.preventDefault();

          for (const item of imageItems) {
            const file = item.getAsFile();
            if (!file) continue;
            handleImageInsertion(view, file, options);
          }
          return true;
        },
        handleDrop(view, event) {
          if (!options.enableDrop) return false;
          const files = Array.from(event.dataTransfer?.files || []);
          const imageFiles = files.filter((f) => f.type.startsWith("image/"));
          if (imageFiles.length === 0) return false;

          event.preventDefault();

          for (const file of imageFiles) {
            handleImageInsertion(view, file, options);
          }
          return true;
        },
      },
    });

    return [...parentPlugins, pastePlugin];
  },
});
