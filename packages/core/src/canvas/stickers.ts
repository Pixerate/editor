/**
 * Stickers on the canvas: `insert_sticker` (see `@pixerate/editor/stickers`) adds a shape node
 * whose path is the sticker's outline (`silhouette`), filled in its colour (the tint, or its
 * dominant colour), so it resizes, recolours and combines like any shape. The canvas has no image
 * nodes, so multi-colour art is reduced to its outline in one colour; `data.sticker` keeps the ref
 * and licence.
 */

import type { Command } from '../history/types.js';
import { StickerError } from '../stickers/errors.js';
import type { StickerLicence, StickerRef } from '../stickers/types.js';
import type { StickerInsertHost, StickerPlacement } from '../stickers/tools.js';
import { SHAPE_DATA_KEY, SHAPE_NODE_TYPE } from './shapeNodes.js';
import type { PathShape } from './shapeGeometry.js';
import type { CanvasNode } from './types.js';

/** What a sticker node remembers: where it came from. */
export interface CanvasStickerData {
  ref: StickerRef;
  licence: StickerLicence;
}

export interface CanvasStickerHostOptions<TNode extends CanvasNode = CanvasNode> {
  getNodes: () => TNode[];
  setNodes: (nodes: TNode[]) => void;
  /** When set, every insertion is one undoable command. */
  history?: { execute(command: Command): void };
  /** New node ids (default `sticker-<n>`, skipping ids in use). */
  createId?: () => string;
  /** The default centre (default the middle of the nodes' bounds, or 0, 0). */
  defaultCentre?: () => { x: number; y: number };
}

/** The shape node for a placed sticker (top-left at its box), or a refusal naming what is missing. */
export function stickerCanvasNode(placement: StickerPlacement, id: string): CanvasNode {
  const { description, asset } = placement;
  const silhouette = (asset.kind === 'svg' ? asset.silhouette : undefined) ?? description.silhouette;
  if (!silhouette) throw new StickerError('unsupported_format', `"${placement.ref}" has no outline (silhouette); the canvas places stickers by their outline. Pick one whose describe_sticker lists a silhouette.`);
  const fill = placement.colour ?? description.colours?.[0] ?? '#1f2937';
  const shape: PathShape = { kind: 'path', d: silhouette, viewBox: [0, 0, description.width, description.height], fillRule: 'evenodd', fill };
  const sticker: CanvasStickerData = { ref: placement.ref, licence: description.licence };
  return {
    id,
    type: SHAPE_NODE_TYPE,
    position: { x: placement.x - placement.width / 2, y: placement.y - placement.height / 2 },
    width: placement.width,
    height: placement.height,
    data: { label: description.name, [SHAPE_DATA_KEY]: shape, sticker },
  };
}

/** `insert_sticker` for a canvas: a shape node from the sticker's outline, one undo step. */
export function createCanvasStickerHost<TNode extends CanvasNode = CanvasNode>(options: CanvasStickerHostOptions<TNode>): StickerInsertHost {
  let n = 0;
  const newId = () => {
    if (options.createId) return options.createId();
    const taken = new Set(options.getNodes().map((x) => x.id));
    let id: string;
    do id = `sticker-${++n}`;
    while (taken.has(id));
    return id;
  };
  return {
    noun: 'shape node',
    format: 'svg',
    defaultCentre: () => {
      if (options.defaultCentre) return options.defaultCentre();
      const nodes = options.getNodes();
      if (!nodes.length) return { x: 0, y: 0 };
      const xs = nodes.flatMap((x) => [x.position.x, x.position.x + (x.width ?? 0)]);
      const ys = nodes.flatMap((x) => [x.position.y, x.position.y + (x.height ?? 0)]);
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    },
    insert(placement) {
      const node = stickerCanvasNode(placement, newId()) as TNode;
      const before = options.getNodes();
      const next = [...before, node];
      const label = `Insert ${placement.description.name}`;
      if (options.history) options.history.execute({ name: label, execute: () => options.setNodes(next), undo: () => options.setNodes(before), redo: () => options.setNodes(next) });
      else options.setNodes(next);
      return { id: node.id };
    },
  };
}
