import React from 'react';
import { PAINT_GRADIENT_KIT } from '@pixerate/editor/image-editor';
import { PaintGradientEditorView, type PaintGradientEditorProps } from '../paint-editor/PaintGradientEditorView';

export type { PaintGradientEditorProps } from '../paint-editor/PaintGradientEditorView';

/** The gradient paint editor for the image editor's brush (see `PaintGradientEditorView`). */
export const PaintGradientEditor: React.FC<PaintGradientEditorProps> = (props) => <PaintGradientEditorView {...props} kit={PAINT_GRADIENT_KIT} />;
