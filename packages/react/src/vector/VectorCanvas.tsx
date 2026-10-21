import React, { useEffect, useId, useRef, useState } from 'react';
import {
  VECTOR_OVERLAY_THEME as THEME,
  getVectorOverlayRenderData,
  getVectorSceneRenderData,
  getVectorSymbolEditBackground,
  isVectorTextTarget,
  toVectorKeyInput,
  toVectorPointerInput,
  vectorDiamondPath,
  type VectorEditorController,
  type VectorRenderNode,
  type VectorRenderMask,
  type VectorRenderPath,
  type VectorRenderPaintLayer,
  type VectorRenderFilter,
  type VectorFilterPrimitive,
  type SvgGradientDef,
  type VectorPaintDef,
  type VectorRenderGradientAnnotator,
  type VectorRenderText,
  createVectorPlaybackLocator,
} from '@pixerate/editor/vector';
import type { AgentPlayback } from '@pixerate/editor/tools';
import { useVectorEditorState } from './useVectorEditor';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { usePlaybackSurface } from '../playback/usePlaybackSurface';
import { PresenceLayer } from '../playback/PresenceLayer';
import { VectorWidthPointEditor } from './VectorWidthPointEditor';

export interface VectorCanvasProps {
  controller: VectorEditorController;
  /** Fit the artboard into the canvas when it first gets a size (default `true`). */
  fitOnMount?: boolean;
  /** Draw a checkerboard behind a transparent artboard (default `true`). */
  checkerboard?: boolean;
  /** Overlay accent colour (default sky blue). */
  accentColor?: string;
  /** Smart guide colour (default magenta). */
  guideColor?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label (default "Vector canvas"). */
  'aria-label'?: string;
  /**
   * Agent playback: act out the vector commands' calls here with the agent's cursor (default: the
   * nearest `AgentPlaybackProvider`; `null` turns it off).
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `vector`, where the vector commands play). */
  playbackId?: string;
  /** Bring the canvas on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

function GradientElement({ def }: { def: SvgGradientDef }) {
  const stops = def.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.stopColor} stopOpacity={s.stopOpacity} />);
  return def.type === 'radial' ? (
    <radialGradient id={def.id} {...(def.attrs as any)}>
      {stops}
    </radialGradient>
  ) : (
    <linearGradient id={def.id} {...(def.attrs as any)}>
      {stops}
    </linearGradient>
  );
}

/**
 * Renders paint servers: `<linearGradient>` / `<radialGradient>` descriptors and patterns of
 * gradient tiles (conic, diamond and stroke-mode gradients).
 */
export function VectorGradientDefs({ defs }: { defs: readonly VectorPaintDef[] }) {
  if (!defs.length) return null;
  return (
    <defs>
      {defs.map((def) =>
        def.type === 'pattern' ? (
          <pattern key={def.id} id={def.id} {...(def.attrs as any)}>
            {def.gradients.map((g) => (
              <GradientElement key={g.id} def={g} />
            ))}
            {def.tiles.map((t, i) => (
              <path key={i} d={t.d} fill={t.fill} />
            ))}
          </pattern>
        ) : (
          <GradientElement key={def.id} def={def} />
        )
      )}
    </defs>
  );
}

/** The gradient tool's annotator (screen space): extent, bar, handles, stop chips and midpoints. */
export function VectorGradientAnnotator({ annotator: g, accentColor = THEME.accent }: { annotator: VectorRenderGradientAnnotator; accentColor?: string }) {
  const r = THEME.handleRadius + 1.5;
  const ring = (p: { x: number; y: number; hovered: boolean }, part: string, size = r) => (
    <circle data-vector-gradient-handle={part} cx={p.x} cy={p.y} r={size + (p.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} strokeWidth={p.hovered ? 2 : 1} />
  );
  return (
    <g data-vector-gradient-annotator={g.type}>
      {g.extent && <path data-vector-gradient-extent="" d={g.extent} fill="none" stroke={accentColor} strokeDasharray="4 3" />}
      <line x1={g.start.x} y1={g.start.y} x2={g.end.x} y2={g.end.y} stroke="#ffffff" strokeWidth={3} />
      <line data-vector-gradient-bar="" x1={g.start.x} y1={g.start.y} x2={g.end.x} y2={g.end.y} stroke={accentColor} />
      {g.aspect && <line x1={g.start.x} y1={g.start.y} x2={g.aspect.x} y2={g.aspect.y} stroke={accentColor} strokeDasharray="2 2" />}
      {ring(g.start, 'start')}
      <rect
        data-vector-gradient-handle={g.end.handle}
        x={g.end.x - r}
        y={g.end.y - r}
        width={2 * r}
        height={2 * r}
        fill={THEME.handleFill}
        stroke={accentColor}
        strokeWidth={g.end.hovered ? 2 : 1}
      />
      {g.aspect && ring(g.aspect, 'aspect', THEME.handleRadius)}
      {g.focal && (
        <g data-vector-gradient-handle="focal">
          <circle cx={g.focal.x} cy={g.focal.y} r={THEME.handleRadius - 1 + (g.focal.hovered ? 1 : 0)} fill={accentColor} stroke={THEME.handleFill} />
        </g>
      )}
      {g.midpoints.map((m) => (
        <path key={m.index} data-vector-gradient-midpoint={m.index} d={vectorDiamondPath(m.x, m.y, 4 + (m.hovered ? 1 : 0))} fill={THEME.handleFill} stroke={accentColor} />
      ))}
      {g.stops.map((s) => (
        <g key={s.index} data-vector-gradient-stop={s.index} data-selected={s.selected || undefined} opacity={g.removing && s.selected ? 0.35 : 1}>
          <line x1={s.barX} y1={s.barY} x2={s.x} y2={s.y} stroke={accentColor} />
          <rect x={s.x - 5} y={s.y - 5} width={10} height={10} rx={2} fill={s.color} fillOpacity={s.opacity} stroke={s.selected ? accentColor : '#ffffff'} strokeWidth={s.selected || s.hovered ? 2 : 1} />
          <rect x={s.x - 6.5} y={s.y - 6.5} width={13} height={13} rx={3} fill="none" stroke={s.selected ? '#ffffff' : accentColor} />
        </g>
      ))}
    </g>
  );
}

/** SVG `<filter>` elements for `getVectorSceneRenderData(...).filters` (shadows, glows, blurs, feather). */
export function VectorFilterDefs({ filters }: { filters: readonly VectorRenderFilter[] }) {
  if (!filters.length) return null;
  // React wants presentation attributes camel-cased (`flood-color` → `floodColor`).
  const props = (attrs: VectorFilterPrimitive['attrs']) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
  const primitive = (p: VectorFilterPrimitive, key: number): React.ReactNode =>
    React.createElement(p.tag, { key, ...props(p.attrs) }, p.children?.map(primitive));
  return (
    <defs>
      {filters.map((f) => (
        <filter key={f.id} id={f.id} filterUnits="userSpaceOnUse" x={f.x} y={f.y} width={f.width} height={f.height} colorInterpolationFilters="sRGB">
          {f.primitives.map(primitive)}
        </filter>
      ))}
    </defs>
  );
}

const blendStyle = (blendMode: string | undefined): React.CSSProperties | undefined => (blendMode ? { mixBlendMode: blendMode as React.CSSProperties['mixBlendMode'] } : undefined);

/**
 * Text drawn as SVG text: one `<text>` per paint layer, every span a `<tspan>` placed character by
 * character (the layout is the editor's, not the browser's).
 */
export function VectorTextElement({ node }: { node: VectorRenderText }) {
  return (
    <g data-vector-id={node.id} data-vector-text="" transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined} filter={node.filter} style={blendStyle(node.blendMode)}>
      {node.layers.map((layer, i) => (
        <text
          key={i}
          data-vector-layer={layer.kind}
          xmlSpace="preserve"
          fill={layer.fill}
          stroke={layer.stroke}
          strokeWidth={layer.stroke === 'none' ? undefined : layer.strokeWidth}
          strokeLinejoin={layer.strokeLinejoin as any}
          strokeDasharray={layer.strokeDasharray}
          opacity={layer.opacity < 1 ? layer.opacity : undefined}
          style={{ whiteSpace: 'pre', ...blendStyle(layer.blendMode) }}
        >
          {node.spans.map((sp, k) => (
            <tspan
              key={k}
              x={sp.x}
              y={sp.y}
              rotate={sp.rotate}
              fontFamily={sp.fontFamily}
              fontSize={sp.fontSize}
              fontWeight={sp.fontWeight}
              fontStyle={sp.fontStyle}
              textDecoration={sp.textDecoration}
              fill={layer.runFills && sp.fill ? sp.fill : undefined}
            >
              {sp.text}
            </tspan>
          ))}
        </text>
      ))}
    </g>
  );
}

/** Renders scene nodes (paths, text and groups) from `getVectorSceneRenderData`. */
export function VectorSceneNodes({ nodes }: { nodes: readonly VectorRenderNode[] }) {
  return (
    <>
      {nodes.map((node) => (
        <VectorSceneNode key={node.id} node={node} />
      ))}
    </>
  );
}

/**
 * One scene node. Memoised on the node object: the scene data hands back the same object for a
 * node an edit did not touch, so only changed nodes re-render.
 */
const VectorSceneNode = React.memo(function VectorSceneNode({ node }: { node: VectorRenderNode }) {
  if (node.kind === 'text') return <VectorTextElement node={node} />;
  if (node.kind === 'group')
    return (
      <g data-vector-id={node.id} data-vector-mask={node.mask?.type} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined} filter={node.filter} style={blendStyle(node.blendMode)}>
        {node.mask ? <VectorMaskedNodes mask={node.mask} nodes={node.children} /> : <VectorSceneNodes nodes={node.children} />}
      </g>
    );
  if (node.layers)
    return (
      // Fill and stroke stacks: each layer in order, bottom to top.
      <g data-vector-id={node.id} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined} filter={node.filter} style={blendStyle(node.blendMode)}>
        {node.layers.map((layer) =>
          layer.kind === 'brushstroke' ? (
            // A brushstroke: its rendered brush images over their boxes.
            <g key={`${layer.kind}-${layer.index}`} data-vector-layer={`brushstroke-${layer.index}`} opacity={layer.opacity < 1 ? layer.opacity : undefined} style={blendStyle(layer.blendMode)}>
              {(layer.images ?? []).map((im, i) => (
                <image key={i} href={im.href} x={im.x} y={im.y} width={im.width} height={im.height} preserveAspectRatio="none" />
              ))}
            </g>
          ) : (
            <VectorPaintPath key={`${layer.kind}-${layer.index}`} paint={layer} d={node.d} fillRule={node.fillRule} layer={`${layer.kind}-${layer.index}`} />
          ),
        )}
      </g>
    );
  return <VectorPaintPath paint={node} d={node.d} fillRule={node.fillRule} id={node.id} transform={node.transform} filter={node.filter} blendMode={node.blendMode} />;
});

