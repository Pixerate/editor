/** Framework-free helpers behind the PSD buttons of the React and Svelte layer panels. */

import type { ImageEditorController } from '../controller';

/** Types the file pickers accept. */
export const PSD_FILE_ACCEPT = '.psd,.psb,image/vnd.adobe.photoshop,application/x-photoshop';

function blobBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/** Reads a picked file and opens it as the document (one undo step). Returns the import warnings. */
export async function openPsdFile(controller: ImageEditorController, file: Blob): Promise<string[]> {
  return controller.loadPsd(await blobBytes(file)).warnings;
}

/** A file name for the exported document: `name` with a `.psd` / `.psb` extension. */
export function psdFileName(name: string, psb: boolean): string {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '') || 'image';
  return `${base}.${psb ? 'psb' : 'psd'}`;
}

/**
 * Writes the document as a PSD and offers it as a download (in a browser). Returns the file
 * name and the export warnings.
 */
export async function downloadPsd(controller: ImageEditorController, name = 'image'): Promise<{ fileName: string; warnings: string[] }> {
  const res = await controller.toPsd();
  const fileName = psdFileName(name, res.psb);
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    const blob = new Blob([res.bytes as BlobPart], { type: 'image/vnd.adobe.photoshop' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { fileName, warnings: res.warnings };
}
