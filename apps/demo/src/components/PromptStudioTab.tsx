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
} from "lucide-react";
import { demoToolRegistry } from "../agentTools";
import { GenerationHistoryDemo } from "./GenerationHistoryDemo";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { EditorPage, EditorPanel } from "./EditorPage";
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

/** The prompt and its inputs, shared by every view (the generation view edits the prompt too). */
interface PromptState {
  content: string;
  setContent: (text: string) => void;
  templates: Template[];
  setTemplates: (templates: Template[]) => void;
  values: PromptValues;
  entered: Record<string, string>;
  setVariables: (values: PromptValues, entered: Record<string, string>) => void;
}

const sectionTitle = "text-xs font-semibold uppercase tracking-wider text-slate-300";

/** The prompt editor, its variables and the resolved prompt; previews and checks sit in the rail. */
const ComposeView: React.FC<{ prompt: PromptState }> = ({ prompt }) => {
  const { content, setContent, templates, values, entered, setVariables } = prompt;
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
      {/* Left Column: Editor */}
      <div className="lg:col-span-7 space-y-4">
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl relative">
          <div className="flex items-center justify-end gap-1 mb-3">
            <span className="mr-1 text-xs text-slate-400">Load:</span>
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

        {/* Recursive Template Resolution */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <h3 className={sectionTitle}>Resolved prompt</h3>
            {diagnostics.length > 0 && (
              <span className="ml-auto flex items-center gap-1 text-xs text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5" />
                {diagnostics.length} grammar problem{diagnostics.length === 1 ? "" : "s"}: see Diagnostics
              </span>
            )}
          </div>
          <div
            className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs font-mono text-cyan-200 break-words leading-relaxed"
            data-testid="resolved-prompt"
          >
            {resolvedText}
          </div>
        </div>
      </div>

      {/* Right Column: Variable fill-in form */}
      <div className="lg:col-span-5">
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <SlidersHorizontal className="w-4 h-4 text-violet-400" />
            <h3 className={sectionTitle}>Variables</h3>
          </div>
          <VariableForm
            content={content}
            templates={templates}
            values={entered}
            onChange={setVariables}
            className="flex flex-col gap-3 text-xs text-slate-300"
          />
        </div>
      </div>

      {/* Read-Only AST Renderer (Zero TipTap Dependency) */}
      <EditorPanel id="preview" label="Preview" icon={Layers}>
        <p className="text-xs text-slate-400">
          <code>&lt;TemplateRenderer /&gt;</code>: a pure AST token render without ProseMirror/TipTap overhead, previewing
          the values entered in the form (<code>values</code> prop).
        </p>
        <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80" data-testid="template-renderer">
          <TemplateRenderer
            content={content}
            templates={templates}
            templateColorMap={COLOR_MAP}
            values={values}
          />
        </div>
      </EditorPanel>

      {/* Grammar diagnostics */}
      <EditorPanel id="diagnostics" label="Diagnostics" icon={AlertTriangle}>
        {diagnostics.length === 0 ? (
          <p className="text-xs text-slate-500 italic">
            No grammar problems. Try Load: “Broken sections”.
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
      </EditorPanel>

      {/* Bidirectional Source Map */}
      <EditorPanel id="source-map" label="Source map" icon={Code2}>
        <p className="text-xs text-slate-400">Each resolved segment and the raw prompt range it came from.</p>
        <div className="space-y-1.5 text-xs font-mono">
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
      </EditorPanel>

      <EditorPanel id="tips" label="Tips">
        <ul className="space-y-1.5 text-xs leading-relaxed text-slate-400">
          <li>Type <code className="text-rose-300">/</code> for the insert menu, or use the quick-insert pills.</li>
          <li>
            <code className="text-rose-300">{"{{name}}"}</code> expands a template (recursively);{" "}
            <code className="text-amber-300">{"__name__"}</code> is a wildcard.
          </li>
          <li>
            <code className="text-violet-300">{"{name|default|description}"}</code> becomes a labelled field with the default as
            placeholder; <code className="text-violet-300">{"{?x}…{/x}"}</code> sections are kept only when <code>x</code> is set (
            <code className="text-violet-300">{"{!x}"}</code> when it is not).
          </li>
          <li>Load “Broken sections” to see the grammar report unclosed and stray section tags in Diagnostics.</li>
        </ul>
      </EditorPanel>
    </div>
  );
};

/** Asset mentions with roles + generation history (Recreate / Variation, drift). */
const GenerateView: React.FC<{ prompt: PromptState }> = ({ prompt }) => (
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
    <div className="lg:col-span-5 space-y-2">
      <h3 className={sectionTitle}>Prompt</h3>
      <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
        <TemplateRenderer content={prompt.content} templates={prompt.templates} templateColorMap={COLOR_MAP} values={prompt.values} />
      </div>
      <p className="text-xs text-slate-400">Edit it in Compose. Mentioning an asset here appends it to the prompt.</p>
    </div>
    <div className="lg:col-span-7 bg-slate-900/50 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-sky-400" />
        <h3 className={sectionTitle}>Asset roles &amp; generation history</h3>
      </div>
      <GenerationHistoryDemo
        content={prompt.content}
        onContentChange={prompt.setContent}
        values={prompt.values}
        templates={prompt.templates}
        onTemplatesChange={prompt.setTemplates}
      />
    </div>
  </div>
);

/** One prompt per CSV / JSON record, from the sample merge template or the editor's prompt. */
const MailMergeView: React.FC<{ prompt: PromptState }> = ({ prompt }) => {
  const { content, templates } = prompt;
  const [mergeTemplate, setMergeTemplate] = useState(MERGE_TEMPLATE);
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5" data-testid="merge-preview">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs text-slate-400">
          Fields are matched to variables automatically;{" "}
          <code className="text-violet-300">{"{?budget>=1000}…{/budget}"}</code> compares a field
          (<code>{"= <> < > <= >="}</code>). Records with <code>status=cancelled</code> are skipped.
        </p>
        <button
          type="button"
          onClick={() => setMergeTemplate(mergeTemplate === content ? MERGE_TEMPLATE : content)}
          className="shrink-0 px-2 py-0.5 text-[10px] rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
        >
          {mergeTemplate === content ? "Use sample prompt" : "Use editor prompt"}
        </button>
      </div>
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
  );
};

export const PromptStudioTab: React.FC = () => {
  const [content, setContent] = useState(SAMPLE_PROMPT);
  // Editable copy for resolution and generation history (Edit template → drift).
  const [templates, setTemplates] = useState<Template[]>(DEMO_TEMPLATES);
  const [values, setValues] = useState<PromptValues>({});
  const [entered, setEntered] = useState<Record<string, string>>({});
  const prompt: PromptState = {
    content,
    setContent,
    templates,
    setTemplates,
    values,
    entered,
    setVariables: (next, raw) => {
      setValues(next);
      setEntered(raw);
    },
  };

  return (
    <EditorPage
      tab="prompt"
      title="Prompt Studio"
      icon={Sparkles}
      description="A prompt editor for generative media: reusable templates, variables and asset mentions, resolved into the exact prompt a model receives."
      views={[
        { id: "compose", label: "Compose", render: () => <ComposeView prompt={prompt} /> },
        { id: "generate", label: "Generate", render: () => <GenerateView prompt={prompt} /> },
        { id: "merge", label: "Mail merge", render: () => <MailMergeView prompt={prompt} /> },
      ]}
    />
  );
};
