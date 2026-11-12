import React, { useMemo, useRef, useState } from "react";
import { Paintbrush } from "lucide-react";
import { BRUSH_HOST_PROFILES, checkBrush, createBrushLibraryToolProvider, createBrushStyleToolProvider, importBrushFile, type BrushPreviewRenderer } from "@pixerate/editor/brushes";
import { demoStyles } from "../houseStyles";
import { BrushLibraryBrowser, BrushLibraryEditor, useBrushLibrary } from "@pixerate/editor-react/brushes";
import { useAgentToolProvider } from "@pixerate/editor-react";
import { renderCanvasBrushPreview } from "@pixerate/editor/canvas";
import { paintBrushPreviewRenderer } from "@pixerate/editor/paint-editor";
import { demoBrushLibrary } from "../demoBrushes";
import { demoToolRegistry } from "../agentTools";
import { EditorPage, EditorPanel } from "./EditorPage";

type Host = "paint" | "image" | "canvas" | "vector";

const HOSTS: Array<{ id: Host; label: string; hint: string }> = [
  { id: "paint", label: "Paint", hint: "The paint editor renders every facet" },
  { id: "image", label: "Image", hint: "Dry dabs, the Mixer Brush and the eraser" },
  { id: "canvas", label: "Canvas", hint: "Dry dab brushes along a path: no tools, wet, light or velocity" },
  { id: "vector", label: "Vector", hint: "As canvas; light brushes paint as plain colour" },
];

/** Each host's preview: the paint engine for paint and image, the brushstroke renderer for canvas and vector strokes. */
const paintPreview = paintBrushPreviewRenderer(undefined, { library: demoBrushLibrary });
const PREVIEWS: Record<Host, BrushPreviewRenderer> = { paint: paintPreview, image: paintPreview, canvas: renderCanvasBrushPreview, vector: renderCanvasBrushPreview };

/** What the transparent canvas / vector previews are shown on: the panel's colour (the paint engine brings its paper). */
const TRANSPARENT_BEHIND = "#0f172a";

const chip = (on: boolean) => `rounded px-2 py-1 text-xs ${on ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:text-white"}`;
const button = "rounded bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700";