/**
 * A mask group's contents under its mask: the `<clipPath>` (clip) or `<mask>` (alpha, luminance;
 * the mask drawn inside, through the inverting filter when inverted), and an inner `<g>` that
 * references it. The group's own transform, opacity, blend mode and filter are on the outer `<g>`.
 */
export function VectorMaskedNodes({ mask, nodes }: { mask: VectorRenderMask; nodes: readonly VectorRenderNode[] }) {
  const b = mask.bounds;
  return (
    <>
      <defs>
        {mask.clip ? (
          <clipPath id={mask.id}>
            {mask.clip.map((c, i) => (
              <path key={i} d={c.d} clipRule={c.clipRule} />
            ))}
          </clipPath>
        ) : (
          b && (
            <mask id={mask.id} maskUnits="userSpaceOnUse" x={b.x} y={b.y} width={b.width} height={b.height} style={mask.type === 'alpha' ? { maskType: 'alpha' } : undefined}>
              {mask.filter ? (
                <g filter={mask.filter}>
                  <VectorSceneNodes nodes={mask.nodes ?? []} />
                </g>
              ) : (
                <VectorSceneNodes nodes={mask.nodes ?? []} />
              )}
            </mask>
          )
        )}
      </defs>
      <g data-vector-masked="" clipPath={mask.clip ? `url(#${mask.id})` : undefined} mask={mask.clip ? undefined : `url(#${mask.id})`}>
        <VectorSceneNodes nodes={nodes} />
      </g>
    </>
  );
}

