export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AspectRatio = number | null;

export interface ImageTransform {
  rotate: number; // in degrees, e.g. 0, 90, 180, 270 or arbitrary
  flipH: boolean;
  flipV: boolean;
}

export interface ImageAdjustments {
  brightness: number; // -100 to 100, 0 is default
  contrast: number; // -100 to 100, 0 is default
  saturation: number; // -100 to 100, 0 is default
  exposure: number; // -100 to 100, 0 is default
  temperature: number; // -100 to 100, 0 is default (warmth/coolness)
  blur: number; // 0 to 50, 0 is default
  opacity: number; // 0 to 1, 1 is default
}

export interface DepthMaskOptions {
  enabled: boolean;
  maskSource: string | null;
  mode: 'threshold' | 'brightness';
  depthRange: [number, number]; // [start, stop] e.g. [0, 255]
  softness: number; // default 10
  invert: boolean;
}

export type AnnotationType = 'pen' | 'rect' | 'circle' | 'arrow' | 'line' | 'text' | 'image';

export interface BaseAnnotation {
  id: string;
  type: AnnotationType;
  x: number;
  y: number;
  rotation?: number;
  opacity?: number;
}

export interface PenAnnotation extends BaseAnnotation {
  type: 'pen';
  points: ImagePoint[];
  strokeColor: string;
  strokeWidth: number;
}

export interface RectAnnotation extends BaseAnnotation {
  type: 'rect';
  width: number;
  height: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  cornerRadius?: number;
}

export interface CircleAnnotation extends BaseAnnotation {
  type: 'circle';
  radiusX: number;
  radiusY: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
}

export interface ArrowAnnotation extends BaseAnnotation {
  type: 'arrow';
  endX: number;
  endY: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface LineAnnotation extends BaseAnnotation {
  type: 'line';
  endX: number;
  endY: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: 'text';
  text: string;
  fontSize: number;
  fontFamily?: string;
  color: string;
  fontWeight?: string | number;
}

export interface ImageAnnotation extends BaseAnnotation {
  type: 'image';
  src: string;
  width: number;
  height: number;
}

export type Annotation =
  | PenAnnotation
  | RectAnnotation
  | CircleAnnotation
  | ArrowAnnotation
  | LineAnnotation
  | TextAnnotation
  | ImageAnnotation;

export type CreateAnnotationPayload =
  | Omit<PenAnnotation, 'id'>
  | Omit<RectAnnotation, 'id'>
  | Omit<CircleAnnotation, 'id'>
  | Omit<ArrowAnnotation, 'id'>
  | Omit<LineAnnotation, 'id'>
  | Omit<TextAnnotation, 'id'>
  | Omit<ImageAnnotation, 'id'>;

export type ImageEditorTool =
  | 'select'
  | 'crop'
  | 'pen'
  | 'rect'
  | 'circle'
  | 'arrow'
  | 'line'
  | 'text'
  | 'watermark';

export interface ImageEditorState {
  sourceUrl: string | null;
  imageDimensions: ImageDimensions;
  crop: CropBox | null;
  transform: ImageTransform;
  adjustments: ImageAdjustments;
  depthMask: DepthMaskOptions;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  activeTool: ImageEditorTool;
  zoom: number;
  pan: ImagePoint;
  isOriginalCompared: boolean;
}

export interface SerializedImageEditorState {
  version: 1;
  crop: CropBox | null;
  transform: ImageTransform;
  adjustments: ImageAdjustments;
  depthMask: DepthMaskOptions;
  annotations: Annotation[];
}

export interface ExportOptions {
  format?: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number; // 0 to 1
  width?: number;
  height?: number;
  includeAnnotations?: boolean;
}

export interface ImageEditorOptions {
  image?: string | HTMLImageElement;
  initialState?: Partial<SerializedImageEditorState>;
  onStateChange?: (state: ImageEditorState) => void;
  maxHistoryDepth?: number;
}
