<script lang="ts">
  import ImageColor from './controls/ImageColor.svelte';
  import { imageDividerClass, imageEditorFrameClass, imageEditorHeaderClass, imageErrorBannerClass, imageHeaderButtonClass, imagePrimaryButtonClass, imageRangeClass, imageSectionClass, imageSectionTitleClass, imageSelectClass, imageSidebarClass, imageSmallButtonClass, imageSpinnerClass, imageTabClass, imageTabListClass } from './styles.js';
  import type {
    ExportOptions,
    ImageEditorTool,
    InpaintHook,
    RemoveBackgroundHook,
    ImageEditorAIHooks,
    ImageEditorFit,
  } from '@pixerate/editor/image-editor';
  import type { AgentPlayback, PlaybackRef } from '@pixerate/editor/tools';
  import {
    normalizeProcessVersion,
    LATEST_PROCESS_VERSION,
    IMAGE_ADJUSTMENT_CONTROLS,
    readAdjustmentControls,
    DEFAULT_SELECTION_TOOL_OPTIONS,
    FreeTransformTool,
    DEFAULT_SHAPE_TOOL_OPTIONS,
    DEFAULT_TYPE_TOOL_OPTIONS,
    type SelectionToolOptions,
    type ShapeToolOptions,
    type TextEditSession,
    type TypeToolOptions,
  } from '@pixerate/editor/image-editor';
  import ImageEditorCanvas from './ImageEditorCanvas.svelte';
  import type { ImageEditorCanvasErrorSource, ImageEditorCanvasMode } from './canvasTypes.js';
  import ControlSlider from './ControlSlider.svelte';
  import Histogram from './Histogram.svelte';
  import AdjustmentLayersPanel from './AdjustmentLayersPanel.svelte';
  import LayersPanel from './LayersPanel.svelte';
  import ColorProfilePanel from './ColorProfilePanel.svelte';
  import BrushOptionsBar from './BrushOptionsBar.svelte';
  import SelectionOptionsBar from './SelectionOptionsBar.svelte';
  import RefineEdgePanel from './RefineEdgePanel.svelte';
  import FreeTransformOptionsBar from './FreeTransformOptionsBar.svelte';
  import ShapeOptionsBar from './ShapeOptionsBar.svelte';
  import TypeOptionsBar from './TypeOptionsBar.svelte';
  import { onDestroy, untrack } from 'svelte';
  import { createReactiveImageEditor, type ReactiveImageEditor } from './imageEditorState.svelte.js';
  import ImageProviderEffectsPanel from './ImageProviderEffectsPanel.svelte';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import { useEffects } from '../effects/effects.svelte.js';

  interface Props {
    editor?: ReactiveImageEditor;
    src?: string;
    class?: string;
    style?: string;
    onSave?: (dataUrl: string) => void;
    exportOptions?: ExportOptions;
    onInpaint?: InpaintHook;
    onRemoveBackground?: RemoveBackgroundHook;
    aiHooks?: ImageEditorAIHooks;
    fit?: ImageEditorFit;
    /**
     * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
     * mounted: filter effects as smart filters and generator or overlay effects as effect layers,
     * with an Effects section in the Layers tab. Optional: without one the editor is as before.
     */
    effects?: EffectProvider | null;
    /**
     * Agent playback: act out the image tools' calls here with the agent's cursor, opening the
     * panel each tool belongs to (default: `setAgentPlayback` above; `null` turns it off).
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `image`, where the image tool providers play). */
    playbackId?: string;
    /** Bring the editor on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }

  let {
    editor: propEditor,
    src = '',
    class: className = '',
    style = '',
    onSave,
    exportOptions,
    onInpaint,
    onRemoveBackground,
    aiHooks,
    fit,
    effects,
    playback,
    playbackId = 'image',
    onplaybackreveal,
  }: Props = $props();

  const internalEditor = createReactiveImageEditor();
  const editor = $derived(propEditor || internalEditor);
  onDestroy(() => internalEditor.destroy());
  useEffects(() => editor.controller, () => effects);
  const hasEffects = (l: import('@pixerate/editor/image-editor').ImageLayer): boolean =>
    (l.type === 'pixel' && !!l.generator) || (l.type === 'smart' && !!l.smartFilters?.filters.some((f) => f.kind === 'effect')) || (l.type === 'group' && l.children.some(hasEffects));
  const effectsShown = $derived(!!effects || !!editor.controller.effectsProvider || editor.state.layers.some(hasEffects));
  const legacyProcess = $derived(
    normalizeProcessVersion(editor.state.adjustments.process) < LATEST_PROCESS_VERSION
  );

  let activeTab = $state<'crop' | 'adjust' | 'layers' | 'paint' | 'select' | 'annotate' | 'depth' | 'ai'>('crop');
  let rootEl = $state<HTMLDivElement | null>(null);
  /** The tabs with canvas gestures drive the canvas mode; the others only view. */
  const canvasMode = $derived<ImageEditorCanvasMode>(
    activeTab === 'crop' || activeTab === 'select' || activeTab === 'paint' || activeTab === 'annotate' ? activeTab : 'none'
  );

  /** Agent playback opens a panel by clicking its tab, unless it is already open. */
  async function openPanel(ref: PlaybackRef) {
    if (ref.kind !== 'panel' || activeTab === ref.id) return;
    rootEl?.querySelector<HTMLElement>(`[data-image-tab="${CSS.escape(ref.id)}"]`)?.click();
    // Let the panel render before the cursor looks for its controls.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  // Tool options for the canvas, set by the options bars.
  let selectionOptions = $state<SelectionToolOptions>({ ...DEFAULT_SELECTION_TOOL_OPTIONS });
  let shapeOptions = $state<ShapeToolOptions>({ ...DEFAULT_SHAPE_TOOL_OPTIONS });
  let typeOptions = $state<TypeToolOptions>({ ...DEFAULT_TYPE_TOOL_OPTIONS });
  let typeSession = $state<TextEditSession | null>(null);
  let shapeTypeError = $state<string | null>(null);
  let paintError = $state<string | null>(null);
  let selectionError = $state<string | null>(null);
  let activeCropRatio = $state<number | null>(null);
  function handleCanvasError(source: ImageEditorCanvasErrorSource, message: string | null) {
    if (source === 'paint') paintError = message;
    else if (source === 'select') selectionError = message;
    else shapeTypeError = message;
  }
  function finishTyping() {
    // The canvas finishes the edit when its bound session is cleared.
    typeSession = null;
  }

  // Free Transform (Ctrl/Cmd+T): shared with the canvas, which drives and draws it.
  const transformTool = $derived(
    new FreeTransformTool(editor.controller, {
      schedule: (run) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : run()),
    })
  );
  let transformTick = $state(0);
  const transformActive = $derived((void transformTick, transformTool.active));
  const transformError = $derived((void transformTick, transformTool.error));
  $effect(() => {
    const tool = transformTool;
    const off = tool.subscribe(() => {
      transformTick++;
    });
    return () => {
      off();
      tool.cancel();
    };
  });

  // AI state
  let inpaintPrompt = $state('');
  let inpaintMaskMode = $state<'annotations' | 'crop'>('annotations');
  let isRemovingBg = $state(false);
  let isInpainting = $state(false);
  let aiError = $state<string | null>(null);
  let aiSuccess = $state<string | null>(null);
  /** Where AI results go: by layer count (auto), a new layer / mask, or replacing the Background. */
  let aiTarget = $state<'auto' | 'new-layer' | 'replace'>('auto');
  const aiOptions = $derived(aiTarget === 'auto' ? {} : { target: aiTarget });

  const effectiveOnInpaint = $derived(onInpaint || aiHooks?.onInpaint);
  const effectiveOnRemoveBg = $derived(onRemoveBackground || aiHooks?.onRemoveBackground);

  async function handleRemoveBackground() {
    if (!effectiveOnRemoveBg) {
      aiError = 'No background removal hook is configured.';
      return;
    }
    aiError = null;
    aiSuccess = null;
    isRemovingBg = true;
    try {
      // AI hooks work in natural pixels (no crop or rotation): the source when the result replaces
      // it, the composite of the layers when the result becomes a layer or mask.
      const imageDataUrl = await editor.controller.toAIInputDataURL(aiOptions);
      const result = await effectiveOnRemoveBg({ imageDataUrl });
      if (typeof result === 'string') {
        await editor.applyBackgroundRemovedImage(result, aiOptions);
        aiSuccess = 'Background removed successfully!';
      } else {
        aiSuccess = 'Background removal complete.';
      }
    } catch (err: any) {
      aiError = err?.message || 'Failed to remove background.';
    } finally {
      isRemovingBg = false;
    }
  }

  async function handleInpaint() {
    if (!effectiveOnInpaint) {
      aiError = 'No inpainting hook is configured.';
      return;
    }
    if (!inpaintPrompt.trim()) {
      aiError = 'Please enter an inpainting prompt.';
      return;
    }
    aiError = null;
    aiSuccess = null;
    isInpainting = true;
    try {
      // Source image and mask share natural image space so they line up exactly.
      const imageDataUrl = await editor.controller.toAIInputDataURL(aiOptions);
      const maskDataUrl = await editor.toMaskDataURL({
        useAnnotations: inpaintMaskMode === 'annotations',
        useCrop: inpaintMaskMode === 'crop',
      });
      const result = await effectiveOnInpaint({
        prompt: inpaintPrompt.trim(),
        imageDataUrl,
        maskDataUrl,
        cropBox: inpaintMaskMode === 'crop' ? editor.state.crop : null,
      });
      if (typeof result === 'string') {
        await editor.applyInpaintedImage(result, aiOptions);
        aiSuccess = 'Inpainting applied successfully!';
      } else {
        aiSuccess = 'Inpainting complete.';
      }
    } catch (err: any) {
      aiError = err?.message || 'Failed to apply inpainting.';
    } finally {
      isInpainting = false;
    }
  }

  // Annotation drafting state
  let activeColor = $state('#ef4444');
  let strokeWidth = $state(3);
  let fontSize = $state(24);
  let textInput = $state('');

  // Load the image when `src` changes. Only `src` is tracked: AI edits replace
  // the editor's source with a data URL and must not be reverted to `src`.
  let loadedSrc: string | undefined;
  $effect(() => {
    const next = src;
    if (!next || next === loadedSrc) return;
    loadedSrc = next;
    untrack(() => {
      if (next !== editor.state.sourceUrl) editor.loadImage(next);
    });
  });

  $effect(() => {
    if (activeTab === 'crop' && editor.state.activeTool !== 'crop') {
      editor.setTool('crop');
    }
  });

  function handleAddText() {
    if (!textInput.trim()) return;
    editor.addAnnotation({
      type: 'text',
      x: 50,
      y: 50,
      text: textInput.trim(),
      fontSize,
      color: activeColor,
    });
    textInput = '';
  }

  async function handleExport() {
    const dataUrl = await editor.toDataURL(exportOptions);
    if (onSave) {
      onSave(dataUrl);
    } else {
      const link = document.createElement('a');
      link.download = `edited-image-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    }
  }
</script>

<div
  bind:this={rootEl}
  class="{imageEditorFrameClass} {className}"
  {style}
>
  <!-- Top Action Header -->
  <div class={imageEditorHeaderClass}>
    <!-- Navigation Tabs -->
    <div role="tablist" class={imageTabListClass}>
      <button
        type="button"
        data-image-tab="crop"
        onclick={() => {
          activeTab = 'crop';
          editor.setTool('crop');
        }}
        role="tab" aria-selected={activeTab === 'crop'} class="{imageTabClass(activeTab === 'crop')}"
      >
        Transform & Crop
      </button>
      <button
        type="button"
        data-image-tab="adjust"
        onclick={() => {
          activeTab = 'adjust';
          editor.setTool('select');
        }}
        role="tab" aria-selected={activeTab === 'adjust'} class="{imageTabClass(activeTab === 'adjust')}"
      >
        Adjustments
      </button>
      <button
        type="button"
        data-image-tab="layers"
        onclick={() => {
          activeTab = 'layers';
          editor.setTool('select');
        }}
        role="tab" aria-selected={activeTab === 'layers'} class="{imageTabClass(activeTab === 'layers')}"
      >
        Layers
      </button>
      <button
        type="button"
        data-image-tab="paint"
        onclick={() => {
          activeTab = 'paint';
          editor.setTool('brush');
        }}
        role="tab" aria-selected={activeTab === 'paint'} class="{imageTabClass(activeTab === 'paint')}"
      >
        Paint
      </button>
      <button
        type="button"
        data-image-tab="select"
        onclick={() => {
          activeTab = 'select';
          editor.setTool('select');
        }}
        role="tab" aria-selected={activeTab === 'select'} class="{imageTabClass(activeTab === 'select')}"
      >
        Select & Mask
      </button>
      <button
        type="button"
        data-image-tab="annotate"
        onclick={() => {
          activeTab = 'annotate';
          editor.setTool('pen');
        }}
        role="tab" aria-selected={activeTab === 'annotate'} class="{imageTabClass(activeTab === 'annotate')}"
      >
        Annotations
      </button>
      <button
        type="button"
        data-image-tab="depth"
        onclick={() => {
          activeTab = 'depth';
          editor.setTool('select');
        }}
        role="tab" aria-selected={activeTab === 'depth'} class="{imageTabClass(activeTab === 'depth')}"
      >
        Depth Mask
      </button>
      <button
        type="button"
        data-image-tab="ai"
        onclick={() => {
          activeTab = 'ai';
          editor.setTool('select');
        }}
        role="tab" aria-selected={activeTab === 'ai'} class="{imageTabClass(activeTab === 'ai')} flex items-center gap-1.5"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        AI Tools
      </button>
    </div>

    <!-- Global Action Tools (Undo/Redo, Zoom, Compare, Save) -->
    <div class="flex items-center gap-2 text-xs">
      <button
        type="button"
        disabled={!editor.canUndo}
        onclick={() => editor.undo()}
        class={imageHeaderButtonClass}
        title="Undo"
      >
        ↩
      </button>
      <button
        type="button"
        disabled={!editor.canRedo}
        onclick={() => editor.redo()}
        class={imageHeaderButtonClass}
        title="Redo"
      >
        ↪
      </button>
      <button
        type="button"
        onclick={() => editor.reset()}
        class="{imageHeaderButtonClass} px-2 text-muted-foreground"
      >
        Reset
      </button>

      <div class="h-4 w-px bg-muted mx-1"></div>

      <!-- Zoom -->
      <button
        type="button"
        onclick={() => editor.zoomOut()}
        class={imageHeaderButtonClass}
        title="Zoom Out"
      >
        -
      </button>
      <span class="font-mono text-muted-foreground w-10 text-center">{Math.round(editor.state.zoom * 100)}%</span>
      <button
        type="button"
        onclick={() => editor.zoomIn()}
        class={imageHeaderButtonClass}
        title="Zoom In"
      >
        +
      </button>

      <div class="h-4 w-px bg-muted mx-1"></div>

      <!-- Live Compare -->
      <button
        type="button"
        onmousedown={() => editor.setComparing(true)}
        onmouseup={() => editor.setComparing(false)}
        onmouseleave={() => editor.setComparing(false)}
        class="px-2.5 py-1.5 rounded-lg border border-border bg-background text-amber-600 hover:bg-muted select-none active:bg-amber-500/10"
      >
        Hold Compare
      </button>

      <!-- Save / Export -->
      <button
        type="button"
        onclick={handleExport}
        class="{imagePrimaryButtonClass} px-4 py-1.5"
      >
        Export Image
      </button>
    </div>
  </div>

  <!-- Main Viewport + Sidebar Layout -->
  <!-- Free Transform options bar (Ctrl/Cmd+T), above the viewport while a transform is open -->
  {#if transformActive}
    <FreeTransformOptionsBar tool={transformTool} class="border-b border-border bg-background/95 px-4 py-2" />
  {:else if transformError}
    <div role="alert" class={imageErrorBannerClass}>{transformError}</div>
  {/if}

  <div class="flex flex-col md:flex-row flex-1 min-h-[520px] md:h-[560px]">
    <!-- Canvas Area -->
    <ImageEditorCanvas
      {editor}
      mode={canvasMode}
      {fit}
      {selectionOptions}
      {shapeOptions}
      {typeOptions}
      annotationColor={activeColor}
      annotationWidth={strokeWidth}
      cropRatio={activeCropRatio}
      onerror={handleCanvasError}
      bind:typeSession
      {transformTool}
      {playback}
      {playbackId}
      {onplaybackreveal}
      chromeRoot={() => rootEl}
      open={openPanel}
      class="flex-1 h-[360px] md:h-full min-h-[320px] bg-muted"
    />

    <!-- Tab Controls Sidebar -->
    <div class={imageSidebarClass}>
      <!-- TAB 1: CROP & TRANSFORM -->
      {#if activeTab === 'crop'}
        <div class="flex flex-col gap-4 text-xs">
          <span class={imageSectionTitleClass}>
            Aspect Ratio Presets
          </span>
          <div class="grid grid-cols-3 gap-2">
            <button
              type="button"
              onclick={() => {
                activeCropRatio = null;
                editor.applyCropPreset(null);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === null && editor.state.crop
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent text-foreground border-border'}"
            >
              Freeform
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 1;
                editor.applyCropPreset(1);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 1
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent text-foreground border-border'}"
            >
              1:1 Square
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 4 / 3;
                editor.applyCropPreset(4 / 3);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 4 / 3
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent text-foreground border-border'}"
            >
              4:3 Standard
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 16 / 9;
                editor.applyCropPreset(16 / 9);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 16 / 9
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent text-foreground border-border'}"
            >
              16:9 Wide
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 3 / 2;
                editor.applyCropPreset(3 / 2);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 3 / 2
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent text-foreground border-border'}"
            >
              3:2 Photo
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = null;
                editor.resetCrop();
              }}
              class="px-2.5 py-2 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/40 font-medium"
            >
              Clear Crop
            </button>
          </div>

          <div class={imageDividerClass}></div>

          <span class={imageSectionTitleClass}>
            Orientation & Flips
          </span>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => editor.rotate(-90)}
              class="px-3 py-2 rounded-lg bg-muted hover:bg-accent text-foreground border border-border"
            >
              Rotate -90°
            </button>
            <button
              type="button"
              onclick={() => editor.rotate(90)}
              class="px-3 py-2 rounded-lg bg-muted hover:bg-accent text-foreground border border-border"
            >
              Rotate +90°
            </button>
            <button
              type="button"
              onclick={() => editor.flipHorizontal()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipH
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted border-border text-foreground hover:bg-accent'}"
            >
              Flip Horizontal
            </button>
            <button
              type="button"
              onclick={() => editor.flipVertical()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipV
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-muted border-border text-foreground hover:bg-accent'}"
            >
              Flip Vertical
            </button>
          </div>
        </div>
      {/if}

      <!-- TAB 2: ADJUSTMENTS -->
      {#if activeTab === 'adjust'}
        <div class="flex flex-col gap-3 text-xs">
          <div class="flex items-center justify-between">
            <span class={imageSectionTitleClass}>
              Color Adjustments
            </span>
            <button
              type="button"
              onclick={() => editor.resetAdjustments()}
              class="text-[10px] text-destructive hover:underline"
            >
              Reset Sliders
            </button>
          </div>

          <Histogram histogram={editor.histogram} />

          {#each IMAGE_ADJUSTMENT_CONTROLS as spec (spec.id)}
            <ControlSlider
              {spec}
              value={readAdjustmentControls(editor.state.adjustments)[spec.id]}
              disabled={spec.requiresProcess !== undefined && legacyProcess}
              onchange={(v) => editor.setAdjustments({ [spec.id]: v })}
            />
            {#if spec.id === 'tint' && legacyProcess}
              <div
                class="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-600"
                data-testid="image-editor-process-notice"
              >
                <span>Legacy rendering (process 1). Tint needs the current process.</span>
                <button
                  type="button"
                  onclick={() => editor.upgradeProcess()}
                  class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 hover:bg-amber-500/30"
                >
                  Update
                </button>
              </div>
            {/if}
          {/each}

          <div class={imageSectionClass}>
            <AdjustmentLayersPanel
              controller={editor.controller}
              layers={editor.state.adjustments.layers}
              histogram={editor.histogram}
            />
          </div>
        </div>
      {/if}

      <!-- TAB 3: ANNOTATIONS -->
      {#if activeTab === 'layers'}
        <div class="flex flex-col gap-3 text-xs">
          <span class={imageSectionTitleClass}>Layers</span>
          <button
            type="button"
            title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
            class={imageSmallButtonClass}
            disabled={transformActive}
            onclick={() => transformTool.begin()}>Free Transform</button>
          <LayersPanel controller={editor.controller} />
          {#if effectsShown}<ImageProviderEffectsPanel controller={editor.controller} class={imageSectionClass} />{/if}
          <span class={imageSectionTitleClass}>Colour</span>
          <ColorProfilePanel controller={editor.controller} />
        </div>
      {/if}

      {#if activeTab === 'paint'}
        <div class="flex flex-col gap-3 text-xs">
          <span class={imageSectionTitleClass}>Paint</span>
          <BrushOptionsBar controller={editor.controller} />
          <button
            type="button"
            title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
            class={imageSmallButtonClass}
            disabled={transformActive}
            onclick={() => transformTool.begin()}>Free Transform</button>
          {#if paintError}
            <p role="alert" class="text-destructive" data-testid="paint-error">{paintError}</p>
          {/if}
          <div class={imageSectionClass}>
            <LayersPanel controller={editor.controller} />
          </div>
        </div>
      {/if}

      {#if activeTab === 'annotate'}
        <div class="flex flex-col gap-3 text-xs">
          <span class={imageSectionTitleClass}>Shape & Type Layers</span>
          <div class="grid grid-cols-2 gap-1.5">
            {#each ['shape', 'type'] as const as t (t)}
              <button
                type="button"
                aria-pressed={editor.state.activeTool === t}
                onclick={() => editor.setTool(t)}
                class="py-1.5 px-2 rounded-lg font-medium border transition-colors {editor.state.activeTool === t
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-muted border-border text-foreground hover:bg-accent'}">{t === 'shape' ? 'Shape' : 'Type'}</button>
            {/each}
          </div>
          {#if editor.state.activeTool === 'shape'}
            <ShapeOptionsBar controller={editor.controller} options={shapeOptions} onchange={(o) => (shapeOptions = o)} />
          {/if}
          {#if editor.state.activeTool === 'type'}
            <TypeOptionsBar controller={editor.controller} options={typeOptions} onchange={(o) => (typeOptions = o)} session={typeSession} />
            {#if typeSession}
              <button type="button" onclick={finishTyping} class="self-start rounded bg-muted px-2 py-1 text-[11px] text-foreground hover:bg-accent">Done editing text</button>
            {/if}
          {/if}
          {#if shapeTypeError}
            <p role="alert" class="text-destructive" data-testid="shape-type-error">{shapeTypeError}</p>
          {/if}
          <div class={imageDividerClass}></div>

          <span class={imageSectionTitleClass}>
            Draw & Annotate
          </span>

          <!-- Tool Picker -->
          <div class="grid grid-cols-3 gap-1.5">
            {#each (['pen', 'rect', 'circle', 'arrow', 'line'] as ImageEditorTool[]) as t}
              <button
                type="button"
                onclick={() => editor.setTool(t)}
                class="py-1.5 px-2 rounded-lg font-medium capitalize border transition-colors {editor.state.activeTool === t
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-muted border-border text-foreground hover:bg-accent'}"
              >
                {t}
              </button>
            {/each}
          </div>

          <!-- Color & Size -->
          <div class="flex items-center gap-2 mt-2">
            <span class="text-muted-foreground">Color:</span>
            <ImageColor label="Annotation colour" value={activeColor} oninput={(c) => (activeColor = c)} />
            <div class="flex-1 ml-2">
              <div class="flex justify-between text-muted-foreground mb-0.5">
                <span>Width:</span>
                <span class="font-mono">{strokeWidth}px</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                bind:value={strokeWidth}
                class={imageRangeClass}
              />
            </div>
          </div>

          <div class={imageDividerClass}></div>

          <!-- Text Tool -->
          <span class={imageSectionTitleClass}>Add Text</span>
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Type watermark or label..."
              bind:value={textInput}
              onkeydown={(e) => e.key === 'Enter' && handleAddText()}
              class="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
            />
            <button
              type="button"
              onclick={handleAddText}
              class="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow"
            >
              Add
            </button>
          </div>
          <div class="flex items-center justify-between text-muted-foreground">
            <span>Font Size:</span>
            <span class="font-mono">{fontSize}px</span>
          </div>
          <input
            type="range"
            min="12"
            max="72"
            bind:value={fontSize}
            class={imageRangeClass}
          />

          <!-- Layers & Selected Annotation -->
          <div class={imageDividerClass}></div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Layers ({editor.state.annotations.length})</span>
            {#if editor.state.selectedAnnotationId}
              <button
                type="button"
                onclick={() => editor.removeAnnotation(editor.state.selectedAnnotationId!)}
                class="text-destructive hover:underline text-[11px]"
              >
                Delete Selected
              </button>
            {/if}
            {#if editor.state.annotations.length > 0}
              <button
                type="button"
                onclick={() => editor.clearAnnotations()}
                class="text-muted-foreground hover:text-foreground text-[11px]"
              >
                Clear All
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- TAB 4: GLEAMFORGE DEPTH MASKING -->
      {#if activeTab === 'depth'}
        <div class="flex flex-col gap-3 text-xs">
          <div class="flex items-center justify-between">
            <span class={imageSectionTitleClass}>
              Depth Masking
            </span>
            <button
              type="button"
              onclick={() => editor.resetDepthMask()}
              class="text-[10px] text-destructive hover:underline"
            >
              Reset Mask
            </button>
          </div>

          <label class="flex items-center gap-2 cursor-pointer text-foreground">
            <input
              type="checkbox"
              checked={editor.state.depthMask.enabled}
              onchange={(e) => editor.setDepthMask({ enabled: (e.target as HTMLInputElement).checked })}
              class="rounded accent-primary"
            />
            <span>Enable Depth / Alpha Mask</span>
          </label>

          {#if editor.state.depthMask.enabled}
            <div>
              <span class="text-muted-foreground block mb-1">Mask Image URL:</span>
              <input
                type="text"
                placeholder="https://.../depthmap.png"
                value={editor.state.depthMask.maskSource || ''}
                oninput={(e) => editor.setDepthMask({ maskSource: (e.target as HTMLInputElement).value || null })}
                class="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'threshold' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'threshold'
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-muted border-border text-foreground'}"
              >
                Threshold Mode
              </button>
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'brightness' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'brightness'
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-muted border-border text-foreground'}"
              >
                Brightness Mode
              </button>
            </div>

            <div>
              <div class="flex justify-between text-muted-foreground mb-1">
                <span>Depth Start (Lower):</span>
                <span class="font-mono">{editor.state.depthMask.depthRange[0]}</span>
              </div>
              <input
                type="range"
                min="0"
                max="255"
                value={editor.state.depthMask.depthRange[0]}
                oninput={(e) =>
                  editor.setDepthMask({
                    depthRange: [Number((e.target as HTMLInputElement).value), editor.state.depthMask.depthRange[1]],
                  })}
                class={imageRangeClass}
              />
            </div>

            <div>
              <div class="flex justify-between text-muted-foreground mb-1">
                <span>Depth Stop (Upper):</span>
                <span class="font-mono">{editor.state.depthMask.depthRange[1]}</span>
              </div>
              <input
                type="range"
                min="0"
                max="255"
                value={editor.state.depthMask.depthRange[1]}
                oninput={(e) =>
                  editor.setDepthMask({
                    depthRange: [editor.state.depthMask.depthRange[0], Number((e.target as HTMLInputElement).value)],
                  })}
                class={imageRangeClass}
              />
            </div>

            <div>
              <div class="flex justify-between text-muted-foreground mb-1">
                <span>Softness:</span>
                <span class="font-mono">{editor.state.depthMask.softness}</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={editor.state.depthMask.softness}
                oninput={(e) => editor.setDepthMask({ softness: Number((e.target as HTMLInputElement).value) })}
                class={imageRangeClass}
              />
            </div>

            <label class="flex items-center gap-2 cursor-pointer text-foreground mt-1">
              <input
                type="checkbox"
                checked={editor.state.depthMask.invert}
                onchange={(e) => editor.setDepthMask({ invert: (e.target as HTMLInputElement).checked })}
                class="rounded accent-primary"
              />
              <span>Invert Mask</span>
            </label>
          {/if}
        </div>
      {/if}

      <!-- SELECT & MASK: selection tools, refine edge, layer masks -->
      {#if activeTab === 'select'}
        <div class="flex flex-col gap-4 text-xs">
          <SelectionOptionsBar
            controller={editor.controller}
            options={selectionOptions}
            onOptionsChange={(next) => (selectionOptions = next)}
            selection={editor.state.selection ?? null}
            quickMask={Boolean(editor.state.quickMask)}
            selectionDisplay={editor.state.selectionDisplay}
          />
          {#if selectionError}
            <p role="alert" class="text-destructive">{selectionError}</p>
          {/if}
          <div class="flex gap-1">
            <button
            type="button"
            title="Select › Transform Selection: the outline only"
            class={imageSmallButtonClass}
            disabled={transformActive}
            onclick={() => transformTool.begin({ content: 'selection-outline' })}>Transform Selection</button>
            <button
            type="button"
            title="Edit › Free Transform: the selected pixels of the active layer"
            class={imageSmallButtonClass}
            disabled={transformActive}
            onclick={() => transformTool.begin({ content: 'selection' })}>Free Transform Pixels</button>
          </div>
          <RefineEdgePanel
            controller={editor.controller}
            selection={editor.state.selection ?? null}
            layers={editor.state.adjustments.layers}
          />
        </div>
      {/if}

      <!-- TAB 5: AI TOOLS / INPAINTING & BACKGROUND REMOVAL -->
      {#if activeTab === 'ai'}
        <div class="flex flex-col gap-4 text-xs">
          <label class="flex items-center justify-between gap-2 text-foreground">
            <span>Results go to</span>
            <select
              aria-label="AI result target"
              bind:value={aiTarget}
              class={imageSelectClass}
            >
              <option value="auto">{editor.controller.isMultiLayer ? 'Auto (new layer)' : 'Auto (replace image)'}</option>
              <option value="new-layer">New layer / mask</option>
              <option value="replace">Replace image</option>
            </select>
          </label>
          <!-- Background Removal Section -->
          <div class="p-3 rounded-lg bg-muted/40 border border-border flex flex-col gap-2.5">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-foreground uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
                </svg>
                Background Removal
              </span>
              {#if isRemovingBg}
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/15 text-primary animate-pulse">
                  Removing...
                </span>
              {/if}
            </div>

            <p class="text-muted-foreground text-[11px] leading-relaxed">
              Isolate foreground subject with AI alpha transparency segmentation.
            </p>

            <button
              type="button"
              onclick={handleRemoveBackground}
              disabled={isRemovingBg || isInpainting}
              class="mt-1 px-3 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-medium shadow transition-colors flex items-center justify-center gap-2"
            >
              {#if isRemovingBg}
                <div class={imageSpinnerClass}></div>
                Removing Background...
              {:else}
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                Remove Background
              {/if}
            </button>
          </div>

          <!-- AI Inpainting / Generative Fill Section -->
          <div class="p-3 rounded-lg bg-muted/40 border border-border flex flex-col gap-2.5">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-foreground uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="m21.64 3.64-1.28-1.28a1.2 1.2 0 0 0-1.7 0l-9.72 9.72-1.94 4.86 4.86-1.94 9.72-9.72a1.2 1.2 0 0 0 .06-1.64z"/>
                  <path d="m14 7 3 3"/>
                </svg>
                Generative Inpainting
              </span>
              {#if isInpainting}
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/15 text-primary animate-pulse">
                  Inpainting...
                </span>
              {/if}
            </div>

            <p class="text-muted-foreground text-[11px] leading-relaxed">
              Replace, modify, or fill selected regions using prompt-guided generative inpainting.
            </p>

            <div class="flex flex-col gap-1">
              <label for="ai-inpaint-prompt" class="text-foreground text-[11px] font-medium">Prompt</label>
              <textarea
                id="ai-inpaint-prompt"
                bind:value={inpaintPrompt}
                placeholder="e.g. replace sunglasses with steampunk goggles, remove person in background..."
                rows="3"
                class="w-full bg-background border border-border rounded-lg p-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary resize-none"
              ></textarea>
            </div>

            <div class="flex flex-col gap-1">
              <span class="text-foreground text-[11px] font-medium">Target Mask Region</span>
              <div class="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onclick={() => inpaintMaskMode = 'annotations'}
                  class="px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors {inpaintMaskMode === 'annotations'
                    ? 'bg-primary/30 border-primary text-primary'
                    : 'bg-background border-border text-muted-foreground hover:text-foreground'}"
                >
                  Drawn Shapes ({editor.state.annotations.length})
                </button>
                <button
                  type="button"
                  onclick={() => inpaintMaskMode = 'crop'}
                  class="px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors {inpaintMaskMode === 'crop'
                    ? 'bg-primary/30 border-primary text-primary'
                    : 'bg-background border-border text-muted-foreground hover:text-foreground'}"
                >
                  Crop Box ({editor.state.crop ? 'Selected' : 'Full'})
                </button>
              </div>
            </div>

            <button
              type="button"
              onclick={handleInpaint}
              disabled={isInpainting || isRemovingBg || !inpaintPrompt.trim()}
              class="mt-1 px-3 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-medium shadow transition-colors flex items-center justify-center gap-2"
            >
              {#if isInpainting}
                <div class={imageSpinnerClass}></div>
                Generating Inpaint...
              {:else}
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                Apply Inpainting
              {/if}
            </button>
          </div>

          {#if aiError}
            <div class="p-2.5 rounded-lg bg-destructive/10 border border-destructive/40 text-destructive text-[11px]">
              {aiError}
            </div>
          {/if}

          {#if aiSuccess}
            <div class="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-[11px]">
              {aiSuccess}
            </div>
          {/if}
        </div>
      {/if}

    </div>
  </div>
</div>
