import React, { useEffect, useId, useRef } from 'react';
import {
  VECTOR_OVERLAY_THEME as THEME,
  getVectorOverlayRenderData,
  getVectorSceneRenderData,
  isVectorTextTarget,
  toVectorKeyInput,
  toVectorPointerInput,
  vectorDiamondPath,
  type VectorEditorController,
  type VectorRenderNode,
  type VectorRenderPath,
  type SvgGradientDef,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

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
}

/** Renders `<linearGradient>` / `<radialGradient>` descriptors. */
export function VectorGradientDefs({ defs }: { defs: readonly SvgGradientDef[] }) {
  if (!defs.length) return null;
  return (
    <defs>
      {defs.map((def) => {
        const stops = def.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.stopColor} stopOpacity={s.stopOpacity} />);
        return def.type === 'radial' ? (
          <radialGradient key={def.id} id={def.id} {...(def.attrs as any)}>
            {stops}
          </radialGradient>
        ) : (
          <linearGradient key={def.id} id={def.id} {...(def.attrs as any)}>
            {stops}
          </linearGradient>
        );
      })}
    </defs>
  );
}

/** Renders scene nodes (paths and groups) from `getVectorSceneRenderData`. */
export function VectorSceneNodes({ nodes }: { nodes: readonly VectorRenderNode[] }) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'group' ? (
          <g key={node.id} data-vector-id={node.id} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined}>
            <VectorSceneNodes nodes={node.children} />
          </g>
        ) : node.strokeParts ? (
          <VectorPartedPath key={node.id} node={node} />
        ) : (
          <path
            key={node.id}
            data-vector-id={node.id}
            transform={node.transform}
            d={node.d}
            fill={node.fill}
            fillRule={node.fillRule}
            stroke={node.stroke}
            strokeWidth={node.stroke === 'none' ? undefined : node.strokeWidth}
            strokeLinecap={node.strokeLinecap as any}
            strokeLinejoin={node.strokeLinejoin as any}
            strokeDasharray={node.strokeDasharray}
            opacity={node.opacity < 1 ? node.opacity : undefined}
          />
        ),
      )}
    </>
  );
}

/** A path whose stroke is aligned inside / outside (double width, clipped or masked by the shape) or has arrowheads. */
function VectorPartedPath({ node }: { node: VectorRenderPath }) {
  const sp = node.strokeParts!;
  const clip = sp.clip;
  const b = clip?.bounds;
  return (
    <g data-vector-id={node.id} data-vector-stroke-align={sp.align} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined}>
      {clip && b && (
        <defs>
          {clip.kind === 'clip' ? (
            <clipPath id={clip.id}>
              <path d={node.d} clipRule={node.fillRule} />
            </clipPath>
          ) : (
            <mask id={clip.id} maskUnits="userSpaceOnUse" x={b.x} y={b.y} width={b.width} height={b.height}>
              <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="#fff" />
              <path d={node.d} fill="#000" fillRule={node.fillRule} />
            </mask>
          )}
        </defs>
      )}
      <path data-vector-part="fill" d={node.d} fill={node.fill} fillRule={node.fillRule} stroke="none" />
      {sp.outline !== undefined ? (
        // A variable-width stroke: its outline, filled.
        <path
          data-vector-part="stroke-outline"
          d={sp.outline}
          fill={node.stroke}
          clipPath={clip?.kind === 'clip' ? `url(#${clip.id})` : undefined}
          mask={clip?.kind === 'mask' ? `url(#${clip.id})` : undefined}
        />
      ) : (
        <path
          data-vector-part="stroke"
          d={sp.d}
          fill="none"
          stroke={node.stroke}
          strokeWidth={sp.width}
          strokeLinecap={node.strokeLinecap as any}
          strokeLinejoin={node.strokeLinejoin as any}
          strokeDasharray={node.strokeDasharray}
          clipPath={clip?.kind === 'clip' ? `url(#${clip.id})` : undefined}
          mask={clip?.kind === 'mask' ? `url(#${clip.id})` : undefined}
        />
      )}
      {sp.heads.map((head, i) => (
        <path key={i} data-vector-part="head" d={head} fill={node.stroke} />
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
}: VectorCanvasProps) {
  const state = useVectorEditorState(controller);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fitted = useRef(!fitOnMount);
  const uid = useId().replace(/:/g, '');
  const scene = getVectorSceneRenderData(state, { idPrefix: `ve${uid}-` });
  const overlay = getVectorOverlayRenderData(state);

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
      <rect
        data-vector-artboard=""
        x={overlay.artboard.x}
        y={overlay.artboard.y}
        width={overlay.artboard.width}
        height={overlay.artboard.height}
        fill={scene.background ?? (checkerboard ? `url(#ve${uid}-checker)` : '#ffffff')}
        stroke="rgba(0,0,0,0.12)"
      />
      <g data-vector-scene="" transform={scene.transform}>
        <VectorSceneNodes nodes={scene.nodes} />
      </g>
      <g data-vector-overlay="" pointerEvents="none" fill="none">
        {overlay.outlines.map((o) => (
          <path key={o.id} d={o.d} stroke={accentColor} strokeWidth={o.selected ? 1 : 1.5} opacity={o.selected ? 1 : 0.7} />
        ))}
        {overlay.penPreview && <path d={overlay.penPreview} stroke={accentColor} strokeDasharray="4 3" />}
        {box && (
          <g data-vector-selection="" transform={box.transform || undefined}>
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
            {overlay.builder.lines.map((d, i) => (
              <path key={`l${i}`} data-vector-builder-line="" d={d} fill="none" stroke={THEME.builderErase} strokeWidth={3} strokeLinecap="round" />
            ))}
            {overlay.builder.trail && <path data-vector-builder-trail="" d={overlay.builder.trail} fill="none" stroke={overlay.builder.mode === 'erase' ? THEME.builderErase : accentColor} strokeWidth={1} />}
          </g>
        )}
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
    </svg>
  );
}
