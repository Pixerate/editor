import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Lightbulb, Settings2, Wrench, X, type LucideIcon } from "lucide-react";
import { AgentToolsPanel } from "./AgentToolsPanel";

/**
 * The layout every editor tab shares: a header with the editor's views, the editor itself, and a
 * side rail for everything around it (the agent, inspectors, tips, the tool list). Tabs keep their
 * controls next to the editor and move the rest out of the way with `<EditorPanel>`, so the page
 * shows one thing at a time instead of every capability stacked down the page.
 */

export interface EditorView {
  /** Goes in the URL after the tab: `#canvas/mermaid`. */
  id: string;
  label: string;
  render: () => React.ReactNode;
}

export interface EditorPageProps {
  /** The tab id, the first part of the URL hash. */
  tab: string;
  title: string;
  icon: LucideIcon;
  /** One sentence on what the editor is for. */
  description: React.ReactNode;
  /** The first view opens by default. With one view, no view switcher shows. */
  views: EditorView[];
}

type Slot = "rail" | "options";

interface PanelEntry {
  id: string;
  label: string;
  icon?: LucideIcon;
  slot: Slot;
  view: string;
  el: HTMLDivElement;
  /** Set when registered: a stable React key. */
  key?: number;
}

interface PageContext {
  register: (entry: PanelEntry) => () => void;
  openPanel: (id: string) => void;
}

const PanelRegistry = createContext<PageContext | null>(null);
const ViewScope = createContext<string>("");

/** Icons for the usual rail panels, so tabs don't repeat them. */
const PANEL_ICONS: Record<string, LucideIcon> = { agent: Bot, tips: Lightbulb, tools: Wrench };
/** The agent comes first and tips last; other panels keep the order they mounted in. */
const panelRank = (id: string) => (id === "agent" ? 0 : id === "tips" ? 2 : 1);

export interface EditorPanelProps {
  /** Panels with the same id share a rail tab (or an options section). */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** `rail` (default) opens from the header into the side rail; `options` goes in the options menu. */
  slot?: Slot;
  children: React.ReactNode;
}

/**
 * Moves its children into the page's side rail or options menu. Outside an `EditorPage` it renders
 * them in place, so shared components can use it on any tab.
 */
export function EditorPanel({ id, label, icon, slot = "rail", children }: EditorPanelProps) {
  const page = useContext(PanelRegistry);
  const view = useContext(ViewScope);
  const [el] = useState(() => document.createElement("div"));
  useLayoutEffect(() => page?.register({ id, label, icon, slot, view, el }), [page, id, label, icon, slot, view, el]);
  if (!page) return <>{children}</>;
  return createPortal(children, el);
}

/** True inside an `EditorPage`, where `EditorPanel` content shows in the side rail rather than in place. */
export function useInEditorPage(): boolean {
  return useContext(PanelRegistry) !== null;
}

/** Opens a rail panel by id, e.g. to show an export once it's ready. Does nothing outside an `EditorPage`. */
export function useOpenPanel(): (id: string) => void {
  const page = useContext(PanelRegistry);
  return useCallback((id: string) => page?.openPanel(id), [page]);
}

/** Puts a panel's portal target into the page. */
function PanelHost({ el }: { el: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.appendChild(el);
    return () => el.remove();
  }, [el]);
  return <div ref={ref} />;
}

const RAIL_KEY = "pixerate-demo:rail";

function readRail(): string | null {
  try {
    return localStorage.getItem(RAIL_KEY);
  } catch {
    return null;
  }
}

function writeRail(value: string | null) {
  try {
    if (value) localStorage.setItem(RAIL_KEY, value);
    else localStorage.removeItem(RAIL_KEY);
  } catch {
    // Storage blocked: the rail just won't be remembered.
  }
}

function viewFromHash(views: EditorView[]): string {
  const id = window.location.hash.slice(1).split("/")[1];
  return views.some((v) => v.id === id) ? id : views[0].id;
}