/**
 * One paint of a path: a node's fill and stroke, or one layer of its stacks. A stroke aligned
 * inside / outside (double width, clipped or masked by the shape) or with arrowheads draws in
 * parts inside a group.
 */
function VectorPaintPath({
  paint,
  d,
  fillRule,
  id,
  transform,
  filter,
  blendMode,
  layer,
}: {
  paint: VectorRenderPaintLayer | VectorRenderPath;
  d: string;
  fillRule: 'nonzero' | 'evenodd';
  id?: string;
  transform?: string;
  filter?: string;
  blendMode?: string;
  layer?: string;
}) {
  const opacity = paint.opacity < 1 ? paint.opacity : undefined;
  // A node's blend mode is passed in; a layer carries its own.
  const style = blendStyle(blendMode ?? (layer ? paint.blendMode : undefined));
  const sp = paint.strokeParts;
  if (!sp)
    return (
      <path
        data-vector-id={id}
        data-vector-layer={layer}
        transform={transform}
        d={d}
        fill={paint.fill}
        fillRule={fillRule}
        stroke={paint.stroke}
        strokeWidth={paint.stroke === 'none' ? undefined : paint.strokeWidth}
        strokeLinecap={paint.strokeLinecap as any}
        strokeLinejoin={paint.strokeLinejoin as any}
        strokeDasharray={paint.strokeDasharray}
        opacity={opacity}
        filter={filter}
        style={style}
      />
    );
  const clip = sp.clip;
  const b = clip?.bounds;
  return (
    <g data-vector-id={id} data-vector-layer={layer} data-vector-stroke-align={sp.align} transform={transform} opacity={opacity} filter={filter} style={style}>
      {clip && b && (
        <defs>
          {clip.kind === 'clip' ? (
            <clipPath id={clip.id}>
              <path d={d} clipRule={fillRule} />
            </clipPath>
          ) : (
            <mask id={clip.id} maskUnits="userSpaceOnUse" x={b.x} y={b.y} width={b.width} height={b.height}>
              <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="#fff" />
              <path d={d} fill="#000" fillRule={fillRule} />
            </mask>
          )}
        </defs>
      )}
      <path data-vector-part="fill" d={d} fill={paint.fill} fillRule={fillRule} stroke="none" />
      {sp.outline !== undefined ? (
        // A variable-width stroke: its outline, filled.
        <path
          data-vector-part="stroke-outline"
          d={sp.outline}
          fill={paint.stroke}
          clipPath={clip?.kind === 'clip' ? `url(#${clip.id})` : undefined}
          mask={clip?.kind === 'mask' ? `url(#${clip.id})` : undefined}
        />
      ) : (
        <path
          data-vector-part="stroke"
          d={sp.d}
          fill="none"
          stroke={paint.stroke}
          strokeWidth={sp.width}
          strokeLinecap={paint.strokeLinecap as any}
          strokeLinejoin={paint.strokeLinejoin as any}
          strokeDasharray={paint.strokeDasharray}
          clipPath={clip?.kind === 'clip' ? `url(#${clip.id})` : undefined}
          mask={clip?.kind === 'mask' ? `url(#${clip.id})` : undefined}
        />
      )}
      {sp.heads.map((head, i) => (
        <path key={i} data-vector-part="head" d={head} fill={paint.stroke} />
      ))}
    </g>
  );
}

/**
 * An SVG canvas for a `VectorEditorController`: draws the document and the editing overlay
 * and forwards pointer, wheel, keyboard and clipboard events. Focus it to use shortcuts.
 */
