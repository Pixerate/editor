import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Play } from "lucide-react";
import { PAGE_KIT, PAGE_KIT_GUIDE, PAGE_KIT_HASH, PAGE_KIT_VERSION } from "@pixerate/editor/page-kit";
import { drawPieces, type DrawPieces } from "@pixerate/editor/animation";
import { useLinkFocus } from "@pixerate/editor-react";
import { uiComponents, type ChartUiComponent } from "@pixerate/editor/chart";
import { EditorPage, EditorPanel } from "./EditorPage";

/**
 * The page kit (#814) in a sandboxed iframe: a page built only from `window.pixerateKit`, the way a
 * model-written page would be. The iframe has scripts but no same origin, and its content security
 * policy blocks every network request, so the kit is all it has.
 */

/** The page's own code: a lineage fan with fitted labels and a braid with over/under, drawn on. */
const ENGINE = String.raw`
const kit = window.pixerateKit;
const items = ['Research', 'Design', 'Engineering', 'Operations', 'Marketing', 'Customer success'];
const pic = document.getElementById('pic');
let motion;
function draw() {
  kit.clear(pic);
  const width = pic.clientWidth || 640;
  const height = 360;
  const ink = kit.theme.token('--ink', '#1f2937');
  const muted = kit.theme.token('--muted', '#64748b');
  const strandColors = [kit.theme.token('--a', '#e11d48'), kit.theme.token('--b', '#2563eb')];
  const root = kit.svg('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'A team fan and a braid' }, pic);

  // Fan: one root to a row of teams, labels sized so the longest word fits its column.
  const column = (width - 40) / items.length;
  const targets = items.map((_, i) => ({ x: 20 + column * (i + 0.5), y: 150 }));
  const fan = kit.fanElbows({ x: width / 2, y: 24 }, targets, { gap: 5, radius: 10 });
  const words = items.flatMap((t) => t.split(' '));
  const fit = kit.fitText(words, column - 8, { measure: kit.canvasMeasure('600 system-ui, sans-serif'), min: 9, max: 15, tracking: { floor: -0.03 } });
  const paths = fan.elbows.map((e) => kit.svg('path', { d: e.d, fill: 'none', stroke: muted, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, root));
  kit.svg('circle', { cx: width / 2, cy: 24, r: 5, fill: ink }, root);
  const labels = items.map((t, i) => {
    const text = kit.svg('text', { x: targets[i].x, y: 172, 'text-anchor': 'middle', 'font-size': fit.size, 'letter-spacing': fit.letterSpacing, 'font-weight': 600, fill: ink, 'font-family': 'system-ui, sans-serif' }, root);
    t.split(' ').forEach((w, line) => kit.svg('tspan', { x: targets[i].x, dy: line ? fit.size * 1.2 : 0, text: w }, text));
    return text;
  });

  // Braid: two strands, back runs first so the front runs pass over.
  const strands = [0, Math.PI].map((phase) => kit.helix([{ x: 30, y: 290 }, { x: width - 30, y: 290 }], { amplitude: 26, turns: 3.5, phase, envelope: 'start' }));
  const runs = strands.flatMap((h, s) => kit.splitByDepth(h.points, h.depth).map((r) => ({ ...r, s, total: h.length })));
  const ordered = runs.filter((r) => !r.front).concat(runs.filter((r) => r.front));
  const braid = ordered.map((r) => ({ r, el: kit.svg('path', { d: r.d, fill: 'none', stroke: strandColors[r.s], 'stroke-width': 7, 'stroke-linecap': 'round', opacity: r.front ? 1 : 0.55 }, root) }));
  kit.svg('text', { x: 30, y: 340, fill: muted, 'font-size': 12, 'font-family': 'system-ui, sans-serif', text: 'Labels at ' + fit.size + ' px (set by "' + fit.word + '"), kit ' + kit.version }, root);

  motion = kit.defineMotion((p) => {
    fan.elbows.forEach((e, i) => {
      const t = kit.phase(p, 0.05 * i, 0.05 * i + 0.45);
      paths[i].setAttribute('stroke-dasharray', e.length * t + ' ' + e.length);
      paths[i].setAttribute('visibility', t > 0 ? 'visible' : 'hidden');
      labels[i].setAttribute('opacity', kit.phase(p, 0.05 * i + 0.35, 0.05 * i + 0.55));
    });
    // Each run shows the part of its strand drawn so far: the strand grows from left to right.
    braid.forEach(({ r, el }) => {
      const drawn = r.total * kit.phase(p, 0.3, 1);
      const shown = Math.max(0, Math.min(r.length, drawn - r.from));
      el.setAttribute('stroke-dasharray', shown + ' ' + r.length);
      // A zero-length dash with round caps still draws a dot.
      el.setAttribute('visibility', shown > 0 ? 'visible' : 'hidden');
    });
  }, { duration: 2400 });
}
kit.onResize(pic, () => draw());
kit.theme.onChange(() => draw());
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'theme') {
    for (const [k, v] of Object.entries(m.tokens || {})) document.documentElement.style.setProperty(k, v);
    document.documentElement.setAttribute('data-theme', m.mode);
    document.body.style.background = m.tokens['--surface'];
    window.dispatchEvent(new Event('pixerate:theme'));
  } else if (m.type === 'seek') window.pageMotion.seek(m.p);
  else if (m.type === 'replay') window.pageMotion.play();
});
parent.postMessage({ type: 'kit-ready', version: kit.version }, '*');
`;

