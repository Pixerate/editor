import React, { Suspense, lazy, useMemo, useState } from "react";
import { CommandPalette, useCommandPalette, useRegisterCommands } from "@pixerate/editor-react/commands";
import type { CommandSpec } from "@pixerate/editor/commands";
import { demoCommandRegistry } from "./agentTools";
// Each tab loads on first visit, so the first page doesn't download every editor.
const PromptStudioTab = lazy(() => import("./components/PromptStudioTab").then((m) => ({ default: m.PromptStudioTab })));
const RichDocumentTab = lazy(() => import("./components/RichDocumentTab").then((m) => ({ default: m.RichDocumentTab })));
const ReviewDemoSection = lazy(() => import("./components/ReviewDemoSection").then((m) => ({ default: m.ReviewDemoSection })));
const SpreadsheetTab = lazy(() => import("./components/SpreadsheetTab").then((m) => ({ default: m.SpreadsheetTab })));
const CanvasTab = lazy(() => import("./components/CanvasTab").then((m) => ({ default: m.CanvasTab })));
const ImageEditorTab = lazy(() => import("./components/ImageEditorTab").then((m) => ({ default: m.ImageEditorTab })));
const PaintTab = lazy(() => import("./components/PaintTab").then((m) => ({ default: m.PaintTab })));
const ParametersTab = lazy(() => import("./components/ParametersTab").then((m) => ({ default: m.ParametersTab })));
const VectorTab = lazy(() => import("./components/VectorTab").then((m) => ({ default: m.VectorTab })));
const AnimationTab = lazy(() => import("./components/AnimationTab").then((m) => ({ default: m.AnimationTab })));
const VideoTab = lazy(() => import("./components/VideoTab").then((m) => ({ default: m.VideoTab })));
const ChartTab = lazy(() => import("./components/ChartTab").then((m) => ({ default: m.ChartTab })));
const ColorTab = lazy(() => import("./components/ColorTab").then((m) => ({ default: m.ColorTab })));
const ParityMatrixTab = lazy(() => import("./components/ParityMatrixTab").then((m) => ({ default: m.ParityMatrixTab })));
import { AgentToolsPanel } from "./components/AgentToolsPanel";
import {
  Sparkles,
  FileText,
  CheckCircle2,
  Image as ImageIcon,
  Table2,
  Shapes,
  SlidersHorizontal,
  PenTool,
  BarChart3,
  Clapperboard,
  Film,
  Brush,
  Palette,
} from "lucide-react";

type TabId = "prompt" | "rich" | "sheet" | "canvas" | "vector" | "animation" | "video" | "chart" | "image" | "paint" | "color" | "params" | "parity";

interface TabInfo {
  id: TabId;
  label: string;
  icon: React.ElementType;
  /** One line under the label in the sidebar. */
  hint: string;
}

/** Editors grouped by what they make, so the navigation reads as a short list rather than a strip of tabs. */
const GROUPS: Array<{ label: string; tabs: TabInfo[] }> = [
  {
    label: "Write",
    tabs: [
      { id: "prompt", label: "Prompt Studio", icon: Sparkles, hint: "Templates, variables, generation" },
      { id: "rich", label: "Documents", icon: FileText, hint: "Rich text, review, import" },
    ],
  },
  {
    label: "Data",
    tabs: [
      { id: "sheet", label: "Spreadsheet", icon: Table2, hint: "Formulas, formats, sheets" },
      { id: "chart", label: "Charts", icon: BarChart3, hint: "13 types, trendlines, Mermaid" },
    ],
  },
  {
    label: "Draw",
    tabs: [
      { id: "canvas", label: "Canvas", icon: Shapes, hint: "Diagrams, components, layout" },
      { id: "vector", label: "Vector", icon: PenTool, hint: "Paths, effects, gradients" },
      { id: "animation", label: "Animation", icon: Clapperboard, hint: "Shots over vector art, Flair export" },
      { id: "video", label: "Video", icon: Film, hint: "Tracks, trims, transitions, ffmpeg" },
      { id: "image", label: "Image", icon: ImageIcon, hint: "Adjustments, layers, masks" },
      { id: "paint", label: "Paint", icon: Brush, hint: "Natural media, paper, pigment" },
    ],
  },
  {
    label: "Reference",
    tabs: [
      { id: "color", label: "Colour & A11y", icon: Palette, hint: "Perceptual spaces, WCAG, CVD" },
      { id: "params", label: "Parameters", icon: SlidersHorizontal, hint: "Typed controls from a schema" },
      { id: "parity", label: "Feature parity", icon: CheckCircle2, hint: "Core, React and Svelte" },
    ],
  },
];

const TABS: TabInfo[] = GROUPS.flatMap((g) => g.tabs);

