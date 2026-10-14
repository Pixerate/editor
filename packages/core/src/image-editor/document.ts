import {
  loadDocument,
  type JsonObject,
  type LoadReport,
  type MigrationStep,
} from '../persistence/migrate';
import { DEFAULT_DEPTH_MASK, DEFAULT_TRANSFORM, normalizeStoredAdjustments } from './controller';
import type {
  Annotation,
  CropBox,
  DepthMaskOptions,
  ImageAdjustments,
  ImageTransform,
  SerializedImageEditorState,
} from './types';
import { deserializeSelection } from './selection/mask';

/** The `version` that `ImageEditorController.toJSON()` writes. */
export const IMAGE_EDITOR_STATE_VERSION = 1;

/**
 * Migration steps for `SerializedImageEditorState`, keyed by the version they
 * start from. Empty while only version 1 exists.
 */
export const imageEditorStateMigrations: Record<number, MigrationStep> = {};

export interface ImageEditorDocumentLoad {
  /** State to pass to `loadJSON` / `initialState`. */
  state: SerializedImageEditorState;
  report: LoadReport;
  /** Top-level keys this build does not know; spread them into the saved JSON to keep them. */
  unknown: JsonObject;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${what} must be an object`);
  return value;
}

function checkFields(
  value: Record<string, unknown>,
  types: Record<string, (v: unknown) => boolean>,
  what: string,
) {
  for (const [field, ok] of Object.entries(types)) {
    if (field in value && value[field] !== undefined && !ok(value[field])) {
      throw new Error(`${what}.${field} has an invalid value`);
    }
  }
}

const isBoolean = (v: unknown) => typeof v === 'boolean';

function parseCrop(value: unknown): CropBox | null {
  if (value === null) return null;
  const crop = expectObject(value, 'crop');
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    if (!isNumber(crop[field])) throw new Error(`crop.${field} must be a number`);
  }
  return { ...(crop as unknown as CropBox) };
}

function parseTransform(value: unknown): ImageTransform {
  const transform = expectObject(value, 'transform');
  checkFields(transform, { rotate: isNumber, flipH: isBoolean, flipV: isBoolean }, 'transform');
  return { ...DEFAULT_TRANSFORM, ...(transform as Partial<ImageTransform>) };
}

const ADJUSTMENT_NUMBERS = [
  'brightness',
  'contrast',
  'saturation',
  'exposure',
  'temperature',
  'tint',
  'blur',
  'opacity',
] as const;

function parseAdjustments(value: unknown): ImageAdjustments {
  const adjustments = expectObject(value, 'adjustments');
  checkFields(
    adjustments,
    {
      ...Object.fromEntries(ADJUSTMENT_NUMBERS.map((k) => [k, isNumber])),
      process: (v) => v === 1 || v === 2,
    },
    'adjustments',
  );
  // Kept as stored: `loadJSON` fills defaults and keeps a missing `process` legacy.
  return { ...(adjustments as unknown as ImageAdjustments) };
}

function parseDepthMask(value: unknown): DepthMaskOptions {
  const mask = expectObject(value, 'depthMask');
  checkFields(
    mask,
    {
      enabled: isBoolean,
      maskSource: (v) => v === null || typeof v === 'string',
      mode: (v) => v === 'threshold' || v === 'brightness',
      depthRange: (v) => Array.isArray(v) && v.length === 2 && v.every(isNumber),
      softness: isNumber,
      invert: isBoolean,
    },
    'depthMask',
  );
  const merged = { ...DEFAULT_DEPTH_MASK, ...(mask as Partial<DepthMaskOptions>) };
  return { ...merged, depthRange: [...merged.depthRange] as [number, number] };
}

const ANNOTATION_TYPES = new Set(['pen', 'rect', 'circle', 'arrow', 'line', 'text', 'image']);

const isAnnotation = (value: unknown): value is Annotation =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.type === 'string' &&
  ANNOTATION_TYPES.has(value.type) &&
  isNumber(value.x) &&
  isNumber(value.y);

/**
 * Loads stored image editor state (a JSON string or object) with a `LoadReport`:
 *
 * - Runs `imageEditorStateMigrations` up to `IMAGE_EDITOR_STATE_VERSION`; a missing
 *   `version` is taken as current.
 * - A newer `version` is still loaded but reported `readOnly`: do not save over it.
 * - Each section (`crop`, `transform`, `adjustments`, `depthMask`, `annotations`, and the
 *   optional run-length encoded `selection`)
 *   falls back to its default on its own; invalid annotations are dropped one by one.
 * - Unknown top-level keys are returned in `unknown`.
 *
 * Valid state from `toJSON()` comes back unchanged, so `loadJSON(state)` behaves
 * exactly as with the raw object.
 */
export function loadImageEditorDocument(input: unknown): ImageEditorDocumentLoad {
  let dropped = 0;
  const result = loadDocument<Omit<SerializedImageEditorState, 'version'>>(
    input,
    {
      crop: { parse: parseCrop, defaults: null },
      transform: { parse: parseTransform, defaults: () => ({ ...DEFAULT_TRANSFORM }) },
      adjustments: {
        parse: parseAdjustments,
        // Same as what `loadJSON` derives from missing adjustments.
        defaults: () => normalizeStoredAdjustments(undefined),
      },
      depthMask: {
        parse: parseDepthMask,
        defaults: () => ({ ...DEFAULT_DEPTH_MASK, depthRange: [...DEFAULT_DEPTH_MASK.depthRange] as [number, number] }),
      },
      annotations: {
        parse: (value) => {
          if (!Array.isArray(value)) throw new Error('annotations must be an array');
          const kept = value.filter(isAnnotation);
          dropped = value.length - kept.length;
          return JSON.parse(JSON.stringify(kept)) as Annotation[];
        },
        defaults: () => [],
      },
      // Optional: only present when something was selected when saving.
      selection: {
        parse: (value) => {
          const mask = deserializeSelection(value);
          const v = value as { rle: string };
          return { width: mask.width, height: mask.height, rle: v.rle };
        },
        defaults: undefined,
      },
    },
    {
      currentVersion: IMAGE_EDITOR_STATE_VERSION,
      steps: imageEditorStateMigrations,
    },
  );
  if (dropped > 0) {
    result.report.problems.push({
      section: 'annotations',
      message: `${dropped} invalid annotation${dropped === 1 ? '' : 's'} dropped`,
    });
  }
  const state = { version: 1, ...result.value } as SerializedImageEditorState;
  if (state.selection === undefined) delete state.selection;
  return { state, report: result.report, unknown: result.unknown };
}
