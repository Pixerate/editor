import React, { useMemo, useState } from "react";
import {
  usePromptEditor,
  EditorContent,
  TemplateRenderer,
  VariableForm,
  MergePreview,
  useAgentToolProvider,
  Template,
  PromptValues,
} from "@pixerate/editor-react";
import { resolvePrompt } from "@pixerate/editor";
import { createRichTextToolProvider } from "@pixerate/editor/agent";
import {
  Sparkles,
  Code2,
  Layers,
  Terminal,
  SlidersHorizontal,
  AlertTriangle,
  Table2,
} from "lucide-react";
import { demoToolRegistry } from "../agentTools";
import { GenerationHistoryDemo } from "./GenerationHistoryDemo";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { demoTextPresence } from "../agentScript";
import { PROMPT_SCRIPTS } from "../agentScripts";

const SAMPLE_PROMPT =
  "A photorealistic portrait of {character|a weathered sea captain|Who is in the shot?} in {{cyberpunk_city}}, __award_winning__ composition{?lens}, shot with a {lens|35mm|Lens focal length} lens{/lens}{!lens}, wide angle{/lens}.";

// `{?mood}` opens a section that is never closed: the grammar keeps the tag
// as literal text and reports it in `diagnostics`.
const BROKEN_PROMPT =
  "A quiet harbour at dawn{?mood} with a {mood|melancholy} atmosphere, {{golden_hour}}{/fog}.";

// Mail merge sample: one prompt per row, with a comparison section.
const MERGE_TEMPLATE =
  "Portrait of {character|a stranger} in {setting}{?budget>=1000}, {{octane_masterpiece}}{/budget}{!budget>=1000}, quick sketch{/budget}.";

const SAMPLE_CSV = `Character,Setting,Budget,Status
a weathered sea captain,a storm-lashed harbour,1500,active
a street violinist,a rainy Paris alley,200,active
an astronaut,the surface of Mars,5000,cancelled
,a quiet library,80,active`;

