import React, { useState } from 'react';
import { ImageEditor } from '@pixerate/editor-react';
import { Image as ImageIcon, Download, Sparkles, Upload } from 'lucide-react';

const SAMPLE_IMAGES = [
  {
    name: 'Eltz Castle (Sample 1)',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
  },
  {
    name: 'Mountain Lake (Sample 2)',
    url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
  },
  {
    name: 'Abstract Gradient (Sample 3)',
    url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=1200&q=80',
  },
];

export function ImageEditorTab() {
  const [selectedImage, setSelectedImage] = useState<string>(SAMPLE_IMAGES[0].url);
  const [exportedUrl, setExportedUrl] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setSelectedImage(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-indigo-400" />
            Media & Image Editor Studio
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            UI-agnostic Canvas 2D engine with freeform/aspect crop, color adjustments, annotations, and depth alpha masking.
          </p>
        </div>

        {/* Preset Selectors & Custom Upload */}
        <div className="flex flex-wrap items-center gap-2">
          {SAMPLE_IMAGES.map((img) => (
            <button
              key={img.name}
              type="button"
              onClick={() => setSelectedImage(img.url)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                selectedImage === img.url
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow'
                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {img.name.split(' (')[0]}
            </button>
          ))}

          <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Image</span>
            <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </div>

      {/* Editor Component */}
      <div className="w-full">
        <ImageEditor
          src={selectedImage}
          onSave={(dataUrl) => {
            setExportedUrl(dataUrl);
          }}
        />
      </div>

      {/* Export Preview */}
      {exportedUrl && (
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              Latest Export Output
            </span>
            <a
              href={exportedUrl}
              download="pixerate-edited-image.png"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
            >
              <Download className="w-3.5 h-3.5" />
              Download PNG
            </a>
          </div>
          <div className="flex justify-center p-2 bg-slate-950 rounded-lg border border-slate-800/80">
            <img
              src={exportedUrl}
              alt="Exported output"
              className="max-h-64 rounded object-contain shadow-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
}
