<script lang="ts">
  import type {
    Annotation,
    CropBox,
    CropHandle,
    ExportOptions,
    ImageEditorTool,
    ImagePoint,
  } from '@pixerate/editor';
  import {
    canvasToImagePoint,
    hitTestCrop,
    getCropCursor,
    calculateCropDrag,
    hitTestAnnotation,
  } from '@pixerate/editor';
  import { createReactiveImageEditor, type ReactiveImageEditor } from './imageEditorState.svelte';

  interface Props {
    editor?: ReactiveImageEditor;
    src?: string;
    class?: string;
    style?: string;
    onSave?: (dataUrl: string) => void;
    exportOptions?: ExportOptions;
  }

  let {
    editor: propEditor,
    src = '',
    class: className = '',
    style = '',
    onSave,
    exportOptions
  }: Props = $props();

  const internalEditor = createReactiveImageEditor();
  const editor = $derived(propEditor || internalEditor);

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let activeTab = $state<'crop' | 'adjust' | 'annotate' | 'depth'>('crop');
  let activeCropRatio = $state<number | null>(null);

  // Annotation drafting state
  let activeColor = $state('#ef4444');
  let strokeWidth = $state(3);
  let fontSize = $state(24);
  let textInput = $state('');

  // Live draft and drag references
  let draftAnnotation = $state<Annotation | null>(null);
  let draftCrop = $state<CropBox | null>(null);
  let cropDragInfo: {
    handle: CropHandle | 'new';
    startCanvasPt: ImagePoint;
    startImgPt: ImagePoint;
    startCrop: CropBox;
  } | null = null;
  let annotationDragInfo: {
    annId: string;
    startImgPt: ImagePoint;
    initialAnn: Annotation;
  } | null = null;
  let isDrawing = false;
  let currentPath: ImagePoint[] = [];
  let dragStartPoint: ImagePoint | null = null;

  // Update image when src changes
  $effect(() => {
    if (src && src !== editor.state.sourceUrl) {
      editor.loadImage(src);
    }
  });

  async function renderCanvas(overrideAnnotation?: Annotation | null, overrideCrop?: CropBox | null) {
    if (!canvasEl || !containerEl) return;
    const vpWidth = containerEl.clientWidth || 800;
    const vpHeight = containerEl.clientHeight || 500;

    await editor.controller.render(canvasEl, {
      viewportWidth: vpWidth,
      viewportHeight: vpHeight,
      showCropOverlay: activeTab === 'crop',
      showSelectionOverlay: true,
      interactive: true,
      draftAnnotation: overrideAnnotation !== undefined ? overrideAnnotation : draftAnnotation,
      draftCrop: overrideCrop !== undefined ? overrideCrop : draftCrop,
    });
  }

  $effect(() => {
    // Re-render when editor state or activeTab changes
    void editor.state;
    void activeTab;

    const raf = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const caf = typeof cancelAnimationFrame !== 'undefined'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    const animId = raf(() => {
      renderCanvas();
    });
    return () => caf(animId);
  });

  $effect(() => {
    if (activeTab === 'crop' && editor.state.activeTool !== 'crop') {
      editor.setTool('crop');
    }
  });

  $effect(() => {
    if (!containerEl) return;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        renderCanvas();
      });
      observer.observe(containerEl);
      return () => observer.disconnect();
    } else {
      const handleResize = () => renderCanvas();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
  });

  function getCanvasEventPoint(e: MouseEvent): ImagePoint {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvasEl.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvasEl.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function handleMouseDown(e: MouseEvent) {
    if (!canvasEl) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      const activeCrop = draftCrop || editor.state.crop || {
        x: 0,
        y: 0,
        width: editor.state.imageDimensions.width,
        height: editor.state.imageDimensions.height,
      };
      const handle = hitTestCrop(canvasPt, editor.state, canvasEl.width, canvasEl.height, 14, activeCrop);
      const startImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, true);

      if (handle) {
        cropDragInfo = {
          handle,
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: activeCrop,
        };
      } else {
        // Clicked outside crop box: start new crop selection
        cropDragInfo = {
          handle: 'new',
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: { x: startImgPt.x, y: startImgPt.y, width: 0, height: 0 },
        };
      }
      return;
    }

    if (activeTab === 'annotate') {
      const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
      dragStartPoint = imgPt;

      if (editor.state.activeTool === 'select') {
        for (let i = editor.state.annotations.length - 1; i >= 0; i--) {
          const ann = editor.state.annotations[i];
          if (hitTestAnnotation(imgPt, ann)) {
            editor.selectAnnotation(ann.id);
            annotationDragInfo = {
              annId: ann.id,
              startImgPt: imgPt,
              initialAnn: { ...ann },
            };
            return;
          }
        }
        editor.selectAnnotation(null);
        return;
      }

      if (editor.state.activeTool === 'pen') {
        isDrawing = true;
        currentPath = [imgPt];
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [imgPt],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (!canvasEl) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      if (cropDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, true);
        let newCrop: CropBox;

        if (cropDragInfo.handle === 'new') {
          const minX = Math.max(0, Math.min(cropDragInfo.startImgPt.x, currentImgPt.x));
          const minY = Math.max(0, Math.min(cropDragInfo.startImgPt.y, currentImgPt.y));
          const maxX = Math.min(editor.state.imageDimensions.width, Math.max(cropDragInfo.startImgPt.x, currentImgPt.x));
          const maxY = Math.min(editor.state.imageDimensions.height, Math.max(cropDragInfo.startImgPt.y, currentImgPt.y));
          newCrop = {
            x: Math.round(minX),
            y: Math.round(minY),
            width: Math.round(Math.max(20, maxX - minX)),
            height: Math.round(Math.max(20, maxY - minY)),
          };
        } else {
          newCrop = calculateCropDrag(
            cropDragInfo.startCrop,
            cropDragInfo.handle,
            cropDragInfo.startImgPt,
            currentImgPt,
            editor.state.imageDimensions.width,
            editor.state.imageDimensions.height,
            activeCropRatio
          );
        }

        draftCrop = newCrop;
        renderCanvas(null, newCrop);
      } else {
        const activeCrop = draftCrop || editor.state.crop || {
          x: 0,
          y: 0,
          width: editor.state.imageDimensions.width,
          height: editor.state.imageDimensions.height,
        };
        const handle = hitTestCrop(canvasPt, editor.state, canvasEl.width, canvasEl.height, 14, activeCrop);
        canvasEl.style.cursor = getCropCursor(handle);
      }
      return;
    }

    if (activeTab === 'annotate') {
      if (annotationDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
        const dx = currentImgPt.x - annotationDragInfo.startImgPt.x;
        const dy = currentImgPt.y - annotationDragInfo.startImgPt.y;
        editor.updateAnnotation(annotationDragInfo.annId, {
          x: Math.round(annotationDragInfo.initialAnn.x + dx),
          y: Math.round(annotationDragInfo.initialAnn.y + dy),
        });
        return;
      }

      if (!dragStartPoint) {
        if (editor.state.activeTool === 'select') {
          const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
          let hovered = false;
          for (let i = editor.state.annotations.length - 1; i >= 0; i--) {
            if (hitTestAnnotation(imgPt, editor.state.annotations[i])) {
              hovered = true;
              break;
            }
          }
          canvasEl.style.cursor = hovered ? 'move' : 'default';
        } else {
          canvasEl.style.cursor = 'crosshair';
        }
        return;
      }

      const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);

      if (editor.state.activeTool === 'pen' && isDrawing) {
        currentPath.push(currentImgPt);
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [...currentPath],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'rect') {
        const w = currentImgPt.x - dragStartPoint.x;
        const h = currentImgPt.y - dragStartPoint.y;
        const draft: Annotation = {
          id: 'draft',
          type: 'rect',
          x: Math.min(dragStartPoint.x, currentImgPt.x),
          y: Math.min(dragStartPoint.y, currentImgPt.y),
          width: Math.abs(w),
          height: Math.abs(h),
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'circle') {
        const rx = Math.abs(currentImgPt.x - dragStartPoint.x) / 2;
        const ry = Math.abs(currentImgPt.y - dragStartPoint.y) / 2;
        const draft: Annotation = {
          id: 'draft',
          type: 'circle',
          x: Math.min(dragStartPoint.x, currentImgPt.x) + rx,
          y: Math.min(dragStartPoint.y, currentImgPt.y) + ry,
          radiusX: rx,
          radiusY: ry,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'arrow') {
        const draft: Annotation = {
          id: 'draft',
          type: 'arrow',
          x: dragStartPoint.x,
          y: dragStartPoint.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'line') {
        const draft: Annotation = {
          id: 'draft',
          type: 'line',
          x: dragStartPoint.x,
          y: dragStartPoint.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (!canvasEl) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      if (cropDragInfo) {
        if (draftCrop && draftCrop.width >= 20 && draftCrop.height >= 20) {
          editor.setCrop(draftCrop, true);
        }
        cropDragInfo = null;
        draftCrop = null;
        renderCanvas();
      }
      return;
    }

    if (activeTab === 'annotate') {
      if (annotationDragInfo) {
        annotationDragInfo = null;
        return;
      }

      if (dragStartPoint) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);

        if (editor.state.activeTool === 'pen' && isDrawing) {
          if (currentPath.length > 1) {
            editor.addAnnotation({
              type: 'pen',
              x: 0,
              y: 0,
              points: [...currentPath],
              strokeColor: activeColor,
              strokeWidth,
            });
          }
          isDrawing = false;
          currentPath = [];
        } else if (editor.state.activeTool === 'rect') {
          const w = Math.abs(currentImgPt.x - dragStartPoint.x);
          const h = Math.abs(currentImgPt.y - dragStartPoint.y);
          if (w > 4 && h > 4) {
            editor.addAnnotation({
              type: 'rect',
              x: Math.min(dragStartPoint.x, currentImgPt.x),
              y: Math.min(dragStartPoint.y, currentImgPt.y),
              width: w,
              height: h,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'circle') {
          const rx = Math.abs(currentImgPt.x - dragStartPoint.x) / 2;
          const ry = Math.abs(currentImgPt.y - dragStartPoint.y) / 2;
          if (rx > 4 && ry > 4) {
            editor.addAnnotation({
              type: 'circle',
              x: Math.min(dragStartPoint.x, currentImgPt.x) + rx,
              y: Math.min(dragStartPoint.y, currentImgPt.y) + ry,
              radiusX: rx,
              radiusY: ry,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'arrow') {
          if (Math.hypot(currentImgPt.x - dragStartPoint.x, currentImgPt.y - dragStartPoint.y) > 4) {
            editor.addAnnotation({
              type: 'arrow',
              x: dragStartPoint.x,
              y: dragStartPoint.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'line') {
          if (Math.hypot(currentImgPt.x - dragStartPoint.x, currentImgPt.y - dragStartPoint.y) > 4) {
            editor.addAnnotation({
              type: 'line',
              x: dragStartPoint.x,
              y: dragStartPoint.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        }

        draftAnnotation = null;
        dragStartPoint = null;
        renderCanvas();
      }
    }
  }

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
  class="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-100 {className}"
  {style}
>
  <!-- Top Action Header -->
  <div class="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 gap-3">
    <!-- Navigation Tabs -->
    <div class="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
      <button
        type="button"
        onclick={() => {
          activeTab = 'crop';
          editor.setTool('crop');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'crop'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Transform & Crop
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'adjust';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'adjust'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Adjustments
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'annotate';
          editor.setTool('pen');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'annotate'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Annotations
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'depth';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'depth'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Depth Mask
      </button>
    </div>

    <!-- Global Action Tools (Undo/Redo, Zoom, Compare, Save) -->
    <div class="flex items-center gap-2 text-xs">
      <button
        type="button"
        disabled={!editor.canUndo}
        onclick={() => editor.undo()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
        title="Undo"
      >
        ↩
      </button>
      <button
        type="button"
        disabled={!editor.canRedo}
        onclick={() => editor.redo()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
        title="Redo"
      >
        ↪
      </button>
      <button
        type="button"
        onclick={() => editor.reset()}
        class="px-2 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
      >
        Reset
      </button>

      <div class="h-4 w-px bg-slate-800 mx-1"></div>

      <!-- Zoom -->
      <button
        type="button"
        onclick={() => editor.zoomOut()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
        title="Zoom Out"
      >
        -
      </button>
      <span class="font-mono text-slate-400 w-10 text-center">{Math.round(editor.state.zoom * 100)}%</span>
      <button
        type="button"
        onclick={() => editor.zoomIn()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
        title="Zoom In"
      >
        +
      </button>

      <div class="h-4 w-px bg-slate-800 mx-1"></div>

      <!-- Live Compare -->
      <button
        type="button"
        onmousedown={() => editor.setComparing(true)}
        onmouseup={() => editor.setComparing(false)}
        onmouseleave={() => editor.setComparing(false)}
        class="px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-amber-400 hover:bg-slate-800 select-none active:bg-amber-950/40"
      >
        Hold Compare
      </button>

      <!-- Save / Export -->
      <button
        type="button"
        onclick={handleExport}
        class="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-md shadow-emerald-900/30 transition-colors"
      >
        Export Image
      </button>
    </div>
  </div>

  <!-- Main Viewport + Sidebar Layout -->
  <div class="flex flex-col md:flex-row flex-1 min-h-[520px] md:h-[560px]">
    <!-- Canvas Area -->
    <div
      bind:this={containerEl}
      class="relative flex-1 h-[360px] md:h-full min-h-[320px] bg-slate-950 overflow-hidden select-none"
    >
      <canvas
        bind:this={canvasEl}
        onmousedown={handleMouseDown}
        onmousemove={handleMouseMove}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseUp}
        class="absolute inset-0 w-full h-full block"
      ></canvas>
    </div>

    <!-- Tab Controls Sidebar -->
    <div class="w-full md:w-80 bg-slate-900/90 border-t md:border-t-0 md:border-l border-slate-800 p-4 overflow-y-auto h-auto md:h-full md:max-h-[560px]">
      <!-- TAB 1: CROP & TRANSFORM -->
      {#if activeTab === 'crop'}
        <div class="flex flex-col gap-4 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
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
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
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
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
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
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
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
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
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
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              3:2 Photo
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = null;
                editor.resetCrop();
              }}
              class="px-2.5 py-2 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 font-medium"
            >
              Clear Crop
            </button>
          </div>

          <div class="h-px bg-slate-800 my-1"></div>

          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
            Orientation & Flips
          </span>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => editor.rotate(-90)}
              class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              Rotate -90°
            </button>
            <button
              type="button"
              onclick={() => editor.rotate(90)}
              class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              Rotate +90°
            </button>
            <button
              type="button"
              onclick={() => editor.flipHorizontal()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipH
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'}"
            >
              Flip Horizontal
            </button>
            <button
              type="button"
              onclick={() => editor.flipVertical()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipV
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'}"
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
            <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
              Color Adjustments
            </span>
            <button
              type="button"
              onclick={() => editor.resetAdjustments()}
              class="text-[10px] text-rose-400 hover:underline"
            >
              Reset Sliders
            </button>
          </div>

          <!-- Brightness -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Brightness</span>
              <span class="font-mono">{editor.state.adjustments.brightness}</span>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              value={editor.state.adjustments.brightness}
              oninput={(e) => editor.setAdjustments({ brightness: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Contrast -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Contrast</span>
              <span class="font-mono">{editor.state.adjustments.contrast}</span>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              value={editor.state.adjustments.contrast}
              oninput={(e) => editor.setAdjustments({ contrast: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Saturation -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Saturation</span>
              <span class="font-mono">{editor.state.adjustments.saturation}</span>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              value={editor.state.adjustments.saturation}
              oninput={(e) => editor.setAdjustments({ saturation: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Exposure -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Exposure</span>
              <span class="font-mono">{editor.state.adjustments.exposure}</span>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              value={editor.state.adjustments.exposure}
              oninput={(e) => editor.setAdjustments({ exposure: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Temperature / Warmth -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Warmth / Temperature</span>
              <span class="font-mono">{editor.state.adjustments.temperature}</span>
            </div>
            <input
              type="range"
              min="-100"
              max="100"
              value={editor.state.adjustments.temperature}
              oninput={(e) => editor.setAdjustments({ temperature: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Blur -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Blur</span>
              <span class="font-mono">{editor.state.adjustments.blur}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="30"
              value={editor.state.adjustments.blur}
              oninput={(e) => editor.setAdjustments({ blur: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>

          <!-- Opacity -->
          <div>
            <div class="flex justify-between text-slate-400 mb-1">
              <span>Opacity</span>
              <span class="font-mono">{Math.round(editor.state.adjustments.opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={editor.state.adjustments.opacity}
              oninput={(e) => editor.setAdjustments({ opacity: Number((e.target as HTMLInputElement).value) })}
              class="w-full accent-indigo-500"
            />
          </div>
        </div>
      {/if}

      <!-- TAB 3: ANNOTATIONS -->
      {#if activeTab === 'annotate'}
        <div class="flex flex-col gap-3 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
            Draw & Annotate
          </span>

          <!-- Tool Picker -->
          <div class="grid grid-cols-3 gap-1.5">
            {#each (['pen', 'rect', 'circle', 'arrow', 'line'] as ImageEditorTool[]) as t}
              <button
                type="button"
                onclick={() => editor.setTool(t)}
                class="py-1.5 px-2 rounded-lg font-medium capitalize border transition-colors {editor.state.activeTool === t
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}"
              >
                {t}
              </button>
            {/each}
          </div>

          <!-- Color & Size -->
          <div class="flex items-center gap-2 mt-2">
            <span class="text-slate-400">Color:</span>
            <input
              type="color"
              bind:value={activeColor}
              class="w-8 h-8 rounded border border-slate-700 cursor-pointer bg-transparent"
            />
            <div class="flex-1 ml-2">
              <div class="flex justify-between text-slate-400 mb-0.5">
                <span>Width:</span>
                <span class="font-mono">{strokeWidth}px</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                bind:value={strokeWidth}
                class="w-full accent-indigo-500"
              />
            </div>
          </div>

          <div class="h-px bg-slate-800 my-1"></div>

          <!-- Text Tool -->
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Add Text</span>
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Type watermark or label..."
              bind:value={textInput}
              onkeydown={(e) => e.key === 'Enter' && handleAddText()}
              class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onclick={handleAddText}
              class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow"
            >
              Add
            </button>
          </div>
          <div class="flex items-center justify-between text-slate-400">
            <span>Font Size:</span>
            <span class="font-mono">{fontSize}px</span>
          </div>
          <input
            type="range"
            min="12"
            max="72"
            bind:value={fontSize}
            class="w-full accent-indigo-500"
          />

          <!-- Layers & Selected Annotation -->
          <div class="h-px bg-slate-800 my-1"></div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Layers ({editor.state.annotations.length})</span>
            {#if editor.state.selectedAnnotationId}
              <button
                type="button"
                onclick={() => editor.removeAnnotation(editor.state.selectedAnnotationId!)}
                class="text-rose-400 hover:underline text-[11px]"
              >
                Delete Selected
              </button>
            {/if}
            {#if editor.state.annotations.length > 0}
              <button
                type="button"
                onclick={() => editor.clearAnnotations()}
                class="text-slate-400 hover:text-slate-200 text-[11px]"
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
            <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
              Depth Masking
            </span>
            <button
              type="button"
              onclick={() => editor.resetDepthMask()}
              class="text-[10px] text-rose-400 hover:underline"
            >
              Reset Mask
            </button>
          </div>

          <label class="flex items-center gap-2 cursor-pointer text-slate-300">
            <input
              type="checkbox"
              checked={editor.state.depthMask.enabled}
              onchange={(e) => editor.setDepthMask({ enabled: (e.target as HTMLInputElement).checked })}
              class="rounded accent-indigo-500"
            />
            <span>Enable Depth / Alpha Mask</span>
          </label>

          {#if editor.state.depthMask.enabled}
            <div>
              <span class="text-slate-400 block mb-1">Mask Image URL:</span>
              <input
                type="text"
                placeholder="https://.../depthmap.png"
                value={editor.state.depthMask.maskSource || ''}
                oninput={(e) => editor.setDepthMask({ maskSource: (e.target as HTMLInputElement).value || null })}
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500"
              />
            </div>

            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'threshold' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'threshold'
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300'}"
              >
                Threshold Mode
              </button>
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'brightness' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'brightness'
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300'}"
              >
                Brightness Mode
              </button>
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
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
                class="w-full accent-indigo-500"
              />
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
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
                class="w-full accent-indigo-500"
              />
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
                <span>Softness:</span>
                <span class="font-mono">{editor.state.depthMask.softness}</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={editor.state.depthMask.softness}
                oninput={(e) => editor.setDepthMask({ softness: Number((e.target as HTMLInputElement).value) })}
                class="w-full accent-indigo-500"
              />
            </div>

            <label class="flex items-center gap-2 cursor-pointer text-slate-300 mt-1">
              <input
                type="checkbox"
                checked={editor.state.depthMask.invert}
                onchange={(e) => editor.setDepthMask({ invert: (e.target as HTMLInputElement).checked })}
                class="rounded accent-indigo-500"
              />
              <span>Invert Mask</span>
            </label>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