const THEMES = {
  light: { "--surface": "#ffffff", "--ink": "#1f2937", "--muted": "#64748b", "--a": "#e11d48", "--b": "#2563eb" },
  dark: { "--surface": "#0f172a", "--ink": "#e2e8f0", "--muted": "#94a3b8", "--a": "#fb7185", "--b": "#60a5fa" },
} as const;

function pageHtml(): string {
  // No network: the policy allows only inline script and style.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>html,body{margin:0;font-family:system-ui,sans-serif;background:#fff}#pic{width:100%}</style>
<script>${PAGE_KIT}</script></head>
<body><div id="pic" data-picture></div><p data-about hidden>A fan from one root to six teams, and a two-strand braid.</p>
<script>${ENGINE.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

function PageKitView() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [progress, setProgress] = useState(1);
  const [ready, setReady] = useState<string | null>(null);
  const html = useMemo(pageHtml, []);
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data?.type === "kit-ready") setReady(e.data.version);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (ready) post({ type: "theme", mode, tokens: THEMES[mode] });
  }, [ready, mode]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
        <button type="button" className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-3 py-1.5 hover:bg-slate-700" onClick={() => post({ type: "replay" })}>
          <Play className="h-4 w-4" aria-hidden /> Replay
        </button>
        <label className="flex items-center gap-2">
          Progress
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={progress}
            onChange={(e) => {
              const p = Number(e.currentTarget.value);
              setProgress(p);
              post({ type: "seek", p });
            }}
          />
          <span className="w-10 tabular-nums">{progress.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2">
          Theme
          <select className="rounded bg-slate-800 px-2 py-1" value={mode} onChange={(e) => setMode(e.currentTarget.value as "light" | "dark")}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <span className="text-xs text-slate-500" role="status">
          {ready ? `Kit ${ready} running in the sandbox` : "Loading the page…"} · {(new Blob([PAGE_KIT]).size / 1024).toFixed(1)} kB · {PAGE_KIT_HASH}
        </span>
      </div>
      <iframe
        ref={frame}
        title="A page built from the page kit"
        sandbox="allow-scripts"
        srcDoc={html}
        className="h-[380px] w-full rounded-lg border border-slate-800 bg-white"
      />
      <EditorPanel id="tips" label="Tips">
        <div className="space-y-2 text-sm text-slate-300">
          <p>
            <code>@pixerate/editor/page-kit</code> exports strings only: <code>PAGE_KIT</code> (this script), <code>PAGE_KIT_GUIDE</code> (what a model is told) and{" "}
            <code>PAGE_KIT_FILES</code> for <code>assemblePage</code> in genui-core.
          </p>
          <p>The frame above loads nothing: its policy blocks every request, and it has no same-origin access. Version {PAGE_KIT_VERSION}.</p>
        </div>
      </EditorPanel>
      <EditorPanel id="guide" label="Guide">
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs text-slate-300">{PAGE_KIT_GUIDE}</pre>
      </EditorPanel>
    </div>
  );
}