export function EditorPage({ tab, title, icon: Icon, description, views }: EditorPageProps) {
  const [view, setViewState] = useState(() => viewFromHash(views));
  // Views stay mounted once opened, so going back to one keeps its work.
  const [opened, setOpened] = useState(() => new Set([view]));
  const setView = (id: string) => {
    setViewState(id);
    setOpened((s) => (s.has(id) ? s : new Set(s).add(id)));
    window.history.replaceState(null, "", id === views[0].id ? `#${tab}` : `#${tab}/${id}`);
  };

  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const nextKey = useRef(0);
  const register = useCallback((entry: PanelEntry) => {
    entry.key = ++nextKey.current;
    setPanels((list) => [...list, entry]);
    return () => setPanels((list) => list.filter((e) => e !== entry));
  }, []);
  const openPanelRef = useRef<(id: string) => void>(() => {});
  const context = useMemo(() => ({ register, openPanel: (id: string) => openPanelRef.current(id) }), [register]);

  const visible = panels.filter((p) => p.view === view);
  const railTabs = useMemo(() => {
    const tabs: Array<{ id: string; label: string; icon: LucideIcon }> = [];
    for (const p of visible) {
      if (p.slot === "rail" && !tabs.some((t) => t.id === p.id)) tabs.push({ id: p.id, label: p.label, icon: p.icon ?? PANEL_ICONS[p.id] ?? Lightbulb });
    }
    tabs.sort((a, b) => panelRank(a.id) - panelRank(b.id));
    tabs.push({ id: "tools", label: "Tools", icon: Wrench });
    return tabs;
  }, [visible]);
  const options = visible.filter((p) => p.slot === "options");

  const [rail, setRailState] = useState<string | null>(readRail);
  const asideRef = useRef<HTMLElement>(null);
  const setRail = (id: string | null) => {
    setRailState(id);
    writeRail(id);
    // Below xl the rail sits under the editor, so bring it into view.
    if (id && !window.matchMedia("(min-width: 1280px)").matches) requestAnimationFrame(() => asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  openPanelRef.current = setRail;
  // A remembered tab this view doesn't have falls back to the first one.
  const openRail = rail ? (railTabs.some((t) => t.id === rail) ? rail : railTabs[0].id) : null;

  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !optionsRef.current?.contains(e.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [optionsOpen]);

  const headerButton = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors";

  return (
    <PanelRegistry.Provider value={context}>
      <header className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-100">
              <Icon className="h-5 w-5 text-rose-400" />
              {title}
            </h2>
            <p className="mt-0.5 max-w-3xl text-sm text-slate-400">{description}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1" role="toolbar" aria-label="Panels">
            {railTabs.map(({ id, label, icon: TabIcon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={openRail === id}
                onClick={() => setRail(openRail === id ? null : id)}
                className={`${headerButton} ${openRail === id ? "bg-rose-500/15 text-rose-200" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}
              >
                <TabIcon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
            {options.length > 0 && (
              <div className="relative ml-1 border-l border-slate-800 pl-1" ref={optionsRef}>
                <button
                  type="button"
                  aria-expanded={optionsOpen}
                  aria-haspopup="dialog"
                  onClick={() => setOptionsOpen((o) => !o)}
                  className={`${headerButton} ${optionsOpen ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  Options
                </button>
                {/* Kept mounted while closed: option panels hold state (autosave, providers). */}
                <div
                  role="dialog"
                  aria-label={`${title} options`}
                  hidden={!optionsOpen}
                  className="absolute right-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-xl shadow-black/40"
                >
                  {options.map((p) => (
                    <section key={p.key}>
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{p.label}</h3>
                      <PanelHost el={p.el} />
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        {views.length > 1 && (
          <div role="tablist" aria-label={`${title} views`} className="mt-4 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_rgb(30_41_59)]">
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => setView(v.id)}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
                  view === v.id ? "border-rose-400 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className={`grid gap-4 ${openRail ? "xl:grid-cols-[minmax(0,1fr)_380px]" : ""}`}>
        <div className="min-w-0">
          {views.map((v) =>
            opened.has(v.id) ? (
              <div key={v.id} role={views.length > 1 ? "tabpanel" : undefined} hidden={view !== v.id}>
                <ViewScope.Provider value={v.id}>{v.render()}</ViewScope.Provider>
              </div>
            ) : null
          )}
        </div>
        {/* Kept mounted while closed, so a running agent script or an inspector keeps its state. */}
        <aside
          ref={asideRef}
          aria-label="Side panel"
          hidden={!openRail}
          className="min-w-0 self-start rounded-xl border border-slate-800 bg-slate-900/50 xl:sticky xl:top-24 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto"
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-900/95 px-4 py-2.5 backdrop-blur">
            <span className="text-xs font-semibold text-slate-200">{railTabs.find((t) => t.id === openRail)?.label}</span>
            <button type="button" onClick={() => setRail(null)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Close side panel">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="p-3">
            {panels.map((p) =>
              p.slot === "rail" ? (
                <div key={p.key} hidden={p.view !== view || p.id !== openRail} className="space-y-3">
                  <PanelHost el={p.el} />
                </div>
              ) : null
            )}
            {openRail === "tools" && <AgentToolsPanel />}
          </div>
        </aside>
      </div>
    </PanelRegistry.Provider>
  );
}
