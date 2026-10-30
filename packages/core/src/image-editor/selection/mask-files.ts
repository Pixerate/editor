/** Framework-free helpers behind the Import and Export PNG buttons of the React and Svelte Channels panels. */

import type { ImageEditorController, MaskImageSource } from '../controller';
import type { AlphaChannel } from './channels';

/** Types the mask file pickers accept. */
export const MASK_FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

function blobDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** A channel name from a file name: without its extension, or `Alpha n`. */
export function maskNameFromFile(file: Blob): string | undefined {
  const name = (file as Partial<File>).name;
  return name ? name.replace(/\.[a-z0-9]{2,4}$/i, '').trim() || undefined : undefined;
}

/** Reads a picked mask image (white = selected) into a new alpha channel named after the file (one undo step). */
export async function openMaskFile(controller: ImageEditorController, file: Blob): Promise<AlphaChannel> {
  return controller.loadChannelFromImage(await blobDataUrl(file), { name: maskNameFromFile(file) });
}

/** A file name for an exported mask: `name` with a `.png` extension. */
export function maskFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'mask';
  return `${base}.png`;
}

/**
 * Writes the selection, a channel or a layer mask as a full-size greyscale PNG and offers it as a
 * download (in a browser). Returns the file name and size.
 */
export function downloadMaskImage(controller: ImageEditorController, source: MaskImageSource, name = 'mask'): { fileName: string; width: number; height: number } {
  const { dataUrl, width, height } = controller.exportMaskImage(source);
  const fileName = maskFileName(name);
  if (typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    a.click();
  }
  return { fileName, width, height };
}