const DEMO_TEMPLATES: Template[] = [
  {
    name: "golden_hour",
    body: "warm 35mm volumetric lighting casting soft shadows",
    latestVersion: "1.0",
    color: "amber",
  },
  {
    name: "cyberpunk_city",
    body: "sprawling neon-lit mega city in {weather|light rain|Weather in the city} with {{golden_hour}} reflections",
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
  const [content, setContent] = useState(SAMPLE_PROMPT);
  // Editable copy for resolution and generation history (Edit template → drift).
  const [templates, setTemplates] = useState<Template[]>(DEMO_TEMPLATES);
  const [values, setValues] = useState<PromptValues>({});
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [mergeTemplate, setMergeTemplate] = useState(MERGE_TEMPLATE);
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

  const provider = useMemo(
    () => (editor ? createRichTextToolProvider(editor, { id: "prompt", namespace: "prompt", presence: demoTextPresence() }) : null),
    [editor]
  );
  useAgentToolProvider(demoToolRegistry, provider);

  // Templates expanded and variables filled in (defaults apply to blank fields).
  const {
    text: resolvedText,
    map: sourceMap,
    diagnostics,
  } = resolvePrompt(content, templates, { values });

  // `usePromptEditor` applies parent content changes to the editor.
  const loadPrompt = (text: string) => setContent(text);

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
                Prompt Studio (Interactive Demo)
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
        <AgentScriptPanel scripts={PROMPT_SCRIPTS} hint="Plays a scripted agent turn with the prompt__* tools: find_text returns positions, replace_range and insert_text edit there." />

        {/* Read-Only AST Renderer (Zero TipTap Dependency) */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Read-Only Renderer (&lt;TemplateRenderer /&gt;)
            </h3>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Pure AST token render without ProseMirror/TipTap overhead, previewing
            the values entered in the form (<code>values</code> prop):
          </p>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80" data-testid="template-renderer">
            <TemplateRenderer
              content={content}
              templates={templates}
              templateColorMap={COLOR_MAP}
              values={values}
            />
          </div>
        </div>
      </div>

      {/* Right Column: Grammar & Source Mapping Insights */}
      <div className="lg:col-span-5 space-y-4">
        {/* Variable fill-in form */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-violet-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Variables (&lt;VariableForm /&gt;)
              </h3>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => loadPrompt(SAMPLE_PROMPT)}
                className="px-2 py-0.5 text-[10px] rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                Sample
              </button>
              <button
                type="button"
                onClick={() => loadPrompt(BROKEN_PROMPT)}
                className="px-2 py-0.5 text-[10px] rounded border border-amber-500/40 bg-slate-800 hover:bg-slate-700 text-amber-300"
              >
                Broken sections
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            <code className="text-violet-300">{"{name|default|description}"}</code> becomes a labelled
            field with the default as placeholder; <code className="text-violet-300">{"{?x}…{/x}"}</code>{" "}
            sections are kept only when <code>x</code> is set (<code className="text-violet-300">{"{!x}"}</code>{" "}
            when it is not).
          </p>
          <VariableForm
            content={content}
            templates={templates}
            values={entered}
            onChange={(next, raw) => {
              setValues(next);
              setEntered(raw);
            }}
            className="flex flex-col gap-3 text-xs text-slate-300"
          />
        </div>

        {/* Recursive Template Resolution */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Resolved Prompt (resolvePrompt with values)
            </h3>
          </div>
          <div
            className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs font-mono text-cyan-200 break-words leading-relaxed"
            data-testid="resolved-prompt"
          >
            {resolvedText}
          </div>
        </div>

        {/* Asset mentions with roles + generation history (Recreate / Variation, drift) */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Asset Roles &amp; Generation History
            </h3>
          </div>
          <GenerationHistoryDemo
            content={content}
            onContentChange={loadPrompt}
            values={values}
            templates={templates}
            onTemplatesChange={setTemplates}
          />
        </div>

        {/* Mail merge preview */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5" data-testid="merge-preview">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Table2 className="w-4 h-4 text-emerald-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Mail Merge (&lt;MergePreview /&gt;)
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setMergeTemplate(mergeTemplate === content ? MERGE_TEMPLATE : content)}
              className="px-2 py-0.5 text-[10px] rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              {mergeTemplate === content ? "Use sample prompt" : "Use editor prompt"}
            </button>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            One prompt per CSV / JSON record. Fields are matched to variables automatically;{" "}
            <code className="text-violet-300">{"{?budget>=1000}…{/budget}"}</code> compares a field
            (<code>{"= <> < > <= >="}</code>). Records with <code>status=cancelled</code> are skipped.
          </p>
          <MergePreview
            content={mergeTemplate}
            templates={templates}
            templateColorMap={COLOR_MAP}
            defaultSource={SAMPLE_CSV}
            skipIf="status=cancelled"
            downloadName="prompts"
            className="flex flex-col gap-3 text-xs text-slate-300"
          />
        </div>

        {/* Grammar diagnostics */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className={`w-4 h-4 ${diagnostics.length ? "text-amber-400" : "text-slate-500"}`} />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Diagnostics ({diagnostics.length})
            </h3>
          </div>
          {diagnostics.length === 0 ? (
            <p className="text-xs text-slate-500 italic">
              No grammar problems. Try “Broken sections”.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs" data-testid="prompt-diagnostics">
              {diagnostics.map((d, i) => (
                <li key={i} className="p-2 rounded border border-amber-500/40 bg-amber-950/30 text-amber-200">
                  <div className="font-mono text-[10px] text-amber-400">
                    {d.code} · {d.templateName ? `template ${d.templateName}` : "prompt"} @ {d.start}..{d.end}
                  </div>
                  {d.message}
                </li>
              ))}
            </ul>
          )}
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
