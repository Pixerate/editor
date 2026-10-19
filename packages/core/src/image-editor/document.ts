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
  LegacySerializedImageEditorState,
  SerializedImageEditorState,
} from './types';
import { deserializeSelection } from './selection/mask';
import type { SerializedLayer, SerializedLayeredImageEditorState } from './layers/serialize';

/**
 * The newest `version` that `ImageEditorController.toJSON()` writes (3: layers). Documents whose
 * layers still have the old shape are written as version 1 or 2.
 */
export const IMAGE_EDITOR_STATE_VERSION = 3;

/**
 * Migration steps for the document-level schema (versions 1 and 2), keyed by the version they
 * start from. Empty: version 2 only adds `adjustments.layers`, which version 1 readers keep.
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
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = input;
    }
  }
  if (isObject(parsed) && parsed.version === 3) return loadLayeredDocument(parsed);
  // Version 2 only adds `adjustments.layers`, which the version 1 sections keep as stored.
  const isV2 = isObject(parsed) && parsed.version === 2;
  if (isV2) parsed = { ...(parsed as Record<string, unknown>), version: 1 };
  const newer = isObject(parsed) && typeof parsed.version === 'number' && parsed.version > IMAGE_EDITOR_STATE_VERSION;
  let dropped = 0;
  const result = loadDocument<Omit<LegacySerializedImageEditorState, 'version'>>(
    parsed,
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
      // Versions 1 and 2 load as one schema; anything newer than 3 is reported read-only.
      currentVersion: newer ? IMAGE_EDITOR_STATE_VERSION : 1,
      steps: imageEditorStateMigrations,
    },
  );
  if (dropped > 0) {
    result.report.problems.push({
      section: 'annotations',
      message: `${dropped} invalid annotation${dropped === 1 ? '' : 's'} dropped`,
    });
  }
  const state = { version: 1, ...result.value } as LegacySerializedImageEditorState;
  if (isV2) {
    if (state.adjustments.layers?.length) state.version = 2;
    result.report.version = 2;
  }
  if (state.selection === undefined) delete state.selection;
  return { state, report: result.report, unknown: result.unknown };
}

const LAYER_TYPES = new Set(['pixel', 'adjustment', 'group', 'annotation', 'smart', 'shape', 'type']);

/** Keeps layers that have an id-like shape and a known type (children checked too); counts the rest. */
function cleanLayers(value: unknown[], dropped: { count: number }): SerializedLayer[] {
  const out: SerializedLayer[] = [];
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.type !== 'string' || !LAYER_TYPES.has(raw.type)) {
      dropped.count++;
      continue;
    }
    if (raw.type === 'group') {
      const children = Array.isArray(raw.children) ? cleanLayers(raw.children, dropped) : [];
      out.push({ ...(raw as unknown as SerializedLayer), children } as SerializedLayer);
    } else out.push(JSON.parse(JSON.stringify(raw)) as SerializedLayer);
  }
  return out;
}

/** Version 3 (layers): each section falls back on its own; unreadable layers are dropped one by one. */
function loadLayeredDocument(doc: Record<string, unknown>): ImageEditorDocumentLoad {
  const dropped = { count: 0 };
  const result = loadDocument<Omit<SerializedLayeredImageEditorState, 'version'>>(
    doc,
    {
      width: { parse: (v) => (isNumber(v) && v > 0 ? v : (() => { throw new Error('width must be a positive number'); })()), defaults: 0 },
      height: { parse: (v) => (isNumber(v) && v > 0 ? v : (() => { throw new Error('height must be a positive number'); })()), defaults: 0 },
      layers: {
        parse: (value) => {
          if (!Array.isArray(value)) throw new Error('layers must be an array');
          return cleanLayers(value, dropped);
        },
        defaults: () => [],
      },
      assets: {
        parse: (value) => {
          const assets = expectObject(value, 'assets');
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(assets)) if (typeof v === 'string') out[k] = v;
          return out;
        },
        defaults: () => ({}),
      },
      activeLayerId: { parse: (v) => (v === null || typeof v === 'string' ? v : null), defaults: null },
      crop: { parse: parseCrop, defaults: null },
      transform: { parse: parseTransform, defaults: () => ({ ...DEFAULT_TRANSFORM }) },
      opacity: {
        parse: (v) => {
          if (!isNumber(v)) throw new Error('opacity must be a number');
          return Math.min(1, Math.max(0, v));
        },
        defaults: 1,
      },
      legacyOutputBlur: {
        parse: (v) => {
          if (!isNumber(v)) throw new Error('legacyOutputBlur must be a number');
          return Math.max(0, v);
        },
        defaults: undefined,
      },
      selection: {
        parse: (value) => {
          const mask = deserializeSelection(value);
          const v = value as { rle: string };
          return { width: mask.width, height: mask.height, rle: v.rle };
        },
        defaults: undefined,
      },
      smartContents: {
        parse: (value) => {
          if (!Array.isArray(value)) throw new Error('smartContents must be an array');
          // Entries are checked one by one when the layers load; keep the ones with an id.
          return value.filter((c) => isObject(c) && typeof c.id === 'string').map((c) => JSON.parse(JSON.stringify(c)));
        },
        defaults: undefined,
      },
    },
    { currentVersion: 3, steps: {} },
  );
  if (dropped.count > 0) {
    result.report.problems.push({
      section: 'layers',
      message: `${dropped.count} invalid layer${dropped.count === 1 ? '' : 's'} dropped`,
    });
  }
  const state = { version: 3, ...result.value } as SerializedLayeredImageEditorState;
  if (state.selection === undefined) delete state.selection;
  if (state.legacyOutputBlur === undefined) delete state.legacyOutputBlur;
  if (state.smartContents === undefined) delete state.smartContents;
  return { state, report: result.report, unknown: result.unknown };
}
