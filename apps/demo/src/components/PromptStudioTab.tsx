import React, { useState } from "react";
import {
  usePromptEditor,
  EditorContent,
  TemplateRenderer,
  Template,
} from "@pixerate/editor-react";
import {
  resolveTemplatesWithMapping,
  resolveTemplates,
  tokenizePrompt,
} from "@pixerate/editor";
import { Sparkles, Code2, Layers, Terminal } from "lucide-react";

const DEMO_TEMPLATES: Template[] = [
  {
    name: "golden_hour",
    body: "warm 35mm volumetric lighting casting soft shadows",
    latestVersion: "1.0",
    color: "amber",
  },
  {
    name: "cyberpunk_city",
    body: "sprawling neon-lit mega city in rain with {{golden_hour}} reflections",
    latestVersion: "1.0",
    color: "purple",
  },
  {
    name: "octane_masterpiece",
    body: "8k octane render with raytracing and depth of field",
    latestVersion: "1.0",
    color: "emerald",
  },
];

const COLOR_MAP = new Map([
  ["golden_hour", { from: "#f59e0b", to: "#ef4444" }],
  ["cyberpunk_city", { from: "#8b5cf6", to: "#ec4899" }],
  ["octane_masterpiece", { from: "#10b981", to: "#06b6d4" }],
]);

export const PromptStudioTab: React.FC = () => {
  const [content, setContent] = useState(
    "A photorealistic portrait of {character} in {{cyberpunk_city}}, __award_winning__ composition, shot with {lens}."
  );
  const [slashMenu, setSlashMenu] = useState<{
    visible: boolean;
    query: string;
    coords: { top: number; left: number };
    range: { from: number; to: number };
  }>({
    visible: false,
    query: "",
    coords: { top: 0, left: 0 },
    range: { from: 0, to: 0 },
  });

  const editor = usePromptEditor({
    content,
    onContentChange: (newText) => setContent(newText),
    templates: DEMO_TEMPLATES,
    templateColorMap: COLOR_MAP,
    placeholder: "Type a prompt... use {{template}}, {variable}, or /command",
    className:
      "w-full bg-slate-900 border border-slate-800 rounded-lg p-4 font-mono text-sm leading-relaxed text-slate-100 focus:ring-2 focus:ring-rose-500/50 min-h-[140px]",
    onSlashCommandMatch: (match, from, to, coords) => {
      setSlashMenu({
        visible: true,
        query: match[1] || "",
        coords,
        range: { from, to },
      });
    },
    clearSlashCommand: () => {
      setSlashMenu((prev) => ({ ...prev, visible: false }));
    },
  });

  const { text: resolvedText, map: sourceMap } = resolveTemplatesWithMapping(
    content,
    DEMO_TEMPLATES
  );
  const tokens = tokenizePrompt(content);

  const insertToken = (tokenText: string) => {
    if (editor) {
      if (slashMenu.visible) {
        editor
          .chain()
          .focus()
          .deleteRange(slashMenu.range)
          .insertContent(tokenText)
          .run();
        setSlashMenu((prev) => ({ ...prev, visible: false }));
      } else {
        editor.chain().focus().insertContent(` ${tokenText}`).run();
      }
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Editor & Controls */}
      <div className="lg:col-span-7 space-y-4">
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl relative">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-rose-400" />
              <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-300">
                SlopMachine Prompt Studio (Parity)
              </h2>
            </div>
            <span className="text-xs text-slate-400 font-mono bg-slate-800 px-2 py-0.5 rounded">
              TipTap + ProseMirror Headless
            </span>
          </div>

          <div className="relative">
            <EditorContent editor={editor} />

            {/* Slash Command Floating Menu */}
            {slashMenu.visible && (
              <div
                style={{ top: slashMenu.coords.top, left: slashMenu.coords.left }}
                className="absolute z-50 bg-slate-900 border border-slate-700 shadow-2xl rounded-lg p-2 w-64 text-xs font-mono"
              >
                <div className="text-slate-400 px-2 py-1 uppercase text-[10px] tracking-wider">
                  Insert Template or Variable
                </div>
                <div className="space-y-1 mt-1">
                  {DEMO_TEMPLATES.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => insertToken(`{{${t.name}}}`)}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-rose-500/20 text-rose-300 flex items-center justify-between"
                    >
                      <span>{`{{${t.name}}}`}</span>
                      <span className="text-[10px] text-slate-400">template</span>
                    </button>
                  ))}
                  <button
                    onClick={() => insertToken("{character}")}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-violet-500/20 text-violet-300 flex items-center justify-between"
                  >
                    <span>{"{character}"}</span>
                    <span className="text-[10px] text-slate-400">variable</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Quick Insert Pills */}
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-2 items-center">
            <span className="text-xs text-slate-400">Quick insert:</span>
            {DEMO_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => insertToken(`{{${t.name}}}`)}
                className="px-2 py-1 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-rose-300 border border-rose-500/30 transition-colors"
              >
                {`+ {{${t.name}}}`}
              </button>
            ))}
            <button
              onClick={() => insertToken("{resolution}")}
              className="px-2 py-1 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-violet-300 border border-violet-500/30 transition-colors"
            >
              + {"{resolution}"}
            </button>
            <button
              onClick={() => insertToken("__cinematic__")}
              className="px-2 py-1 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 transition-colors"
            >
              + __cinematic__
            </button>
          </div>
        </div>

        {/* Read-Only AST Renderer (Zero TipTap Dependency) */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Read-Only Renderer (&lt;TemplateRenderer /&gt;)
            </h3>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Pure AST token render without ProseMirror/TipTap overhead:
          </p>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
            <TemplateRenderer
              content={content}
              templates={DEMO_TEMPLATES}
              templateColorMap={COLOR_MAP}
            />
          </div>
        </div>
      </div>

      {/* Right Column: Grammar & Source Mapping Insights */}
      <div className="lg:col-span-5 space-y-4">
        {/* Recursive Template Resolution */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Recursive Resolution (Up to 10 Levels)
            </h3>
          </div>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs font-mono text-cyan-200 break-words leading-relaxed">
            {resolvedText}
          </div>
        </div>

        {/* Bidirectional Source Map */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Code2 className="w-4 h-4 text-indigo-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Bidirectional Source Map
            </h3>
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1.5 text-xs font-mono">
            {sourceMap.map((seg, i) => (
              <div
                key={i}
                className={`p-2 rounded border text-[11px] ${
                  seg.source === "template"
                    ? "bg-rose-950/30 border-rose-500/40 text-rose-300"
                    : "bg-slate-950 border-slate-800 text-slate-300"
                }`}
              >
                <div className="flex justify-between font-bold">
                  <span>
                    [{seg.source.toUpperCase()}] {seg.templateName || "raw text"}
                  </span>
                  <span>
                    Raw: {seg.rawStart}..{seg.rawEnd}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400">
                  Resolved offset: {seg.resolvedStart}..{seg.resolvedEnd}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
