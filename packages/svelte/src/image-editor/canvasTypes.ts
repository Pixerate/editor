/** What pointer gestures on `ImageEditorCanvas` do (and whether the crop overlay shows). */
export type ImageEditorCanvasMode = 'crop' | 'select' | 'paint' | 'annotate' | 'none';
/** Which gesture an `ImageEditorCanvas` `onerror` report comes from. */
export type ImageEditorCanvasErrorSource = 'paint' | 'select' | 'shape' | 'type';
