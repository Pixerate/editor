<script lang="ts">
  import { diagramTextBaseline, isDiagramDrag, previewDiagramDrag, type DiagramDrag, type DiagramDragKind, type DiagramMark, type DiagramScene } from '@pixerate/editor/canvas';

  interface Props {
    /** The family's picture (`createMermaidDiagram().scene`, or `mermaidToScene`). */
    scene: DiagramScene;
    /** Room around the drawing in px (default 16). */
    padding?: number;
    /** Marks with a target get a pointer and report clicks (default true). */
    interactive?: boolean;
    /** A mark was clicked: its node, edge, group or `::title` target (null: the background). */
    onselect?: (target: string | null, event: MouseEvent) => void;
    /** A mark was double-clicked (rename it with `diagramRenameOp`). */
    onopen?: (target: string, event: MouseEvent) => void;
    /**
     * Makes marks with a `drag` kind draggable (as `createMermaidDiagram().scene` has them when
     * editable): the node follows the pointer and the finished drag is reported for `drop`.
     */
    ondragend?: (drag: DiagramDrag) => void;
    /** Colour of selected marks' outline (default `var(--primary, #2563eb)`). */
    selectionColor?: string;
    /** Arrow head colour (default `var(--muted-foreground, #64748b)`). */
    markerColor?: string;
    class?: string;
    style?: string;
    /** Accessible name (default: the family). */
    title?: string;
  }

  /**
   * Headless renderer for a Mermaid family drawn as its own picture (pie, Gantt, sequence,
   * quadrant, timeline, journey, gitGraph, mindmap, C4, architecture, XY and radar charts).
   * Parity with React's `MermaidFamilyScene`.
   */
  let {
    scene,
    padding = 16,
    interactive = true,
    onselect,
    onopen,
    ondragend,
    selectionColor = 'var(--primary, #2563eb)',
    markerColor = 'var(--muted-foreground, #64748b)',
    class: className = '',
    style = '',
    title
  }: Props = $props();

  const uid = `pd-scene-${Math.random().toString(36).slice(2, 9)}`;
  const marker = (kind?: 'arrow' | 'arrowclosed') => (kind ? `url(#${uid}-${kind})` : undefined);
  let svg: SVGSVGElement | undefined = $state();
  let drag: DiagramDrag | null = $state(null);
  /** Set when a press turned into a drag, so the click that follows is not a selection. */
  let dragged = false;
  const shown = $derived(drag ? previewDiagramDrag(scene, drag, { theme: { selection: selectionColor } }) : scene);
  const toScene = (event: { clientX: number; clientY: number }): [number, number] => {
    const ctm = svg?.getScreenCTM?.();
    if (!ctm) return [event.clientX, event.clientY];
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };
  const overAt = (event: { clientX: number; clientY: number }, self: string): string | null => {
    const hit = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('[data-target]')?.getAttribute('data-target') ?? null;
    return hit && hit !== self ? hit : null;
  };
  const pointerdown = (event: PointerEvent) => {
    if (!interactive || !ondragend || event.button !== 0) return;
    const el = (event.target as Element).closest?.('[data-drag]');
    const target = el?.getAttribute('data-target');
    const kind = el?.getAttribute('data-drag') as DiagramDragKind | null;
    if (!el || !target || !kind) return;
    event.stopPropagation();
    const start = toScene(event);
    let current: DiagramDrag = { kind, target, start, pointer: start };
    dragged = false;
    const at = (ev: PointerEvent): DiagramDrag => ({ ...current, pointer: toScene(ev), over: kind === 'connect' ? overAt(ev, target) : null });
    const move = (ev: PointerEvent) => {
      current = at(ev);
      if (isDiagramDrag(current)) dragged = true;
      drag = current;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      current = at(ev);
      drag = null;
      if (isDiagramDrag(current)) ondragend(current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const cursorOf = (mark: DiagramMark) =>
    !active(mark)
      ? undefined
      : ondragend && mark.drag
        ? mark.drag === 'move-x'
          ? 'ew-resize'
          : mark.drag === 'resize'
            ? 'col-resize'
            : mark.drag === 'score' || mark.drag === 'order' || mark.drag === 'move-y'
              ? 'ns-resize'
              : mark.drag === 'connect'
                ? 'crosshair'
                : 'move'
        : 'pointer';
  const shift = (mark: DiagramMark) => (mark.offset && (mark.offset[0] || mark.offset[1]) ? `translate(${mark.offset[0]} ${mark.offset[1]})` : undefined);
  const box = $derived({ x: scene.x - padding, y: scene.y - padding, width: Math.max(1, scene.width + padding * 2), height: Math.max(1, scene.height + padding * 2) });
  const active = (mark: DiagramMark) => interactive && !!mark.target;
  const strokeOf = (mark: { stroke?: string; selected?: boolean }) => (mark.selected ? selectionColor : mark.stroke);
  const widthOf = (mark: { strokeWidth?: number; selected?: boolean }) => (mark.selected ? Math.max(2, mark.strokeWidth ?? 0) : mark.strokeWidth);
  /** The target of the mark under the event (events are delegated to the `<svg>`). */
  const targetAt = (event: MouseEvent) => (event.target as Element).closest?.('[data-target]')?.getAttribute('data-target') ?? null;
  const click = (event: MouseEvent) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (interactive) onselect?.(targetAt(event), event);
  };
  const dblclick = (event: MouseEvent) => {
    const target = targetAt(event);
    if (interactive && target) onopen?.(target, event);
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  class="pixerate-diagram-scene {className}"
  data-family={scene.family}
  role="img"
  aria-label={title ?? `${scene.family} diagram`}
  viewBox="{box.x} {box.y} {box.width} {box.height}"
  width={box.width}
  height={box.height}
  style="display:block;max-width:100%;height:auto;overflow:visible;{style}"
  onclick={click}
  ondblclick={dblclick}
  onpointerdown={pointerdown}
>
  <defs>
    <marker id="{uid}-arrowclosed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 Z" style:fill={markerColor} />
    </marker>
    <marker id="{uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10" style:fill="none" style:stroke={markerColor} style:stroke-width="1.5" />
    </marker>
  </defs>
  {#each shown.marks as mark (mark.key)}
    {#if mark.kind === 'rect'}
      <rect
        data-role={mark.role}
        data-target={active(mark) ? mark.target : undefined}
        data-selected={mark.selected ? '' : undefined}
        x={mark.x}
        y={mark.y}
        width={Math.max(0, mark.width)}
        height={Math.max(0, mark.height)}
        rx={mark.radius}
        stroke-dasharray={mark.dash}
        opacity={mark.opacity}
        transform={shift(mark)}
        pointer-events={active(mark) ? undefined : 'none'}
        cursor={cursorOf(mark)}
        data-drag={ondragend && active(mark) ? mark.drag : undefined}
        style:fill={mark.fill}
        style:stroke={strokeOf(mark)}
        style:stroke-width={widthOf(mark)}
      />
    {:else if mark.kind === 'circle'}
      <circle
        data-role={mark.role}
        data-target={active(mark) ? mark.target : undefined}
        data-selected={mark.selected ? '' : undefined}
        cx={mark.cx}
        cy={mark.cy}
        r={mark.r}
        opacity={mark.opacity}
        transform={shift(mark)}
        pointer-events={active(mark) ? undefined : 'none'}
        cursor={cursorOf(mark)}
        data-drag={ondragend && active(mark) ? mark.drag : undefined}
        style:fill={mark.fill}
        style:stroke={strokeOf(mark)}
        style:stroke-width={widthOf(mark)}
      />
    {:else if mark.kind === 'line'}
      <line
        data-role={mark.role}
        data-target={active(mark) ? mark.target : undefined}
        data-selected={mark.selected ? '' : undefined}
        x1={mark.x1}
        y1={mark.y1}
        x2={mark.x2}
        y2={mark.y2}
        stroke-dasharray={mark.dash}
        marker-end={marker(mark.markerEnd)}
        marker-start={marker(mark.markerStart)}
        opacity={mark.opacity}
        transform={shift(mark)}
        pointer-events={active(mark) ? undefined : 'none'}
        cursor={cursorOf(mark)}
        data-drag={ondragend && active(mark) ? mark.drag : undefined}
        style:stroke={mark.selected ? selectionColor : mark.stroke}
        style:stroke-width={mark.strokeWidth ?? 1}
      />
    {:else if mark.kind === 'path'}
      <path
        data-role={mark.role}
        data-target={active(mark) ? mark.target : undefined}
        data-selected={mark.selected ? '' : undefined}
        d={mark.d}
        stroke-dasharray={mark.dash}
        stroke-linejoin="round"
        marker-end={marker(mark.markerEnd)}
        marker-start={marker(mark.markerStart)}
        opacity={mark.opacity}
        transform={shift(mark)}
        pointer-events={active(mark) ? undefined : 'none'}
        cursor={cursorOf(mark)}
        data-drag={ondragend && active(mark) ? mark.drag : undefined}
        style:fill={mark.fill ?? 'none'}
        style:stroke={strokeOf(mark)}
        style:stroke-width={widthOf(mark)}
      />
    {:else}
      <text
        data-role={mark.role}
        data-target={active(mark) ? mark.target : undefined}
        data-selected={mark.selected ? '' : undefined}
        x={mark.x}
        y={mark.y}
        text-anchor={mark.anchor}
        dominant-baseline={diagramTextBaseline(mark.baseline)}
        transform={[shift(mark), mark.rotate ? `rotate(${mark.rotate} ${mark.x} ${mark.y})` : ''].filter(Boolean).join(' ') || undefined}
        opacity={mark.opacity}
        pointer-events={active(mark) ? undefined : 'none'}
        cursor={cursorOf(mark)}
        data-drag={ondragend && active(mark) ? mark.drag : undefined}
        style:fill={mark.selected ? selectionColor : mark.fill}
        style:font-size="{mark.size}px"
        style:font-weight={mark.weight}
        style:font-style={mark.italic ? 'italic' : undefined}
        style:user-select="none">{mark.text}</text
      >
    {/if}
  {/each}
</svg>
