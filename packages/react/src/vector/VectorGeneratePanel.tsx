import React, { useState } from 'react';
import { VECTOR_GENERATED_IMAGE_AS, generateVectorArt, vectorArtModels, type VectorArtGenerator, type VectorEditorController, type VectorGeneratedImageAs, type VectorArtModel } from '@pixerate/editor/vector';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const AS_LABELS: Record<VectorGeneratedImageAs, string> = { color: 'Traced in colour', threshold: 'Traced in one colour', mosaic: 'Mosaic', halftone: 'Halftone', lowPoly: 'Low poly', hatch: 'Engraving' };

export interface VectorGeneratePanelProps {
  controller: VectorEditorController;
  /** The host's models (image models are traced or stylised; text models write SVG). */
  models: readonly VectorArtModel[];
  /** The host's generator (sends a planned request to its model). */
  generate: VectorArtGenerator;
  className?: string;
}

/**
 * Generative prompts: describe art, pick a model (and, for image models, how the picture becomes
 * vectors) and generate it into the artboard as one editable group. One undo step.
 */
export function VectorGeneratePanel({ controller, models, generate, className }: VectorGeneratePanelProps) {
  const usable = vectorArtModels(models);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [as, setAs] = useState<VectorGeneratedImageAs>('color');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const chosen = usable.find((m) => m.id === model) ?? usable[0];
  if (!usable.length) return null;
  const run = async () => {
    setBusy(true);
    setMessage(null);
    const r = await generateVectorArt(controller, { prompt, model: chosen.id, as, idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}` }, { models, generate });
    setBusy(false);
    setMessage(r.ok ? null : (r.message ?? 'Generation failed.'));
  };
  return (
    <div className={`space-y-1 ${className ?? ''}`} data-vector-generate-panel="" aria-label="Generate">
      <div className="flex items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Generate</span>
        <select aria-label="Generation model" className={selectClass} value={chosen.id} onChange={(e) => setModel(e.target.value)}>
          {usable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.id}
            </option>
          ))}
        </select>
        {chosen.media === 'image' && (
          <select aria-label="Image to vectors" className={selectClass} value={as} onChange={(e) => setAs(e.target.value as VectorGeneratedImageAs)}>
            {VECTOR_GENERATED_IMAGE_AS.map((a) => (
              <option key={a} value={a}>
                {AS_LABELS[a]}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="w-16" />
        <input type="text" aria-label="Prompt" placeholder="Describe the art…" className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && prompt.trim() && !busy && void run()} />
        <button type="button" className={buttonClass} data-vector-generate-action="" disabled={!prompt.trim() || busy} onClick={() => void run()}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
      {message && <p className="text-[11px] text-red-600">{message}</p>}
    </div>
  );
}
