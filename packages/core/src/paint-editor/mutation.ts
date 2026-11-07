import type { RasterRect } from '../raster/surface';
import type { PaintBrush } from './brush-model';
import type { PaintStrokeInit } from './controller';
import type { PenPoint } from './engine';

export type PaintMutationState = 'settling' | 'pending' | 'claimed' | 'answered' | 'declined';

export type PaintMutationMedium = 'wet' | 'dry';

export interface PaintMutationStroke {
  id: string;
  color: string;
  brushId: string;
  brushName: string;
  size: number;
  points: PenPoint[];
  bounds: RasterRect | null;
}

export interface PaintMutationInfo {
  id: string;
  state: PaintMutationState;
  layerId: string;
  medium: PaintMutationMedium;
  bounds: RasterRect | null;
  strokeCount: number;
  age: number;
  settle: number;
  patience: number;
  fade: number;
  claimedBy?: string;
  answerStrokeIds?: string[];
  declineReason?: string;
}

export interface PaintMutationPng {
  width: number;
  height: number;
  data: string;
}

export interface PaintMutationCropPng extends PaintMutationPng {
  rect: RasterRect;
}

export interface PaintMutationReadResult {
  id: string;
  state: 'claimed';
  layerId: string;
  medium: PaintMutationMedium;
  bounds: RasterRect | null;
  fade: number;
  strokes: PaintMutationStroke[];
  cropPng: PaintMutationCropPng;
  canvasPng: PaintMutationPng;
}

export interface PaintMutationAnswerInput {
  strokes: ReadonlyArray<PaintStrokeInit & { points: readonly PenPoint[] }>;
  layerId?: string;
  note?: string;
}

export interface PaintMutationAnswerResult {
  id: string;
  state: 'answered';
  layerId: string;
  strokeIds: string[];
  bounds: RasterRect | null;
  dabs: number;
  wet?: boolean;
}

export type PaintMutationRequestListener = (mutation: PaintMutationInfo) => void;

export function mutationBrushRefusal(brush: PaintBrush): string | null {
  if (!brush.mutation) return null;
  if (
    brush.engine === 'eraser' ||
    brush.engine === 'blender' ||
    brush.engine === 'smudge' ||
    brush.engine === 'mixer' ||
    brush.engine === 'sticker'
  ) {
    return `Mutation paint adds strokes that fade when an agent reads them; ${brush.engine} brushes cannot use mutation.`;
  }
  if ((brush.behavior?.pickup ?? 0) > 0 || brush.behavior?.dirty) {
    return 'Mutation brushes cannot pick up canvas colour (behavior.pickup must be 0 and behavior.dirty false).';
  }
  if (brush.engine === 'wet') {
    const tool = brush.wet?.tool ?? 'paint';
    if (tool !== 'paint') {
      return `Wet mutation brushes must use wet.tool: "paint" (got "${tool}").`;
    }
    if ((brush.light?.amount ?? 0) > 0) {
      return 'Wet mutation brushes use the wet light channel to track fading paint, so light.amount must be 0.';
    }
  }
  return null;
}