export function VectorCanvas({
  controller,
  fitOnMount = true,
  checkerboard = true,
  accentColor = THEME.accent,
  guideColor = THEME.guide,
  className,
  style,
  'aria-label': ariaLabel = 'Vector canvas',
  playback,
  playbackId = 'vector',
  onPlaybackReveal,
}: VectorCanvasProps) {
  const state = useVectorEditorState(controller);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const editingText = state.textEdit?.nodeId ?? null;
  const fitted = useRef(!fitOnMount);
  const uid = useId().replace(/:/g, '');
  // The canvas size, so the scene leaves out what is off screen and simplifies what is tiny.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const scene = getVectorSceneRenderData(state, { idPrefix: `ve${uid}-`, ...(size ? { viewportSize: size } : {}) });
  const overlay = getVectorOverlayRenderData(state);
  // Isolation mode: the rest of the document, dimmed behind the symbol's art.
  const host = getVectorSymbolEditBackground(state, { idPrefix: `ve${uid}-host-` });

  useEffect(() => {
    const el = svgRef.current;
    if (!el || fitted.current) return;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      if (fitted.current || rect.width <= 0 || rect.height <= 0) return;
      fitted.current = true;
      controller.zoomToFit({ width: rect.width, height: rect.height });
    };
    fit();
    if (fitted.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [controller]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize((s) => (s && s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Typing goes into a hidden textarea while text is edited (focused after the click that started it).
  useEffect(() => {
    if (!editingText) return;
    const t = setTimeout(() => textRef.current?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(t);
  }, [editingText]);

  // Wheel needs a non-passive listener to stop page scroll / browser zoom.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      controller.wheel(local(e), { x: e.deltaX, y: e.deltaY }, toVectorPointerInput(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [controller]);

  // Agent playback: the agent's cursor in document units, drawn through the viewport.
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const [locate] = useState(() => createVectorPlaybackLocator(controller));
  const svgBox = () => svgRef.current?.getBoundingClientRect() ?? null;
  const presence = usePlaybackSurface(playing, playbackId, {
    defaultKind: 'vector',
    locate,
    bounds: () => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return r && r.width > 0 ? { x: -v.x / v.zoom, y: -v.y / v.zoom, width: r.width / v.zoom, height: r.height / v.zoom } : null;
    },
    visible: () => {
      const r = svgBox();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p) => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return { x: (r?.left ?? 0) + p.x * v.zoom + v.x, y: (r?.top ?? 0) + p.y * v.zoom + v.y };
    },
    fromViewport: (p) => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return { x: (p.x - (r?.left ?? 0) - v.x) / v.zoom, y: (p.y - (r?.top ?? 0) - v.y) / v.zoom };
    },
    reveal: () => onPlaybackReveal?.(),
  });

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const clipboard = (kind: 'copy' | 'cut' | 'paste') => (event: React.ClipboardEvent) => {
    const native = (event && 'nativeEvent' in event ? event.nativeEvent : event) as ClipboardEvent;
    const data = native?.clipboardData;
    if (kind === 'paste') {
      const text = data?.getData('text/plain') ?? '';
      const pasted = text ? controller.paste(text) : controller.paste();
      if (pasted.length) event.preventDefault?.();
      return;
    }
    const text = kind === 'cut' ? controller.cut() : controller.copy();
    if (text && data) {
      data.setData('text/plain', text);
      event.preventDefault?.();
    }
  };

  const hs = THEME.transformHandleSize;
  const as = THEME.anchorSize;
  const box = overlay.selectionBox;
  const edit = state.widthPointEdit;
  const editAt = edit && { x: edit.point.x * state.viewport.zoom + state.viewport.x, y: edit.point.y * state.viewport.zoom + state.viewport.y };

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label={ariaLabel}
      tabIndex={0}
      data-tool={state.tool}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', outline: 'none', touchAction: 'none', userSelect: 'none', cursor: state.cursor, ...style }}
      onPointerDown={(e) => {
        svgRef.current?.focus({ preventScroll: true });
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        controller.pointerDown(local(e), toVectorPointerInput(e));
      }}
      onPointerMove={(e) => controller.pointerMove(local(e), toVectorPointerInput(e))}
      onPointerUp={(e) => {
        (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
        controller.pointerUp(local(e), toVectorPointerInput(e));
      }}
      onPointerCancel={() => controller.cancelDrag()}
      onPointerLeave={() => controller.pointerLeave()}
      onDoubleClick={(e) => controller.doubleClick(local(e))}
      onKeyDown={(e) => {
        if (isVectorTextTarget(e.target)) return;
        if (controller.keyDown(toVectorKeyInput(e))) e.preventDefault();
      }}
      onKeyUp={(e) => controller.keyUp(toVectorKeyInput(e))}
      onCopy={clipboard('copy')}
      onCut={clipboard('cut')}
      onPaste={clipboard('paste')}
    >
      {checkerboard && (
        <defs>
          <pattern id={`ve${uid}-checker`} width={16} height={16} patternUnits="userSpaceOnUse">
            <rect width={16} height={16} fill="#ffffff" />
            <rect width={8} height={8} fill="#e5e7eb" />
            <rect x={8} y={8} width={8} height={8} fill="#e5e7eb" />
          </pattern>
        </defs>
      )}
      <VectorGradientDefs defs={scene.defs} />
      <VectorFilterDefs filters={scene.filters} />
      <rect
        data-vector-artboard=""
        x={overlay.artboard.x}
        y={overlay.artboard.y}
        width={overlay.artboard.width}
        height={overlay.artboard.height}
        fill={scene.background ?? (checkerboard ? `url(#ve${uid}-checker)` : '#ffffff')}
        stroke="rgba(0,0,0,0.12)"
      />
      {host && (
        <g data-vector-symbol-host="" opacity={0.3} pointerEvents="none" transform={host.transform}>
          <VectorGradientDefs defs={host.defs} />
          <VectorFilterDefs filters={host.filters} />
          <VectorSceneNodes nodes={host.nodes} />
        </g>
      )}
      <g data-vector-scene="" transform={scene.transform}>
        <VectorSceneNodes nodes={scene.nodes} />
      </g>
      {overlay.frames.length > 0 && (
        <g data-vector-frame-labels="">
          {overlay.frames.map((f) => (
            <text
              key={f.id}
              data-vector-frame-label={f.id}
              x={f.x}
              y={f.y - 6}
              fontSize={11}
              fontWeight={f.selected ? 600 : 400}
              fill={f.selected ? accentColor : '#737373'}
              style={{ fontFamily: 'system-ui, sans-serif', cursor: 'default', userSelect: 'none' }}
              onPointerDown={(e) => {
                // A frame's name selects it (clicking inside a frame may pick its contents).
                e.stopPropagation();
                controller.select([f.id]);
              }}
            >
              {f.name}
            </text>
          ))}
        </g>
      )}
      <g data-vector-overlay="" pointerEvents="none" fill="none">
        {overlay.outlines.map((o) => (
          <path key={o.id} d={o.d} stroke={accentColor} strokeWidth={o.selected ? 1 : 1.5} opacity={o.selected ? 1 : 0.7} />
        ))}
        {overlay.penPreview && <path d={overlay.penPreview} stroke={accentColor} strokeDasharray="4 3" />}
        {box && (
          <g data-vector-selection="" data-free-distort={box.freeDistort || undefined} transform={box.transform || undefined}>
            <rect x={box.x} y={box.y} width={box.width} height={box.height} stroke={accentColor} />
            <line x1={box.x + box.width / 2} y1={box.y} x2={box.x + box.width / 2} y2={box.y - 24} stroke={accentColor} />
            {box.handles.map((h) =>
              h.handle === 'rotate' ? (
                <circle key={h.handle} data-handle={h.handle} cx={h.x} cy={h.y} r={hs / 2 + 1} fill={THEME.handleFill} stroke={accentColor} />
              ) : (
                <rect key={h.handle} data-handle={h.handle} x={h.x - hs / 2} y={h.y - hs / 2} width={hs} height={hs} fill={THEME.handleFill} stroke={accentColor} />
              ),
            )}
          </g>
        )}
        {overlay.distort && (
          <g data-vector-distort={overlay.distort.mode}>
            <path d={overlay.distort.d} stroke={accentColor} />
            {overlay.distort.corners.map((c, i) => (
              <rect key={i} x={c.x - hs / 2} y={c.y - hs / 2} width={hs} height={hs} fill={THEME.handleFill} stroke={accentColor} />
            ))}
          </g>
        )}
        {overlay.envelope && (
          <g data-vector-envelope-mesh={overlay.envelope.nodeId}>
            <path data-vector-envelope-grid="" d={overlay.envelope.grid} stroke={accentColor} strokeOpacity={0.8} />
            {overlay.envelope.handles.map((h) => (
              <g key={h.index} data-vector-envelope-handle={h.index}>
                <line x1={h.anchorX} y1={h.anchorY} x2={h.x} y2={h.y} stroke={accentColor} strokeOpacity={0.6} />
                <circle cx={h.x} cy={h.y} r={THEME.handleRadius + (h.hovered || h.active ? 1 : 0)} fill={h.active ? accentColor : THEME.handleFill} stroke={accentColor} />
              </g>
            ))}
            {overlay.envelope.anchors.map((a) => {
              const size = as + (a.hovered || a.active ? 2 : 0);
              return <rect key={a.index} data-vector-envelope-anchor={a.index} x={a.x - size / 2} y={a.y - size / 2} width={size} height={size} fill={a.active ? accentColor : THEME.handleFill} stroke={accentColor} />;
            })}
          </g>
        )}
        {overlay.handles.map((h) => (
          <g key={`${h.ref.nodeId}:${h.ref.subpath}:${h.ref.index}:${h.ref.handle}`} data-vector-handle={h.ref.handle}>
            <line x1={h.anchorX} y1={h.anchorY} x2={h.x} y2={h.y} stroke={accentColor} />
            <circle cx={h.x} cy={h.y} r={THEME.handleRadius + (h.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
          </g>
        ))}
        {overlay.anchors.map((a) => {
          const size = as + (a.hovered ? 2 : 0);
          const fill = a.selected ? accentColor : THEME.handleFill;
          const key = `${a.ref.nodeId}:${a.ref.subpath}:${a.ref.index}`;
          return a.type === 'corner' ? (
            <rect key={key} data-vector-anchor={a.ref.index} x={a.x - size / 2} y={a.y - size / 2} width={size} height={size} fill={fill} stroke={accentColor} />
          ) : (
            <circle key={key} data-vector-anchor={a.ref.index} cx={a.x} cy={a.y} r={size / 2} fill={fill} stroke={accentColor} />
          );
        })}
        {overlay.cornerWidgets.map((w) => (
          <g key={`corner:${w.ref.nodeId}:${w.ref.subpath}:${w.ref.index}`} data-vector-corner-widget={w.ref.index} data-corner-kind={w.kind}>
            <circle cx={w.x} cy={w.y} r={THEME.cornerWidgetRadius + (w.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
            <circle cx={w.x} cy={w.y} r={1.5} fill={accentColor} />
          </g>
        ))}
        {overlay.masks.map((m) => (
          <path
            key={`mask:${m.id}`}
            data-vector-mask-indicator={m.id}
            data-mask-type={m.type}
            data-inverted={m.invert || undefined}
            d={m.d}
            fill="none"
            stroke={THEME.mask}
            strokeWidth={m.editing ? 1.5 : 1}
            strokeDasharray={m.editing ? undefined : THEME.maskDash}
            opacity={m.enabled ? 1 : 0.5}
          />
        ))}
        {overlay.blend.spines.map((sp) => (
          <g key={`blend:${sp.id}`} data-vector-blend-spine={sp.id} data-replaced={sp.replaced || undefined}>
            <path d={sp.d} fill="none" stroke={accentColor} strokeDasharray="4 3" />
            {sp.keys.map((k, i) => (
              <circle key={i} cx={k.x} cy={k.y} r={THEME.handleRadius} fill={THEME.handleFill} stroke={accentColor} />
            ))}
          </g>
        ))}
        {overlay.blend.start && (
          <g data-vector-blend-start="">
            <path d={overlay.blend.start.d} fill="none" stroke={accentColor} strokeWidth={2} />
            {overlay.blend.start.anchor && <circle cx={overlay.blend.start.anchor.x} cy={overlay.blend.start.anchor.y} r={THEME.handleRadius + 1} fill={accentColor} />}
          </g>
        )}
        {overlay.blend.anchors.map((a, i) => (
          <rect
            key={`blend-anchor:${i}`}
            data-vector-blend-anchor={i}
            x={a.x - as / 2}
            y={a.y - as / 2}
            width={as}
            height={as}
            fill={a.hovered ? accentColor : THEME.handleFill}
            stroke={accentColor}
          />
        ))}
        {overlay.gradient && <VectorGradientAnnotator annotator={overlay.gradient} accentColor={accentColor} />}
        {overlay.widthSpot && (
          <g data-vector-width-spot="">
            <line x1={overlay.widthSpot.left.x} y1={overlay.widthSpot.left.y} x2={overlay.widthSpot.right.x} y2={overlay.widthSpot.right.y} stroke={accentColor} strokeDasharray="3 2" />
            <path d={vectorDiamondPath(overlay.widthSpot.x, overlay.widthSpot.y)} fill="none" stroke={accentColor} />
          </g>
        )}
        {overlay.widthPoints.map((w) => (
          <g key={`width:${w.ref.nodeId}:${w.ref.subpath}:${w.ref.index}`} data-vector-width-point={w.ref.index} data-selected={w.selected || undefined}>
            <line x1={w.left.x} y1={w.left.y} x2={w.right.x} y2={w.right.y} stroke={accentColor} />
            <path d={vectorDiamondPath(w.x, w.y)} fill={w.selected || w.active ? accentColor : THEME.handleFill} stroke={accentColor} strokeWidth={w.hovered === 'center' ? 2 : 1} />
            {(['left', 'right'] as const).map((side) => (
              <circle key={side} data-vector-width-side={side} cx={w[side].x} cy={w[side].y} r={THEME.handleRadius + (w.hovered === side ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
            ))}
          </g>
        ))}
        {state.tool === 'pen' && overlay.anchors.some((a) => a.closes && a.hovered) && (
          <circle cx={overlay.anchors.find((a) => a.closes)!.x} cy={overlay.anchors.find((a) => a.closes)!.y} r={as} stroke={accentColor} />
        )}
        {overlay.builder && (
          <g data-vector-builder={overlay.builder.mode}>
            {overlay.builder.faces.map((d, i) => (
              <path
                key={`f${i}`}
                data-vector-builder-face=""
                d={d}
                fill={overlay.builder!.mode === 'erase' ? THEME.builderEraseFill : THEME.builderFill}
                fillRule="nonzero"
                stroke={overlay.builder!.mode === 'erase' ? THEME.builderErase : accentColor}
                strokeWidth={1}
              />
            ))}
            {overlay.builder.hatches.map((d, i) =>
              d ? (
                <path
                  key={`h${i}`}
                  data-vector-builder-hatch=""
                  d={d}
                  fill="none"
                  stroke={overlay.builder!.mode === 'erase' ? THEME.builderErase : accentColor}
                  strokeOpacity={THEME.builderHatchOpacity}
                  strokeWidth={1}
                />
              ) : null
            )}
            {overlay.builder.lines.map((d, i) => (
              <path key={`l${i}`} data-vector-builder-line="" d={d} fill="none" stroke={THEME.builderErase} strokeWidth={3} strokeLinecap="round" />
            ))}
            {overlay.builder.trail && <path data-vector-builder-trail="" d={overlay.builder.trail} fill="none" stroke={overlay.builder.mode === 'erase' ? THEME.builderErase : accentColor} strokeWidth={1} />}
          </g>
        )}
        {overlay.brush && <circle data-vector-brush="" cx={overlay.brush.x} cy={overlay.brush.y} r={overlay.brush.r} fill="none" stroke={accentColor} strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />}
        {overlay.toolStroke && (
          <path
            data-vector-tool-stroke={overlay.toolStroke.tool}
            d={overlay.toolStroke.d}
            stroke={overlay.toolStroke.tool === 'eraser' ? THEME.eraserFill : accentColor}
            strokeWidth={overlay.toolStroke.tool === 'eraser' ? overlay.toolStroke.width : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={overlay.toolStroke.tool === 'knife' ? '5 3' : undefined}
          />
        )}
        {overlay.pencilString && (
          <line
            data-vector-pencil-string=""
            x1={overlay.pencilString.x1}
            y1={overlay.pencilString.y1}
            x2={overlay.pencilString.x2}
            y2={overlay.pencilString.y2}
            stroke={accentColor}
            strokeDasharray="2 2"
          />
        )}
        {overlay.cutPoint && <circle data-vector-cut-point="" cx={overlay.cutPoint.x} cy={overlay.cutPoint.y} r={THEME.handleRadius + 1} fill={THEME.handleFill} stroke={accentColor} />}
        {overlay.text && (
          <g data-vector-text-edit={overlay.text.nodeId} data-editing={overlay.text.editing || undefined}>
            <path d={overlay.text.frame} stroke={accentColor} strokeDasharray={overlay.text.editing ? '3 2' : undefined} opacity={0.8} />
            {overlay.text.selection.map((d, i) => (
              <path key={i} data-vector-text-selection="" d={d} fill={accentColor} fillOpacity={0.25} stroke="none" />
            ))}
            {overlay.text.caret && (
              <line data-vector-text-caret="" x1={overlay.text.caret.x1} y1={overlay.text.caret.y1} x2={overlay.text.caret.x2} y2={overlay.text.caret.y2} stroke={accentColor} strokeWidth={1.5} />
            )}
            {overlay.text.overflow && (
              <g data-vector-text-overflow="" transform={`translate(${overlay.text.overflow.x} ${overlay.text.overflow.y})`}>
                <rect x={-5} y={-5} width={10} height={10} fill={THEME.handleFill} stroke="#dc2626" />
                <path d="M-3 0H3M0 -3V3" stroke="#dc2626" />
              </g>
            )}
          </g>
        )}
        {overlay.shading.map((sh) => (
          <g key={`shading:${sh.nodeId}`} data-vector-shading={sh.kind}>
            {sh.lines.map((d, i) => (
              <path key={i} d={d} stroke={accentColor} strokeWidth={1} opacity={0.7} />
            ))}
            {sh.points.map((p) => (
              <circle key={p.index} data-vector-shading-point={p.index} data-selected={p.selected || undefined} cx={p.x} cy={p.y} r={p.selected ? 6 : 4.5} fill={p.color} stroke={p.selected ? accentColor : '#ffffff'} strokeWidth={p.selected ? 2 : 1.5} />
            ))}
          </g>
        ))}
        {overlay.perspective && (
          <g data-vector-perspective-grid="" fill="none" pointerEvents="none">
            {overlay.perspective.planes.map((pl) => (
              <path key={pl.plane} data-vector-perspective-plane={pl.plane} data-active={pl.active || undefined} d={pl.d} stroke={pl.active ? accentColor : guideColor} strokeWidth={pl.active ? 1 : 0.75} opacity={pl.active ? 0.55 : 0.25} />
            ))}
            {overlay.perspective.vanishingPoints.map((v, i) => (
              <circle key={i} data-vector-vanishing-point={i} cx={v.x} cy={v.y} r={4} stroke={accentColor} strokeWidth={1.5} />
            ))}
            <circle data-vector-perspective-origin="" cx={overlay.perspective.origin.x} cy={overlay.perspective.origin.y} r={3} fill={accentColor} />
          </g>
        )}
        {overlay.symmetry.map((sy) => (
          <g key={`sym:${sy.nodeId}`} data-vector-symmetry-axes={sy.nodeId} stroke={accentColor} strokeDasharray={sy.drawing ? undefined : '6 4'} opacity={sy.drawing ? 0.9 : 0.6}>
            {sy.lines.map((l, i) => (
              <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
            ))}
          </g>
        ))}
        {overlay.trackingPoints.map((t, i) => (
          <path key={`track:${i}`} data-vector-tracking-point="" d={`M${t.x - 5} ${t.y}H${t.x + 5}M${t.x} ${t.y - 5}V${t.y + 5}`} stroke={guideColor} strokeWidth={1.5} />
        ))}
        {overlay.typedEntry && (
          <g data-vector-typed-entry="" transform={`translate(${overlay.typedEntry.x + 14} ${overlay.typedEntry.y + 18})`}>
            <rect x={-3} y={-12} width={overlay.typedEntry.text.length * 7 + 8} height={17} rx={3} fill={THEME.handleFill} stroke={accentColor} />
            <text x={1} y={1} fontSize={11} fill={accentColor} style={{ fontFamily: 'ui-monospace, monospace' }}>
              {overlay.typedEntry.text}
            </text>
          </g>
        )}
        {overlay.connectorSites.map((s) => (
          <circle
            key={`site:${s.nodeId}:${s.side}`}
            data-vector-connection-site={s.side}
            data-active={s.active || undefined}
            cx={s.x}
            cy={s.y}
            r={s.active ? 5 : 3.5}
            fill={s.active ? accentColor : THEME.handleFill}
            stroke={accentColor}
          />
        ))}
        {overlay.constraints.map((c) => (
          <g key={`constraint:${c.id}`} data-vector-constraint-glyph={c.kind} data-satisfied={c.satisfied ? 'true' : 'false'}>
            {c.dimension && <line x1={c.dimension.x1} y1={c.dimension.y1} x2={c.dimension.x2} y2={c.dimension.y2} stroke={c.satisfied ? THEME.guide : '#dc2626'} strokeDasharray="2 2" />}
            <text x={c.x} y={c.y} fontSize={10} textAnchor="middle" fill={c.satisfied ? accentColor : '#dc2626'} stroke="#ffffff" strokeWidth={3} paintOrder="stroke" style={{ fontFamily: 'system-ui, sans-serif' }}>
              {c.label}
            </text>
          </g>
        ))}
        {overlay.textBox && (
          <rect data-vector-text-box="" x={overlay.textBox.x} y={overlay.textBox.y} width={overlay.textBox.width} height={overlay.textBox.height} stroke={accentColor} strokeDasharray="3 2" />
        )}
        {overlay.marquee && (
          <rect
            data-vector-marquee=""
            x={overlay.marquee.x}
            y={overlay.marquee.y}
            width={overlay.marquee.width}
            height={overlay.marquee.height}
            fill={THEME.marqueeFill}
            stroke={accentColor}
            strokeDasharray="3 2"
          />
        )}
        {overlay.guides.lines.length > 0 && (
          <g data-vector-guides="" stroke={guideColor}>
            {overlay.guides.lines.map((l, i) => (
              <line key={i} data-vector-guide={l.kind} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeDasharray={l.kind === 'construction' ? '4 3' : undefined} />
            ))}
          </g>
        )}
        {overlay.guides.labels.map((l, i) => (
          <text
            key={i}
            data-vector-guide-label={l.kind}
            x={l.x + 6}
            y={l.y - 6}
            fontSize={10}
            fill={guideColor}
            stroke="#ffffff"
            strokeWidth={3}
            paintOrder="stroke"
            style={{ fontFamily: 'system-ui, sans-serif' }}
          >
            {l.text}
          </text>
        ))}
        {overlay.status && (
          <text data-vector-status="" x={8} y="100%" dy={-8} fontSize={11} fill={accentColor} style={{ fontFamily: 'system-ui, sans-serif' }}>
            {overlay.status}
          </text>
        )}
      </g>
      {state.textEdit && overlay.text && (
        // A hidden textarea at the caret takes typing and composed (IME) text.
        <foreignObject x={overlay.text.caret?.x1 ?? 0} y={overlay.text.caret?.y1 ?? 0} width={1} height={1} style={{ overflow: 'visible' }}>
          <textarea
            ref={textRef}
            data-testid="vector-type-input"
            aria-label="Text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ position: 'absolute', width: 1, height: 1, padding: 0, border: 0, opacity: 0, resize: 'none', overflow: 'hidden' }}
            onPointerDown={(e) => e.stopPropagation()}
            onInput={(e) => {
              const el = e.currentTarget;
              if ((e.nativeEvent as InputEvent).isComposing) return;
              if (el.value) controller.textInput(el.value);
              el.value = '';
            }}
            onCompositionEnd={(e) => {
              const el = e.currentTarget;
              if (el.value) controller.textInput(el.value);
              el.value = '';
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              // Characters come through `input`; editing keys and shortcuts go to the controller.
              if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) return;
              if (controller.keyDown(toVectorKeyInput(e))) e.preventDefault();
              if (!controller.getState().textEdit) svgRef.current?.focus({ preventScroll: true });
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onCopy={(e) => {
              const text = controller.getSelectedText();
              if (text) {
                e.clipboardData.setData('text/plain', text);
                e.preventDefault();
              }
              e.stopPropagation();
            }}
            onCut={(e) => {
              const text = controller.cutText();
              if (text) {
                e.clipboardData.setData('text/plain', text);
                e.preventDefault();
              }
              e.stopPropagation();
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text/plain');
              if (text) controller.textInput(text);
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </foreignObject>
      )}
      {state.symbolEdit && (
        // Isolation mode: which symbol, and the way out (Escape with nothing selected works too).
        <foreignObject data-vector-symbol-edit={state.symbolEdit.symbolId} x={8} y={8} width={320} height={32} style={{ overflow: 'visible' }}>
          <div
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, background: 'rgba(15,23,42,0.85)', color: '#fff', font: '12px system-ui, sans-serif' }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span>Symbol: {state.symbolEdit.name}</span>
            <button type="button" aria-label="Exit symbol" style={{ border: '1px solid rgba(255,255,255,0.4)', borderRadius: 4, padding: '0 6px', background: 'transparent', color: '#fff', cursor: 'pointer' }} onClick={() => controller.exitSymbolEdit()}>
              Done
            </button>
          </div>
        </foreignObject>
      )}
      {edit && editAt && (
        // Width Point Edit (double-click with the width tool), beside the point.
        <foreignObject data-vector-width-point-edit="" x={editAt.x + 12} y={editAt.y + 12} width={180} height={140} style={{ overflow: 'visible' }}>
          <VectorWidthPointEditor key={`${edit.nodeId}:${edit.index}:${edit.t}`} controller={controller} edit={edit} accentColor={accentColor} />
        </foreignObject>
      )}
      {playing && (
        // The agent's cursor (agent playback), over everything and never in the way.
        <foreignObject data-vector-presence="" x={0} y={0} width="100%" height="100%" pointerEvents="none" style={{ overflow: 'visible', pointerEvents: 'none' }}>
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <PresenceLayer presence={presence} viewport={state.viewport} />
          </div>
        </foreignObject>
      )}
    </svg>
  );
}
