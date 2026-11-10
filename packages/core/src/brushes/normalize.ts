/**
 * `normalizeBrushSpec`: a brush with every given field checked against `BRUSH_JSON_SCHEMA`. It
 * stays sparse (missing fields are not filled in): numbers are clamped into range, integers
 * rounded, unknown fields, bad values and facets the brush does not use are dropped, and each
 * change is reported in `problems` so a caller (or an agent) sees what was fixed. Only an id,
 * name or kind it cannot make sense of throws.
 */

import { readPaintSource } from '../paint/gradient-paint';
import { validateJsonSchema, type JsonSchema } from '../tools/schema';
import { editorStampOf, normalizeStickerRef } from '../stickers/helpers';
import { BRUSH_ID } from '../paint-editor/brushes';
import { BRUSH_FACET_SCHEMAS, BRUSH_JSON_SCHEMA, MAX_BRUSH_PALETTE } from './schema';
import { isBrushSourceRef } from './sources';
import { BRUSH_TOOLS, type Brush, type BrushKind, type BrushPaint, type BrushTool } from './types';

/** The tools that work on the wet layer. */
export const WET_BRUSH_TOOLS: readonly BrushTool[] = ['water', 'dryer', 'blow', 'blot', 'wet-blend', 'wet-drag'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SOLID = new RegExp(String((BRUSH_FACET_SCHEMAS.paint.anyOf![0] as JsonSchema).pattern));

/** A value read against `schema`, or `undefined` when it cannot be used. */
function read(value: unknown, schema: JsonSchema, path: string, problems: string[]): unknown {
  if (schema.const !== undefined) {
    if (value === schema.const) return value;
    problems.push(`${path} must be ${JSON.stringify(schema.const)}; dropped.`);
    return undefined;
  }
  if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return null;
  const schemaType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (schemaType) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${path} must be a number; dropped.`);
        return undefined;
      }
      let n = schemaType === 'integer' ? Math.round(value) : value;
      if (schema.minimum !== undefined && n < schema.minimum) n = schema.minimum;
      if (schema.maximum !== undefined && n > schema.maximum) n = schema.maximum;
      if (n !== value) problems.push(`${path} ${value} is out of range (${schema.minimum}..${schema.maximum}${schemaType === 'integer' ? ', whole' : ''}); set to ${n}.`);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      problems.push(`${path} must be true or false; dropped.`);
      return undefined;
    case 'string': {
      const ok = typeof value === 'string' && (!schema.enum || schema.enum.includes(value)) && (!schema.pattern || new RegExp(schema.pattern).test(value)) && value.length >= (schema.minLength ?? 0);
      if (!ok) {
        problems.push(`${path} ${JSON.stringify(value)} is not valid${schema.enum ? `; use one of ${schema.enum.join(', ')}` : ''}; dropped.`);
        return undefined;
      }
      const s = schema.pattern === '^#[0-9a-fA-F]{6}$' ? value.toLowerCase() : value;
      return schema.maxLength !== undefined ? s.slice(0, schema.maxLength) : s;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        problems.push(`${path} must be a list; dropped.`);
        return undefined;
      }
      let items = value.map((v, i) => (schema.items ? read(v, schema.items, `${path}[${i}]`, problems) : v)).filter((v) => v !== undefined);
      if (schema.uniqueItems) items = [...new Set(items)];
      if (schema.maxItems !== undefined && items.length > schema.maxItems) {
        problems.push(`${path} has more than ${schema.maxItems} items; the rest were dropped.`);
        items = items.slice(0, schema.maxItems);
      }
      if (schema.minItems !== undefined && items.length < schema.minItems) {
        problems.push(`${path} needs at least ${schema.minItems} valid item(s); dropped.`);
        return undefined;
      }
      return items;
    }
    case 'object':
      return readObject(value, schema, path, problems);
    default:
      return value;
  }
}

function readObject(value: unknown, schema: JsonSchema, path: string, problems: string[]): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    problems.push(`${path} must be an object; dropped.`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const child = schema.properties?.[key];
    if (!child) {
      problems.push(`${path}.${key} is not a brush field; dropped.`);
      continue;
    }
    const r = read(v, child, `${path}.${key}`, problems);
    if (r !== undefined) out[key] = r;
  }
  return out;
}

/** A colour, or `undefined` when it is none of the colour kinds. */
function readPaint(value: unknown, path: string, problems: string[]): BrushPaint | undefined {
  if (typeof value === 'string') {
    if (SOLID.test(value.trim())) return value.trim().toLowerCase();
  } else if (isObject(value) && value.type === 'gradient') {
    const g = readPaintSource(value);
    if (g && g.type === 'gradient') return g;
  } else if (isObject(value) && value.type === 'effect') {
    if (!validateJsonSchema(value, BRUSH_FACET_SCHEMAS.paint.anyOf![3] as JsonSchema).length) return clone(value) as unknown as BrushPaint;
  } else if (isObject(value) && typeof value.light === 'string' && typeof value.dark === 'string' && Object.keys(value).length === 2) {
    if (SOLID.test(value.light.trim()) && SOLID.test(value.dark.trim())) return { light: value.light.trim().toLowerCase(), dark: value.dark.trim().toLowerCase() };
  }
  problems.push(`${path} is not a colour (#rrggbb, #rrggbbaa, rgba(), { light, dark }, a gradient or effect paint); dropped.`);
  return undefined;
}

/**
 * A brush with every given field in range (see the module comment). Throws when the id, name or
 * kind cannot be used; every other fix is reported in `problems`.
 */
export function normalizeBrushSpec(raw: unknown, problems: string[] = []): Brush {
  if (!isObject(raw)) throw new Error('A brush must be an object with id, name, kind and tip.');
  if (typeof raw.id !== 'string' || !BRUSH_ID.test(raw.id)) throw new Error(`Brush id ${JSON.stringify(raw.id)} is not valid: use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.`);
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  if (!name) throw new Error(`Brush "${raw.id}" needs a name.`);
  const tool = BRUSH_TOOLS.includes(raw.tool as BrushTool) ? (raw.tool as BrushTool) : undefined;
  if (raw.tool !== undefined && !tool) problems.push(`tool ${JSON.stringify(raw.tool)} is not a tool; use one of ${BRUSH_TOOLS.join(', ')}.`);
  let kind: BrushKind;
  if (raw.kind === 'mark' || raw.kind === 'tool') kind = raw.kind;
  else if (raw.kind === undefined) kind = tool ? 'tool' : 'mark';
  else throw new Error(`Brush "${raw.id}" kind ${JSON.stringify(raw.kind)} is not valid: use mark (lays a material) or tool (works on paint already down).`);
  if (kind === 'tool' && !tool) throw new Error(`Brush "${raw.id}" is a tool and needs tool: one of ${BRUSH_TOOLS.join(', ')}.`);

  const { colour: rawColour, marks: rawMarks, ferro: rawFerro, kind: _k, id: _i, name: _n, tool: _t, ...rest } = raw;
  if (typeof rest.fluorescence === 'number' && Number.isFinite(rest.fluorescence)) rest.fluorescence = { amount: rest.fluorescence };
  const out = readObject(rest, BRUSH_JSON_SCHEMA, 'brush', problems) as Partial<Brush>;
  if (out.thermochromic?.hotColor) out.thermochromic.hotColor = out.thermochromic.hotColor.toLowerCase();
  const brush: Brush = { id: raw.id, name, ...out, kind, ...(tool ? { tool } : {}), tip: out.tip ?? { shape: 'round' } } as Brush;
  // Keep the key order of a hand-written brush: identity, what it is, then the facets.
  const ordered = (): Brush => {
    const { id, name: n, description, tags, kind: k, medium, variety, tool: t, tip, marks, dynamics, behaviour, light, fluorescence, thermochromic, iridescence, ghost, mutation, ferro, motion, livePatterns, colour } = brush;
    const all = { id, name: n, description, tags, kind: k, medium, variety, tool: t, tip, marks, dynamics, behaviour, light, fluorescence, thermochromic, iridescence, ghost, mutation, ferro, motion, livePatterns, colour };
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as unknown as Brush;
  };

  if (!out.tip) problems.push('tip is missing; a round tip is used.');
  if (!brush.tip.shape) {
    problems.push('tip.shape is missing; round is used.');
    brush.tip = { ...brush.tip, shape: 'round' };
  }

  if (rawMarks !== undefined) {
    const k = isObject(rawMarks) ? rawMarks.kind : undefined;
    const schema = BRUSH_FACET_SCHEMAS.marks[k as keyof typeof BRUSH_FACET_SCHEMAS.marks];
    if (!schema) problems.push(`marks.kind ${JSON.stringify(k)} is not valid; use continuous, scatter, particles, objects, antimatter, scraper or vortex. marks dropped.`);
    else brush.marks = readObject(rawMarks, schema, 'brush.marks', problems) as unknown as Brush['marks'];
  }

  if (rawFerro !== undefined) {
    const ferroObj = typeof rawFerro === 'number' ? { amount: rawFerro } : rawFerro;
    const f = readObject(ferroObj, BRUSH_FACET_SCHEMAS.ferro, 'brush.ferro', problems) as Brush['ferro'];
    if (f && Object.keys(f).length) brush.ferro = f;
  }

  if (rawColour !== undefined) {
    const c = readObject(rawColour, { ...BRUSH_FACET_SCHEMAS.colour, properties: { own: BRUSH_FACET_SCHEMAS.colour.properties!.own, default: {}, palette: {} } }, 'brush.colour', problems);
    if (c) {
      const colour: NonNullable<Brush['colour']> = {};
      if (c.default !== undefined) {
        const p = readPaint(c.default, 'brush.colour.default', problems);
        if (p !== undefined) colour.default = p;
      }
      if (c.palette !== undefined) {
        if (!Array.isArray(c.palette)) problems.push('brush.colour.palette must be a list; dropped.');
        else {
          const list = c.palette.map((p, i) => readPaint(p, `brush.colour.palette[${i}]`, problems)).filter((p): p is BrushPaint => p !== undefined);
          if (list.length > MAX_BRUSH_PALETTE) problems.push(`brush.colour.palette has more than ${MAX_BRUSH_PALETTE} colours; the rest were dropped.`);
          colour.palette = list.slice(0, MAX_BRUSH_PALETTE);
        }
      }
      if (typeof c.own === 'boolean') colour.own = c.own;
      brush.colour = colour;
    }
  }

  // Facets the brush does not use are not stored.
  const drop = (what: string, why: string) => problems.push(`${what} dropped: ${why}.`);
  if (kind === 'mark' && brush.tool) {
    drop('tool', 'a mark brush has no tool (set kind to tool)');
    delete brush.tool;
  }
  if (kind === 'tool') {
    if (brush.medium) {
      drop('medium', 'tools lay no medium');
      delete brush.medium;
    }
    if (brush.marks) {
      drop('marks', 'tools lay no marks');
      delete brush.marks;
    }
    if (brush.ferro) {
      drop('ferro', 'tools lay no ferrofluid');
      delete brush.ferro;
    }
    if (brush.iridescence) {
      drop('iridescence', 'tools lay no film');
      delete brush.iridescence;
    }
  }
  if (brush.iridescence && (brush.marks?.kind === 'objects' || brush.marks?.kind === 'antimatter')) {
    drop('iridescence', brush.marks.kind === 'antimatter' ? 'antimatter marks detonate paint, not film' : 'object marks are stickers, not film');
    delete brush.iridescence;
  }
  if (brush.marks?.kind === 'scatter') {
    // Spray droplets are dabs of a round or stamp tip (they may pick paint up): not bristles, wet or thick paint, or the Mixer Brush.
    const surface = brush.behaviour?.surface;
    const why = brush.tip.shape === 'bristle' ? 'bristle tips lay their own marks' : surface === 'wet' || surface === 'thick' ? `${surface} paint is not sprayed` : brush.behaviour?.exchange?.reservoir ? 'the Mixer Brush is not sprayed' : null;
    if (why) {
      drop('marks', why);
      delete brush.marks;
    }
  }
  if (brush.marks?.kind === 'objects' && brush.tip.shape !== 'stamp') {
    problems.push('marks objects lay stamps: tip.shape set to stamp.');
    brush.tip.shape = 'stamp';
  }
  if (brush.tip.bristle && brush.tip.shape !== 'bristle') {
    drop('tip.bristle', 'only bristle tips have a tuft');
    delete brush.tip.bristle;
  }
  if (brush.tip.stamps && brush.tip.shape !== 'stamp') {
    drop('tip.stamps', 'only stamp tips lay stamps');
    delete brush.tip.stamps;
  }
  if (brush.tip.stamps) {
    // Stamps are sticker refs: a bare editor stamp becomes `editor:<stamp>`. Any sticker the host's
    // sticker library can load works (its art is loaded before painting), and so does an image
    // source of the brush library, except as objects: each object mark stays a sticker.
    let stamps = brush.tip.stamps.map((s) => normalizeStickerRef(s));
    if (brush.marks?.kind === 'objects' && stamps.some(isBrushSourceRef)) {
      problems.push('tip.stamps: image sources (source:…) dropped: objects marks lay stickers; use continuous, scatter or particles marks for an image tip.');
      stamps = stamps.filter((s) => !isBrushSourceRef(s));
    }
    if (stamps.length) brush.tip.stamps = stamps;
    else {
      drop('tip.stamps', 'none of the stamps can be laid');
      delete brush.tip.stamps;
    }
  }
  if (brush.tip.grain) {
    // Tip grain textures dabs: not bristles, particles or objects, nor the wet and thick engines, which lay their own marks.
    const surface = brush.behaviour?.surface;
    const marks = brush.marks?.kind;
    const why = !brush.tip.grain.source
      ? 'it needs a source (a grain pattern or source:<id>)'
      : brush.tip.shape === 'bristle'
        ? 'bristle tips lay their own marks'
        : marks === 'particles' || marks === 'objects' || marks === 'antimatter' || marks === 'scraper' || marks === 'vortex'
          ? `${marks} marks are not dabs`
          : surface === 'wet' || surface === 'thick'
            ? `${surface} paint lays its own texture`
            : kind === 'tool' && WET_BRUSH_TOOLS.includes(brush.tool!)
              ? 'the wet tools work on the wet layer'
              : null;
    if (why) {
      drop('tip.grain', why);
      delete brush.tip.grain;
    }
  }
  const b = brush.behaviour;
  if (b) {
    const wetTool = kind === 'tool' && WET_BRUSH_TOOLS.includes(brush.tool!);
    if (kind === 'tool' && b.surface !== undefined) {
      drop('behaviour.surface', 'a tool works on the surface it finds');
      delete b.surface;
    }
    if (b.wet && b.surface !== 'wet' && !wetTool) {
      drop('behaviour.wet', 'it needs surface wet or a wet tool');
      delete b.wet;
    }
    if (b.thick && b.surface !== 'thick') {
      drop('behaviour.thick', 'it needs surface thick');
      delete b.thick;
    }
    if (b.strength !== undefined && !(kind === 'tool' && brush.tool !== 'eraser')) {
      drop('behaviour.strength', 'only the blender, smudge and wet tools have a strength');
      delete b.strength;
    }
    if (b.distance !== undefined && brush.tool !== 'blender') {
      drop('behaviour.distance', 'only the blender has a blend distance');
      delete b.distance;
    }
    if (b.length !== undefined && brush.tool !== 'smudge') {
      drop('behaviour.length', 'only the smudge tool has a drag length');
      delete b.length;
    }
    if (b.exchange && kind === 'tool' && !wetTool) {
      drop('behaviour.exchange', `the ${brush.tool} does not pick paint up`);
      delete b.exchange;
    } else if (b.exchange && (brush.marks?.kind === 'particles' || brush.marks?.kind === 'objects' || brush.marks?.kind === 'antimatter' || brush.marks?.kind === 'scraper' || brush.marks?.kind === 'vortex' || brush.tip.shape === 'bristle')) {
      drop('behaviour.exchange', 'particle, object, antimatter, scraper, vortex and bristle marks do not pick paint up');
      delete b.exchange;
    }
  }
  if (brush.livePatterns && (kind !== 'mark' || brush.behaviour?.surface !== 'wet' || brush.marks?.kind === 'particles' || brush.marks?.kind === 'objects' || brush.marks?.kind === 'antimatter' || brush.marks?.kind === 'scraper' || brush.marks?.kind === 'vortex' || brush.tip.shape === 'bristle')) {
    drop('livePatterns', 'only wet paint brushes grow live patterns (set behaviour.surface to wet)');
    delete brush.livePatterns;
  }
  if (brush.ghost) {
    if (kind === 'tool' || brush.behaviour?.surface !== 'wet') {
      drop('ghost', 'it needs a mark brush with behaviour.surface wet');
      delete brush.ghost;
    } else {
      if (brush.light) {
        drop('light', 'ghost paint uses the wet light channel as its tracer');
        delete brush.light;
      }
      if (brush.behaviour?.exchange) {
        drop('behaviour.exchange', 'ghost paint does not pick paint up');
        delete brush.behaviour.exchange;
      }
    }
  }
  return ordered();
}