function BrushesView() {
  const [host, setHost] = useState<Host>("paint");
  const [brushId, setBrushId] = useState<string | null>("ink-pen");
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const profile = BRUSH_HOST_PROFILES[host];
  // Every brush in the demo's shared library: a brush saved here shows in the Paint, Image,
  // Canvas and Vector tabs (as each host's profile admits it), and theirs show here.
  const entries = useBrushLibrary(demoBrushLibrary);
  const refused = useMemo(() => entries.map((e) => ({ entry: e, check: checkBrush(e.brush, profile) })).filter((r) => !r.check.ok), [entries, profile]);
  const selected = entries.find((e) => e.brush.id === brushId);
  const selectedCheck = selected ? checkBrush(selected.brush, profile) : null;

  // Agents get the same library, for the host chosen here (brushes__*).
  const tools = useMemo(() => createBrushLibraryToolProvider(demoBrushLibrary, { profile, renderPreview: PREVIEWS[host] }), [profile, host]);
  useAgentToolProvider(demoToolRegistry, tools);
  // House style: check_brush_style on the saved brushes, or any by id (brushstyle__*).
  useAgentToolProvider(demoToolRegistry, useMemo(() => createBrushStyleToolProvider(demoBrushLibrary, demoStyles, { namespace: "brushstyle" }), []));

  const attempt = async (fn: () => Promise<string>) => {
    try {
      setMessage(await fn());
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400">Edit for</span>
        <div role="radiogroup" aria-label="Host" className="flex gap-1">
          {HOSTS.map((h) => (
            <button key={h.id} type="button" role="radio" aria-checked={host === h.id} title={h.hint} className={chip(host === h.id)} onClick={() => setHost(h.id)}>
              {h.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500">{HOSTS.find((h) => h.id === host)!.hint}.</span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="space-y-3 lg:col-span-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Library</h3>
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-200">
            <BrushLibraryBrowser entries={entries} activeId={brushId ?? undefined} profile={profile} onSelect={setBrushId} />
          </div>
          {refused.length > 0 && (
            <details className="rounded-lg border border-slate-800 bg-slate-900/20 p-3 text-xs text-slate-400" data-testid="brushes-refused">
              <summary className="cursor-pointer">
                {refused.length} brushes {profile.name} can't use
              </summary>
              <ul className="mt-2 space-y-1.5">
                {refused.map(({ entry, check }) => (
                  <li key={entry.brush.id}>
                    <button type="button" className="text-left text-slate-300 hover:text-white" onClick={() => setBrushId(entry.brush.id)}>
                      {entry.brush.name}
                    </button>
                    <span className="block text-[11px] text-slate-500">{check.issues.find((i) => i.severity === "error")!.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-1">
            <button type="button" className={button} onClick={() => setBrushId(null)} title={`A new brush with only what ${profile.name} uses`}>
              New brush
            </button>
            <button
              type="button"
              className={button}
              title="Download the saved brushes as a library file (pixerate-brushes v2)"
              onClick={() =>
                attempt(async () => {
                  const file = await demoBrushLibrary.exportFile();
                  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
                  const a = Object.assign(document.createElement("a"), { href: url, download: "brushes.json" });
                  a.click();
                  URL.revokeObjectURL(url);
                  return `Exported ${file.brushes.length} saved brushes.`;
                })
              }
            >
              Export
            </button>
            <button type="button" className={button} onClick={() => fileRef.current?.click()}>
              Import…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.abr,.brush,.brushset,application/json"
              aria-label="Import brushes"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f)
                  attempt(async () => {
                    const r = await importBrushFile(demoBrushLibrary, f);
                    if ("format" in r) return `Imported ${r.brushes.length} brushes from ${f.name}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}. Not mapped: ${r.unsupported.join(" ") || "nothing"}${r.licence.length ? ` Licence: ${r.licence.join(" ")}` : ""}`;
                    return `Imported ${r.added.length} brushes${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}.`;
                  });
              }}
            />
          </div>
          {message && (
            <p role="status" className="text-xs text-slate-400">
              {message}
            </p>
          )}
        </div>

        <div className="space-y-3 lg:col-span-3">
          {selectedCheck && !selectedCheck.ok && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200" data-testid="brushes-host-check">
              <p className="font-medium">
                {profile.name} can't paint {selected!.brush.name}. You can still change what {profile.name} uses; the rest is kept.
              </p>
              <ul className="mt-1 list-disc pl-4">
                {selectedCheck.issues
                  .filter((i) => i.severity === "error")
                  .map((i) => (
                    <li key={i.facet}>
                      {i.reason} {i.fix}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <div className="max-w-md rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <BrushLibraryEditor key={host} library={demoBrushLibrary} brushId={brushId} profile={profile} renderPreview={PREVIEWS[host]} previewPaper={TRANSPARENT_BEHIND} onSaved={(b) => setBrushId(b.id)} />
          </div>
        </div>
      </div>
      <EditorPanel id="tips" label="Tips">
        <p className="text-xs leading-relaxed text-slate-400">
          One brush library is shared by every editor that paints. Pick the host you are making a brush for: the editor then shows only
          the controls that host can use, and a brush made here paints there. A brush with more than the host uses (light opened for
          Canvas) keeps the rest when you save. Built-in brushes are saved as a copy. Agents get the same library tools, scoped to the
          host chosen here (see Tools).
        </p>
      </EditorPanel>
    </div>
  );
}

const BRUSHES_VIEWS = [{ id: "library", label: "Library", render: () => <BrushesView /> }];

export function BrushesTab() {
  return (
    <EditorPage
      tab="brushes"
      title="Brushes"
      icon={Paintbrush}
      description="One brush library for every editor that paints: browse it, make and edit brushes for a host, and share them."
      views={BRUSHES_VIEWS}
    />
  );
}
