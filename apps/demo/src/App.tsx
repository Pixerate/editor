import React, { useState } from "react";
import { PromptStudioTab } from "./components/PromptStudioTab";
import { RichDocumentTab } from "./components/RichDocumentTab";
import { ParityMatrixTab } from "./components/ParityMatrixTab";
import { Sparkles, FileText, CheckCircle2 } from "lucide-react";

export default function App() {
  const [activeTab, setActiveTab] = useState<"prompt" | "rich" | "parity">(
    "prompt"
  );

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
                  v0.1.0-preview
                </span>
              </div>
              <p className="text-xs text-slate-400">
                UI-agnostic media & rich-text editing engine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
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

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex gap-2 border-t border-slate-800/60">
          <button
            onClick={() => setActiveTab("prompt")}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-all ${
              activeTab === "prompt"
                ? "border-rose-500 text-rose-400 bg-rose-500/5"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Prompt Studio</span>
          </button>

          <button
            onClick={() => setActiveTab("rich")}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-all ${
              activeTab === "rich"
                ? "border-rose-500 text-rose-400 bg-rose-500/5"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Document Rich Text</span>
          </button>

          <button
            onClick={() => setActiveTab("parity")}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-all ${
              activeTab === "parity"
                ? "border-rose-500 text-rose-400 bg-rose-500/5"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700"
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Feature Parity Matrix</span>
          </button>
        </div>
      </header>

      {/* Main Content Body */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
        {activeTab === "prompt" && <PromptStudioTab />}
        {activeTab === "rich" && <RichDocumentTab />}
        {activeTab === "parity" && <ParityMatrixTab />}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-500">
        @pixerate/editor monorepo • JavaScript / React / Svelte UI-agnostic architecture
      </footer>
    </div>
  );
}