const initialTab = (): TabId => {
  // `#sheet`, `#canvas`, ... open a tab directly.
  const hash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
  return TABS.some((t) => t.id === hash) ? (hash as TabId) : "image";
};

export default function App() {
  const [activeTab, setActiveTabState] = useState<TabId>(initialTab);
  const setActiveTab = (tab: TabId) => {
    setActiveTabState(tab);
    window.history.replaceState(null, "", `#${tab}`);
  };

  // Command palette (Mod+K): tab navigation plus whatever the mounted tabs register.
  const navigationCommands = useMemo<CommandSpec[]>(
    () =>
      TABS.map(({ id, label }) => ({
        id: `app.goto.${id}`,
        label: `Go to ${label}`,
        group: "Navigate",
        keywords: ["tab", "open", id],
        run: () => setActiveTab(id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useRegisterCommands(demoCommandRegistry, navigationCommands);
  const palette = useCommandPalette(demoCommandRegistry, { hotkey: "Mod+K" });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-rose-500 to-violet-600 flex items-center justify-center font-bold text-white shadow-lg shadow-rose-500/20">
              P
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base tracking-tight text-slate-100">
                  @pixerate/editor
                </h1>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  v{__PIXERATE_VERSION__}
                </span>
              </div>
              <p className="hidden sm:block text-xs text-slate-400">
                Editors for prompts, documents, data, charts and graphics, in React and Svelte
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            <button
              type="button"
              onClick={() => palette.setOpen(true)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60"
              title="Command palette"
            >
              <span>Commands</span>
              <kbd className="font-mono text-[10px] text-slate-500">
                {demoCommandRegistry.shortcuts.platform === "mac" ? "⌘K" : "Ctrl+K"}
              </kbd>
            </button>
            <a
              href="https://github.com/Pixerate/editor"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60"
            >
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span>GitHub</span>
            </a>
          </div>
        </div>

      </header>

      <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 flex gap-8">
        {/* Navigation: a grouped sidebar on wide screens, a menu on narrow ones */}
        <nav aria-label="Editors" className="hidden lg:block w-52 shrink-0 py-8">
          <div className="sticky top-24 space-y-5">
            {GROUPS.map((group) => (
              <div key={group.label}>
                <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{group.label}</p>
                <ul className="space-y-0.5">
                  {group.tabs.map(({ id, label, hint, icon: Icon }) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => setActiveTab(id)}
                        aria-current={activeTab === id ? "page" : undefined}
                        className={`w-full flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                          activeTab === id ? "bg-rose-500/10 text-rose-300" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                        }`}
                      >
                        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>
                          <span className="block text-sm font-medium">{label}</span>
                          <span className="block text-[11px] text-slate-500">{hint}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

      {/* Main Content Body */}
      <main className="flex-1 min-w-0 py-8">
        <label className="lg:hidden mb-6 flex items-center gap-2 text-xs text-slate-400">
          <span>Editor</span>
          <select
            value={activeTab}
            onChange={(e) => setActiveTab(e.currentTarget.value as TabId)}
            className="flex-1 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          >
            {GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <Suspense fallback={<p className="py-16 text-center text-sm text-slate-500" role="status">Loading…</p>}>
          {activeTab === "prompt" && <PromptStudioTab />}
          {activeTab === "rich" && <RichDocumentTab />}
          {activeTab === "rich" && <ReviewDemoSection />}
          {activeTab === "sheet" && <SpreadsheetTab />}
          {activeTab === "canvas" && <CanvasTab />}
          {activeTab === "image" && <ImageEditorTab />}
          {activeTab === "paint" && <PaintTab />}
          {activeTab === "params" && <ParametersTab />}
          {activeTab === "vector" && <VectorTab />}
          {activeTab === "animation" && <AnimationTab />}
          {activeTab === "video" && <VideoTab />}
          {activeTab === "chart" && <ChartTab />}
          {activeTab === "color" && <ColorTab />}
          {activeTab === "parity" && <ParityMatrixTab />}
        </Suspense>
        {activeTab !== "parity" && (
          <details className="group mt-8 rounded-xl border border-slate-800 bg-slate-900/40">
            <summary className="cursor-pointer list-none px-4 py-3 text-xs font-medium text-slate-300 hover:text-slate-100 flex items-center justify-between">
              <span>Agent tools for this editor</span>
              <span className="text-slate-500 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="px-1 pb-1">
              <AgentToolsPanel />
            </div>
          </details>
        )}
      </main>
      </div>

      <CommandPalette palette={palette} />

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-500">
        <a href="https://github.com/Pixerate/editor" className="hover:text-slate-300">github.com/Pixerate/editor</a> • MIT
        {" • "}
        <a href="https://www.npmjs.com/package/@pixerate/editor" className="hover:text-slate-300">npm</a>
      </footer>
    </div>
  );
}
