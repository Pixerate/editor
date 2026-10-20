import React from 'react';
import { PAINT_GRADIENT_KIT } from '@pixerate/editor/paint-editor';
import { PaintGradientEditorView, type PaintGradientEditorProps } from './PaintGradientEditorView';

export type { PaintGradientEditorProps } from './PaintGradientEditorView';

/** The gradient paint editor (see `PaintGradientEditorView`). */
export const PaintGradientEditor: React.FC<PaintGradientEditorProps> = (props) => <PaintGradientEditorView {...props} kit={PAINT_GRADIENT_KIT} />;