/** Projects and the skills they use: a many-to-many weave for linked focus (#812). */
const PROJECTS = ["Atlas", "Beacon", "Cinder", "Delta", "Ember"];
const SKILLS = ["Design", "Data", "Platform", "Research"];
const USES: Record<string, string[]> = {
  Atlas: ["Design", "Research"],
  Beacon: ["Data", "Platform"],
  Cinder: ["Design", "Data"],
  Delta: ["Platform"],
  Ember: ["Research", "Data", "Design"],
};

function LinkFocusView() {
  const width = 640;
  const px = (i: number) => 70 + i * ((width - 140) / (PROJECTS.length - 1));
  const sx = (i: number) => 110 + i * ((width - 220) / (SKILLS.length - 1));
  const links = PROJECTS.flatMap((p, i) => USES[p].map((s) => ({ p, s, d: `M${px(i)} 70 C${px(i)} 150 ${sx(SKILLS.indexOf(s))} 150 ${sx(SKILLS.indexOf(s))} 230` })));
  const marks = [...PROJECTS.map((p) => [p]), ...SKILLS.map((s) => [s]), ...links.map((l) => [l.p, l.s])];
  const focus = useLinkFocus({ marks, links: USES, order: [...PROJECTS, ...SKILLS], dim: 0.18 });
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const [plans, setPlans] = useState<DrawPieces[]>([]);
  const [progress, setProgress] = useState(1);
  // Each link draws on as its own line, staggered; measured once the paths are in the page.
  useEffect(() => {
    setPlans(
      links.map((_, i) => {
        const length = pathRefs.current[i]?.getTotalLength?.() ?? 200;
        return drawPieces([{ from: 0, to: length }], { at: (i / links.length) * 0.6, span: 0.4, ease: "ease-out" });
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const replay = useCallback(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1800);
      setProgress(p);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);
  const offset = PROJECTS.length + SKILLS.length;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm text-slate-300">
        <button type="button" className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-3 py-1.5 hover:bg-slate-700" onClick={replay}>
          <Play className="h-4 w-4" aria-hidden /> Draw on
        </button>
        <span className="text-xs text-slate-500">Hover a project or a skill, or focus the picture and use the arrow keys (Escape clears).</span>
      </div>
      <div {...focus.rootProps} className="rounded-lg border border-slate-800 bg-slate-950 p-2 outline-none focus-visible:ring-2 focus-visible:ring-rose-400" tabIndex={0} aria-label="Projects and the skills they use">
        <svg viewBox={`0 0 ${width} 280`} className="w-full" role="img" aria-hidden>
          {links.map((l, i) => {
            const drawn = plans[i]?.drawAt(progress)[0];
            return (
              <path
                key={`${l.p}-${l.s}`}
                ref={(el) => {
                  pathRefs.current[i] = el;
                }}
                d={l.d}
                fill="none"
                stroke="#fb7185"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={drawn?.dasharray}
                visibility={drawn && !drawn.shown ? "hidden" : undefined}
                style={{ opacity: focus.opacity(offset + i), transition: "opacity 120ms" }}
              />
            );
          })}
          {PROJECTS.map((p, i) => (
            <g key={p} {...focus.markProps(p)} style={{ opacity: focus.opacity(i), cursor: "pointer", transition: "opacity 120ms" }}>
              <circle cx={px(i)} cy={58} r={9} fill="#e2e8f0" />
              <text x={px(i)} y={36} textAnchor="middle" fill="#e2e8f0" fontSize={13} fontWeight={600}>{p}</text>
            </g>
          ))}
          {SKILLS.map((s, i) => (
            <g key={s} {...focus.markProps(s)} style={{ opacity: focus.opacity(PROJECTS.length + i), cursor: "pointer", transition: "opacity 120ms" }}>
              <rect x={sx(i) - 42} y={232} width={84} height={26} rx={13} fill="#1e293b" stroke="#60a5fa" />
              <text x={sx(i)} y={249} textAnchor="middle" fill="#bfdbfe" fontSize={12}>{s}</text>
            </g>
          ))}
        </svg>
      </div>
      <p aria-live="polite" className="text-sm text-slate-400">{focus.description}</p>
    </div>
  );
}

/** Editor's chart types and data visuals as UI components (#819): what a component library syncs. */
function UiComponentView({ component, dark }: { component: ChartUiComponent; dark: boolean }) {
  const interactive = Boolean(component.interaction);
  const options = useMemo(() => (component.interaction ? component.interaction(component.descriptor.example) : { marks: [], links: {} }), [component]);
  const focus = useLinkFocus({ ...options, dim: 0.2 });
  const [progress, setProgress] = useState(1);
  const size = component.id === "sparkline" ? { width: 160, height: 32 } : component.id === "donut-chart" ? { width: 360, height: 260 } : { width: 560, height: component.id === "weave" ? 280 : 220 };
  const svg = component.render(component.descriptor.example, { ...size, theme: dark ? "dark" : "light", progress: interactive ? progress : undefined, focus: interactive ? focus.state.focus : undefined, dim: 0.2 });
  const play = () => {
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1800);
      setProgress(p);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  // Marks carry data-link-focus; pointer events on them focus their key.
  const onPointerOver = (e: React.PointerEvent) => {
    const key = (e.target as Element).closest("[data-link-focus]")?.getAttribute("data-link-focus");
    if (key && !key.includes(" ")) focus.model.focus(key);
  };
  return (
    <figure className="space-y-2 rounded-lg border border-slate-800 p-3">
      <figcaption className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
        <span className="font-medium text-slate-100">{component.title}</span>
        <code className="text-xs text-slate-500">{component.descriptor.implements} · {component.descriptor.contentHash}</code>
        {interactive && (
          <>
            <button type="button" className="ml-auto inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700" onClick={play}>
              <Play className="h-3 w-3" aria-hidden /> Draw on
            </button>
            <input type="range" min={0} max={1} step={0.01} value={progress} aria-label={`${component.title} progress`} onChange={(e) => setProgress(Number(e.currentTarget.value))} />
          </>
        )}
      </figcaption>
      <div
        {...(interactive ? focus.rootProps : {})}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `${component.title}: arrow keys move the focus` : undefined}
        onPointerOver={interactive ? onPointerOver : undefined}
        className="max-w-full overflow-hidden rounded outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {interactive && <p aria-live="polite" className="text-xs text-slate-400">{focus.description}</p>}
      <p className="text-xs text-slate-500">{component.description}</p>
    </figure>
  );
}

function UiComponentsView() {
  const components = useMemo(() => uiComponents(), []);
  const [dark, setDark] = useState(true);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={dark} onChange={(e) => setDark(e.currentTarget.checked)} /> Dark
      </label>
      <p className="text-sm text-slate-400">
        <code>uiComponents()</code> from <code>@pixerate/editor/chart</code>: each type with a <code>UiDescriptor</code> and a <code>render</code> a component library syncs. The data visuals draw on
        frame by frame and light linked marks on hover or with the arrow keys.
      </p>
      <div className="grid gap-3 xl:grid-cols-2">
        {components.map((c) => (
          <UiComponentView key={c.id} component={c} dark={dark} />
        ))}
      </div>
    </div>
  );
}

export function PageKitTab() {
  return (
    <EditorPage
      tab="pagekit"
      title="Page kit"
      icon={Boxes}
      description="Core's geometry, paths, text fitting, colour and scales as one script for sandboxed, model-written pages."
      views={[
        { id: "demo", label: "Sandboxed page", render: () => <PageKitView /> },
        { id: "focus", label: "Linked focus", render: () => <LinkFocusView /> },
        { id: "components", label: "UI components", render: () => <UiComponentsView /> },
      ]}
    />
  );
}
