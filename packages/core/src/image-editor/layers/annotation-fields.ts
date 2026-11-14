/**
 * The checks the annotation migration (`shapeFromAnnotation`, `typeFromAnnotation`) runs on the
 * fields it reads, so a damaged annotation in a stored document is reported with what is wrong
 * instead of throwing a bare `TypeError` or drawing `NaN` geometry. Each check throws a
 * `LayerOperationError` the document reader turns into a layer problem (the layer is left out).
 *
 * Optional fields may be left out or `null` (as `??` and the canvas defaults treat them).
 */

import type { Annotation } from '../types';
import { LayerOperationError } from './ops';

type Fields = Record<string, unknown>;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Throws unless `a[key]` is a finite number (or, when `optional`, left out or `null`). */
export function checkAnnotationNumber(a: Annotation, key: string, optional = false): void {
  const v = (a as unknown as Fields)[key];
  if (optional && (v === undefined || v === null)) return;
  if (!isFiniteNumber(v)) throw new LayerOperationError(`${key} must be a finite number.`);
}

/** Throws unless a pen's `points` is an array of `{ x, y }` points with finite coordinates. */
export function checkAnnotationPoints(a: Annotation): void {
  const pts = (a as unknown as Fields).points;
  if (!Array.isArray(pts)) throw new LayerOperationError('points must be an array of { x, y } points.');
  pts.forEach((p: unknown, i: number) => {
    const o = p && typeof p === 'object' && !Array.isArray(p) ? (p as Fields) : null;
    if (!o || !isFiniteNumber(o.x) || !isFiniteNumber(o.y)) throw new LayerOperationError(`points[${i}] must be a point { x, y } with finite numbers.`);
  });
}

/**
 * The fields a shape annotation (pen, rectangle, ellipse, line, arrow) draws with, checked in a
 * fixed order: its geometry, then `strokeWidth`, `opacity` and `rotation`. A pen's `x` and `y` are
 * only read as the centre of a rotation.
 */
export function checkShapeAnnotationFields(a: Annotation): void {
  const geometry: Record<string, string[]> = {
    rect: ['x', 'y', 'width', 'height'],
    circle: ['x', 'y', 'radiusX', 'radiusY'],
    line: ['x', 'y', 'endX', 'endY'],
    arrow: ['x', 'y', 'endX', 'endY'],
  };
  if (a.type === 'pen') checkAnnotationPoints(a);
  for (const key of geometry[a.type] ?? []) checkAnnotationNumber(a, key);
  checkAnnotationNumber(a, 'strokeWidth', true);
  checkAnnotationNumber(a, 'opacity', true);
  checkAnnotationNumber(a, 'rotation', true);
  if (a.type === 'pen' && a.rotation) {
    checkAnnotationNumber(a, 'x');
    checkAnnotationNumber(a, 'y');
  }
}

/** The fields a text annotation draws with, checked after its colour and weight are read. */
export function checkTextAnnotationFields(a: Annotation): void {
  const f = a as unknown as Fields;
  if (typeof f.text !== 'string') throw new LayerOperationError('text must be a string.');
  checkAnnotationNumber(a, 'x');
  checkAnnotationNumber(a, 'y');
  checkAnnotationNumber(a, 'fontSize', true);
  if (f.fontFamily !== undefined && f.fontFamily !== null && typeof f.fontFamily !== 'string') throw new LayerOperationError('fontFamily must be a font family name.');
  checkAnnotationNumber(a, 'opacity', true);
  checkAnnotationNumber(a, 'rotation', true);
}

/** Throws unless a text annotation's `fontWeight` is left out, `null`, a string or a number. */
export function checkAnnotationFontWeight(a: Annotation): void {
  const w = (a as unknown as Fields).fontWeight;
  if (w === undefined || w === null || typeof w === 'string' || typeof w === 'number') return;
  throw new LayerOperationError('fontWeight must be normal, bold or a number from 1 to 1000.');
}
