import React from "react";
import { Check, ShieldCheck, Box } from "lucide-react";
// Generated from parity/features.json (node scripts/parity.mjs), the same data as the README matrix.
import { PARITY_AREAS, PARITY_NOTES } from "../parityFeatures.generated";

/** A cell's text with `code` spans shown as code (and the README's escaped `\|` as `|`). */
function CellText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="text-emerald-200">
            {part.slice(1, -1).replace(/\\\|/g, "|")}
          </code>
        ) : (
          <React.Fragment key={i}>{part.replace(/\\\|/g, "|")}</React.Fragment>
        )
      )}
    </>
  );
}

function ParityCell({ value }: { value: string }) {
  if (value === "✅") return <Check className="w-4 h-4 text-emerald-400 mx-auto" />;
  if (value === "—") return <span className="text-slate-600">—</span>;
  if (value.startsWith("Planned")) return <span className="text-[10px] text-slate-500 font-mono">{value}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300 font-mono">
      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
      <span>
        <CellText text={value} />
      </span>
    </span>
  );
}

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
          ergonomic native bindings. The native Swift editors are checked against the same core
          through recorded conformance scenarios.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950 text-slate-300 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Feature / Capability</th>
                <th className="py-3 px-4 text-center">@pixerate/editor (Core)</th>
                <th className="py-3 px-4 text-center">@pixerate/editor-react</th>
                <th className="py-3 px-4 text-center">@pixerate/editor-svelte</th>
                <th className="py-3 px-4 text-center">Swift</th>
              </tr>
            </thead>
            {PARITY_AREAS.map((area) => (
              <tbody key={area.title} className="divide-y divide-slate-800/80">
                <tr className="bg-slate-950/60">
                  <th colSpan={5} className="py-2 px-4 text-left text-[11px] uppercase tracking-wider text-slate-400">
                    {area.title} ({area.features.length})
                  </th>
                </tr>
                {area.features.map((item) => (
                  <tr key={item.feature} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-200 font-sans">
                      <CellText text={item.feature} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <ParityCell value={item.core} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <ParityCell value={item.react} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <ParityCell value={item.svelte} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <ParityCell value={item.swift} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        {PARITY_NOTES.map((note) => (
          <p key={note} className="text-xs text-slate-400 mt-4 font-sans">
            <CellText text={note} />
          </p>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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

        <div className="bg-slate-900/40 border border-slate-800 p-4 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Box className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-xs uppercase tracking-wider text-slate-200">
              Swift (macOS and iOS)
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed font-sans">
            Native editors in <code>packages/swift</code>, ported from the core and checked against
            its recorded scenarios: same tools, same documents, same pixels.
          </p>
        </div>
      </div>
    </div>
  );
};
