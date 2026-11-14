import { describe, expect, it } from 'vitest';
import { annotationLayerFor, type Annotation } from '../src/image-editor';
import { deserializeLayers } from '../src/image-editor/layers/serialize';
import { deserializePaintDocument } from '../src/paint-editor';

// #848: a pen annotation without points, or a text annotation whose text is not a string, threw a
// bare TypeError and refused the whole document. Each field the migration reads is now checked.

const CANVAS = { width: 24, height: 20 };
const ann = (id: string, annotation: Record<string, unknown>) => ({ id, name: id, type: 'annotation', annotation });

/** Reads layers as the image editor does, returning the layers and the problems it reports. */
function read(layers: unknown[]) {
  const problems: string[] = [];
  const out = deserializeLayers(layers, { problems, canvas: CANVAS });
  return { layers: out, problems };
}

const pen = (fields: Record<string, unknown>) => ({ type: 'pen', strokeColor: '#000', ...fields });
const text = (fields: Record<string, unknown>) => ({ type: 'text', x: 2, y: 2, color: '#000', text: 'Note', ...fields });

describe('annotation fields (#848)', () => {
  it('reports a pen annotation without points and leaves only that layer out', () => {
    const { layers, problems } = read([{ id: 'p', name: 'Pixels', type: 'pixel' }, ann('a', pen({})), ann('b', pen({ points: [{ x: 1, y: 1 }, { x: 3, y: 2 }] }))]);
    expect(problems).toEqual(['Layer "a": the annotation could not be read (points must be an array of { x, y } points.)']);
    expect(layers.map((l) => [l.id, l.type])).toEqual([
      ['p', 'pixel'],
      ['b', 'shape'],
    ]);
  });

  it('reports points that are not an array', () => {
    for (const points of [null, 'ab', 5, { length: 2 }, true]) {
      const { layers, problems } = read([ann('a', pen({ points }))]);
      expect(layers).toEqual([]);
      expect(problems).toEqual(['Layer "a": the annotation could not be read (points must be an array of { x, y } points.)']);
    }
    // Rotated, the points were read by a different expression (`a.points.map`): same message.
    expect(read([ann('a', pen({ rotation: 5, x: 0, y: 0, points: { length: 2 } }))]).problems).toEqual(['Layer "a": the annotation could not be read (points must be an array of { x, y } points.)']);
  });

  it('reports points that are not { x, y } numbers, naming the first bad one', () => {
    const cases: [unknown[], number][] = [
      [[{ x: 1, y: 1 }, null], 1],
      [[{ x: 1, y: 1 }, { x: '3', y: 2 }], 1],
      [[{ x: 1 }], 0],
      [[[1, 2]], 0],
      [[1, 2], 0],
      [[{ x: 1, y: 1 }, { x: 2, y: 2 }, 'p'], 2],
    ];
    for (const [points, index] of cases) {
      expect(read([ann('a', pen({ points }))]).problems).toEqual([`Layer "a": the annotation could not be read (points[${index}] must be a point { x, y } with finite numbers.)`]);
    }
  });

  it('reports a text annotation whose text is not a string', () => {
    for (const value of [5, null, true, {}, ['hi']]) {
      const { layers, problems } = read([ann('t', text({ text: value }))]);
      expect(layers).toEqual([]);
      expect(problems).toEqual(['Layer "t": the annotation could not be read (text must be a string.)']);
    }
    const { problems } = read([{ id: 't', name: 'Note', type: 'annotation', annotation: { type: 'text', x: 2, y: 2, color: '#000' } }]);
    expect(problems).toEqual(['Layer "Note": the annotation could not be read (text must be a string.)']);
  });

  it('checks every field the shape and text migration reads', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'rect', x: 1, y: 1, width: '4', height: 3, strokeColor: '#f00' }, 'width must be a finite number.'],
      [{ type: 'rect', x: 1, width: 4, height: 3, strokeColor: '#f00' }, 'y must be a finite number.'],
      [{ type: 'rect', x: 1, y: 1, width: 4, height: 3, strokeColor: '#f00', strokeWidth: '2' }, 'strokeWidth must be a finite number.'],
      [{ type: 'circle', x: 5, y: 5, radiusX: null, radiusY: 3, strokeColor: 'red' }, 'radiusX must be a finite number.'],
      [{ type: 'circle', x: 5, y: 5, radiusX: 2, radiusY: 3, strokeColor: 'red', opacity: '0.5' }, 'opacity must be a finite number.'],
      [{ type: 'line', x: 1, y: 1, endX: 8, endY: [4], strokeColor: '#000' }, 'endY must be a finite number.'],
      [{ type: 'arrow', x: {}, y: 1, endX: 8, endY: 4, strokeColor: '#000' }, 'x must be a finite number.'],
      [{ type: 'arrow', x: 1, y: 1, endX: 8, endY: 4, strokeColor: '#000', rotation: '30' }, 'rotation must be a finite number.'],
      [pen({ points: [], rotation: 30, y: 1 }), 'x must be a finite number.'],
      [text({ x: '2' }), 'x must be a finite number.'],
      [text({ fontSize: '12' }), 'fontSize must be a finite number.'],
      [text({ fontFamily: 5 }), 'fontFamily must be a font family name.'],
      [text({ fontWeight: true }), 'fontWeight must be normal, bold or a number from 1 to 1000.'],
      [text({ rotation: {} }), 'rotation must be a finite number.'],
      [text({ opacity: 'half' }), 'opacity must be a finite number.'],
    ];
    for (const [annotation, message] of cases) {
      expect(read([ann('a', annotation)]).problems, JSON.stringify(annotation)).toEqual([`Layer "a": the annotation could not be read (${message})`]);
      expect(() => annotationLayerFor({ id: 'a', ...annotation } as unknown as Annotation, CANVAS)).toThrow(message);
    }
  });

  it('keeps tolerating what the canvas drew with defaults', () => {
    const { layers, problems } = read([
      ann('pen', pen({ points: [] })),
      ann('arrow', { type: 'arrow', x: 1, y: 1, endX: 8, endY: 4, strokeColor: '#000' }),
      ann('rect', { type: 'rect', x: 1, y: 1, width: 4, height: 3, strokeColor: '#f00', strokeWidth: null, opacity: null, rotation: null }),
      ann('text', text({ fontWeight: null, fontFamily: null, fontSize: null })),
    ]);
    expect(problems).toEqual([]);
    expect(layers.map((l) => l.type)).toEqual(['shape', 'shape', 'shape', 'type']);
    // An arrow without a stroke width has the 12 px arrowhead of a 1 px canvas line (not NaN).
    const arrow = layers[1] as Extract<(typeof layers)[number], { type: 'shape' }>;
    expect(JSON.stringify(arrow.components)).not.toContain('null');
    expect(arrow.components[0].live).toMatchObject({ endArrow: { width: 12 } });
    const type = layers[3] as Extract<(typeof layers)[number], { type: 'type' }>;
    expect(type.runs[0].style.fontWeight).toBe(400);
  });

  it('leaves an annotation whose colour it cannot read as an annotation layer, before checking its fields', () => {
    const { layers, problems } = read([ann('a', pen({ strokeColor: 'nope' })), ann('t', { type: 'text', color: 'nope', text: 5 })]);
    expect(problems).toEqual([]);
    expect(layers.map((l) => [l.id, l.type])).toEqual([
      ['a', 'annotation'],
      ['t', 'annotation'],
    ]);
  });

  it('reports a malformed annotation inside a shape layer as the shape problem', () => {
    const { problems } = read([{ id: 's', name: 'From a pen', type: 'shape', annotation: { type: 'pen', strokeColor: '#00f' } }]);
    expect(problems).toEqual(['Layer "From a pen": the shape could not be read (points must be an array of { x, y } points.)']);
  });

  it('still loads the rest of a paint document', () => {
    const loaded = deserializePaintDocument({
      format: 'pixerate-paint',
      version: 2,
      width: 24,
      height: 20,
      paper: { color: '#ffffff' },
      layers: [
        { id: 'p', name: 'Kept', type: 'pixel' },
        ann('pen', pen({})),
        { id: 'g', name: 'Group', type: 'group', children: [ann('t', text({ text: 5 })), { id: 'gp', name: 'Inner', type: 'pixel' }] },
        ann('bad-points', pen({ points: 'ab' })),
      ],
      assets: {},
    });
    expect(loaded.problems).toEqual([
      'Layer "pen": the annotation could not be read (points must be an array of { x, y } points.)',
      'Layer "t": the annotation could not be read (text must be a string.)',
      'Layer "bad-points": the annotation could not be read (points must be an array of { x, y } points.)',
    ]);
    expect(loaded.state.layers.map((l) => l.id)).toEqual(['p', 'g']);
    expect(loaded.state.activeLayerId).toBe('gp');
  });
});
