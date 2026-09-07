import React from "react";
import { Check, ShieldCheck, Box } from "lucide-react";

const FEATURES = [
  {
    feature: "Token Grammar & AST Parser",
    core: true,
    react: true,
    svelte: true,
    note: "Extracts {{template}}, {variable}, __instruction__ linearly",
  },
  {
    feature: "Recursive Template Resolution",
    core: true,
    react: true,
    svelte: true,
    note: "Cycle detection with [Template loop detected], max depth 10",
  },
  {
    feature: "Bidirectional Source Mapping",
    core: true,
    react: true,
    svelte: true,
    note: "Raw character offsets <-> resolved character offsets",
  },
  {
    feature: "Plain Text Serialization Invariant",
    core: true,
    react: true,
    svelte: true,
    note: "Preserves newlines across paragraphs, intercepts paste",
  },
  {
    feature: "Live Syntax Gradient Text",
    core: true,
    react: true,
    svelte: true,
    note: "Dynamic ProseMirror inline decoration with CSS variables",
  },
  {
    feature: "Slash Command Engine (/command)",
    core: true,
    react: true,
    svelte: true,
    note: "Emits trigger coordinates and query state headlessly",
  },
  {
    feature: "Template Suggestions ({{)",
    core: true,
    react: true,
    svelte: true,
    note: "Autocomplete triggers on {{ with fuzzy matching",
  },
  {
    feature: "Read-Only Token Renderer (<TemplateRenderer>)",
    core: false,
    react: true,
    svelte: true,
    note: "Lightweight display component without TipTap dependency",
  },
  {
    feature: "Prompt Studio Editor (Headless & UI)",
    core: true,
    react: true,
    svelte: true,
    note: "usePromptEditor hook and syntax highlighting",
  },
  {
    feature: "Rich Text Document Editor",
    core: true,
    react: true,
    svelte: true,
    note: "initiateEditor and EditableTextNodeEditor component",
  },
  {
    feature: "Floating Bubble Menu",
    core: true,
    react: true,
    svelte: true,
    note: "Contextual formatting menu on selection",
  },
  {
    feature: "Emoji Smilies & Hex Color Highlighter",
    core: true,
    react: true,
    svelte: true,
    note: ":) -> 🙂 and #hex badge preview",
  },
];

export const ParityMatrixTab: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <h2 className="text-base font-semibold text-slate-100">
            Cross-Framework Feature Parity Contract
          </h2>
        </div>
        <p className="text-sm text-slate-400 mb-6">
          To prevent framework drift, core media and rich-text editing logic lives in
          the UI-agnostic core package, while React and Svelte packages provide
          ergonomic native bindings.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950 text-slate-300 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Feature / Capability</th>
                <th className="py-3 px-4 text-center">@pixerate/editor (Core)</th>
                <th className="py-3 px-4 text-center">@pixerate/editor-react</th>
                <th className="py-3 px-4 text-center">@pixerate/editor-svelte</th>
                <th className="py-3 px-4">Implementation Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {FEATURES.map((item, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-4 font-semibold text-slate-200">
                    {item.feature}
                  </td>
                  <td className="py-3 px-4 text-center">
                    {item.core ? (
                      <Check className="w-4 h-4 text-emerald-400 mx-auto" />
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center">
                    {item.react ? (
                      <Check className="w-4 h-4 text-emerald-400 mx-auto" />
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center">
                    {item.svelte ? (
                      <Check className="w-4 h-4 text-emerald-400 mx-auto" />
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-400 font-sans">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900/40 border border-slate-800 p-4 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Box className="w-4 h-4 text-rose-400" />
            <h3 className="font-semibold text-xs uppercase tracking-wider text-slate-200">
              Vanilla JavaScript
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed font-sans">
            Exported via <code>@pixerate/editor</code>. Lightweight, pure TypeScript,
            usable in Node.js, Web Workers, Firebase Functions, or custom vanilla DOM apps.
          </p>
        </div>

        <div className="bg-slate-900/40 border border-slate-800 p-4 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Box className="w-4 h-4 text-blue-400" />
            <h3 className="font-semibold text-xs uppercase tracking-wider text-slate-200">
              React Ecosystem
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed font-sans">
            Exported via <code>@pixerate/editor-react</code>. Complete prompt and rich-text editing
            with <code>usePromptEditor</code>, bubble menus, and AST renderer.
          </p>
        </div>

        <div className="bg-slate-900/40 border border-slate-800 p-4 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Box className="w-4 h-4 text-orange-400" />
            <h3 className="font-semibold text-xs uppercase tracking-wider text-slate-200">
              Svelte Ecosystem
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed font-sans">
            Exported via <code>@pixerate/editor-svelte</code>. Built with Svelte 5 Runes,
            providing reactive state, bubble menus, and <code>EditableTextNodeEditor</code>.
          </p>
        </div>
      </div>
    </div>
  );
};
