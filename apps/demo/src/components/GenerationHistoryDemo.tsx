import React, { useMemo, useState } from "react";
import {
  AssetMentionChips,
  GenerationHistory,
  useGenerationRecords,
} from "@pixerate/editor-react";
import {
  createGenerationRecord,
  createGenerationRecordStore,
  describeAssetMentions,
  findTextMentions,
  type AssetInfo,
  type CreateGenerationRecordOptions,
  type ModelCapabilities,
  type PlanAssetMention,
} from "@pixerate/editor/generation";
import { createMemoryStorage } from "@pixerate/editor/persistence";
import type { PromptValues, Template } from "@pixerate/editor";
import { History, ImagePlus, Wand2 } from "lucide-react";

/** Fake asset library for the demo. */
export const DEMO_ASSETS: AssetInfo[] = [
  { id: "fox_photo", label: "fox_photo", mediaType: "image/png", contentHash: "sha-fox-v1" },
  { id: "monet", label: "monet", mediaType: "image/jpeg", contentHash: "sha-monet-v1" },
  { id: "harbour_clip", label: "harbour_clip", mediaType: "video/mp4", contentHash: "sha-clip-v1" },
];

/** A fake image model that declares which asset roles it accepts. */
export const DEMO_MODEL: ModelCapabilities = {
  id: "demo-image",
  name: "Demo Image Model",
  media: "image",
  prompt: { maxLength: 600 },
  aspectRatios: { options: ["1:1", "16:9", "9:16"], default: "1:1" },
  resolutions: { options: ["1k", "2k"], default: "1k" },
  seed: { min: 0, max: 999_999 },
  references: {
    roles: {
      style_ref: { max: 1, accepts: ["image"] },
      character_ref: { max: 2, accepts: ["image"] },
      subject: { max: 1, label: "Subject", description: "The main subject to keep", accepts: ["image/*"] },
    },
    maxTotal: 3,
  },
};

const store = createGenerationRecordStore({ storage: createMemoryStorage(), maxRecords: 20 });

interface Props {
  content: string;
  onContentChange: (text: string) => void;
  values: PromptValues;
  templates: Template[];
  onTemplatesChange: (templates: Template[]) => void;
}

/**
 * Asset mentions with roles (`@fox_photo:subject`), a fake generation that
 * records everything needed to recreate it, and a history panel that reports
 * drift after templates, assets or model capabilities change.
 */
export const GenerationHistoryDemo: React.FC<Props> = ({
  content,
  onContentChange,
  values,
  templates,
  onTemplatesChange,
}) => {
  const { records } = useGenerationRecords(store);
  const [assets, setAssets] = useState(DEMO_ASSETS);
  const [message, setMessage] = useState<string | null>(null);

  const mentions: PlanAssetMention[] = useMemo(
    () =>
      describeAssetMentions(findTextMentions(content), assets).map((chip) => ({
        id: chip.asset.id,
        label: chip.handle,
        ...(chip.role ? { role: chip.role } : {}),
        mediaType: chip.asset.mediaType,
        contentHash: chip.asset.contentHash,
      })),
    [content, assets],
  );

  const run = async (options: CreateGenerationRecordOptions, label: string) => {
    // A real app would call the provider here and record the outputs.
    const record = createGenerationRecord({ ...options, assets, outputIds: [`out-${Date.now().toString(36)}`] });
    await store.put(record);
    const dropped = record.provenance.adjustments.filter((a) => a.kind === "dropped").length;
    setMessage(`${label}: ${record.provenance.resolvedPrompt.slice(0, 60)}… (seed ${record.seed ?? "–"}${dropped ? `, ${dropped} dropped` : ""})`);
  };

  const generate = () =>
    run(
      {
        rawPrompt: content,
        templates,
        values,
        model: DEMO_MODEL,
        request: { aspectRatio: "16:9", resolution: "4k", seed: Math.floor(Math.random() * 1_000_000) },
        mentions,
      },
      "Generated",
    );

  const editTemplate = () => {
    onTemplatesChange(
      templates.map((t) =>
        t.name === "golden_hour" ? { ...t, body: `${t.body}, lens flare`, latestVersion: `${t.latestVersion ?? "1.0"}+` } : t,
      ),
    );
    setMessage("Edited {{golden_hour}}: Recreate now reports template drift.");
  };

  const replaceAsset = () => {
    setAssets((list) => list.map((a) => (a.id === "fox_photo" ? { ...a, contentHash: `${a.contentHash}*` } : a)));
    setMessage("Replaced the fox_photo file: records using it report a changed asset.");
  };

  return (
    <div className="space-y-3" data-testid="generation-history-demo">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400">Mention an asset:</span>
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => onContentChange(`${content.trimEnd()} @${asset.id}`)}
            className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-500/30"
          >
            <ImagePlus className="inline w-3 h-3 mr-1" />@{asset.id}
            <span className="ml-1 text-slate-500">{asset.mediaType}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-400">
        Click a chip to pick its role (<code className="text-sky-300">@fox_photo:subject</code>); roles and accepted media
        come from the model&apos;s capabilities.
      </p>
      <AssetMentionChips
        content={content}
        onChange={onContentChange}
        assets={assets}
        capabilities={DEMO_MODEL}
        className="text-slate-200"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void generate()}
          className="px-2.5 py-1 text-xs rounded bg-rose-600 hover:bg-rose-500 text-white"
          data-testid="fake-generate"
        >
          <Wand2 className="inline w-3.5 h-3.5 mr-1" />
          Generate (fake)
        </button>
        <button
          type="button"
          onClick={editTemplate}
          className="px-2.5 py-1 text-xs rounded border border-amber-500/40 bg-slate-800 hover:bg-slate-700 text-amber-300"
          data-testid="edit-template"
        >
          Edit {"{{golden_hour}}"}
        </button>
        <button
          type="button"
          onClick={replaceAsset}
          className="px-2.5 py-1 text-xs rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
        >
          Replace fox_photo file
        </button>
      </div>
      {message && <p className="text-[11px] text-slate-400 font-mono">{message}</p>}
      <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
        <History className="w-4 h-4 text-sky-400" />
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">History ({records.length})</h4>
      </div>
      <GenerationHistory
        records={records}
        templates={templates}
        capabilities={[DEMO_MODEL]}
        assets={assets}
        onRecreate={(result) => void run(result.recordOptions, "Recreated")}
        onVariation={(result) => void run(result.recordOptions, "Variation")}
        onRemove={(record) => void store.remove(record.id)}
        className="text-slate-200"
      />
    </div>
  );
};
