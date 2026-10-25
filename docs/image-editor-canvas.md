# Image editor canvas

`<ImageEditor>` is `<ImageEditorCanvas>` plus tabs and panels. Use the canvas on its own when your app brings its own chrome: a canvas node in a flow, a HUD over a board, a compact toolbar.

The canvas has everything that happens on the image:

- the render loop, sized by its container through a `ResizeObserver`;
- every pointer gesture: crop handles and new crops, the selection tools (`SelectionGesture`), painting (`PaintGesture`, with the paint shortcuts while in paint mode), shape and type layers (`ShapeDrawGesture`, `TypeToolGesture` and the hidden textarea for on-canvas typing), annotations, and Free Transform (Ctrl/Cmd+T) in every mode;
- the crop, selection, brush, text and Free Transform overlays;
- the agent's cursor and the agent playback surface.

It fills its box. Give it a size with `class` / `className` or by its parent; it does not assume a page layout, so it works inside a zoomed or scrolled container.

## React

```tsx
import { ImageEditorCanvas, useImageEditor } from '@pixerate/editor-react/image-editor';

const editor = useImageEditor({ image: src });
const [mode, setMode] = useState<ImageEditorCanvasMode>('paint');

<div style={{ width: 640, height: 400 }}>
  <ImageEditorCanvas editor={editor} mode={mode} onError={(source, message) => setError(message)} className="h-full w-full" />
</div>
```

## Svelte

```svelte
<script lang="ts">
  import { ImageEditorCanvas, createReactiveImageEditor, type ImageEditorCanvasMode } from '@pixerate/editor-svelte/image-editor';
  const editor = createReactiveImageEditor({ image: src });
  let mode = $state<ImageEditorCanvasMode>('paint');
  let typeSession = $state(null);
</script>

<ImageEditorCanvas {editor} {mode} bind:typeSession onerror={(source, message) => (error = message)} class="h-full w-full" />
```

## Props

React and Svelte take the same props; Svelte spells callbacks in lower case (`onerror`, `onplaybackreveal`) and binds `typeSession`.

| Prop | Type | Does |
| --- | --- | --- |
| `editor` | `UseImageEditorReturn` / `ReactiveImageEditor` | The editor to draw and edit |
| `mode` | `'crop' \| 'select' \| 'paint' \| 'annotate' \| 'none'` | What gestures do. `crop` also shows the crop overlay and the crop margin. Default `none` (view only; Free Transform still works) |
| `fit` | `'contain' \| 'margin'` | How the image fits the canvas |
| `selectionOptions`, `shapeOptions`, `typeOptions` | the tool option objects | Options of the selection, shape and type tools (defaults: `DEFAULT_*_TOOL_OPTIONS`) |
| `annotationColor`, `annotationWidth` | `string`, `number` | Colour and stroke width of new annotations (default `#ef4444`, 3) |
| `cropRatio` | `number \| null` | Aspect ratio crop handle drags keep (default free) |
| `onError` / `onerror` | `(source: 'paint' \| 'select' \| 'shape' \| 'type', message: string \| null) => void` | A gesture failed, or recovered (`null`) |
| `typeSession` | `TextEditSession \| null` | The text being edited. React: pass it with `onTypeSessionChange`; Svelte: `bind:typeSession`. Setting it from a session to `null` finishes editing. Editing also ends when the mode or tool changes |
| `transformTool` | `FreeTransformTool` | Your own Free Transform tool, to show `<FreeTransformOptionsBar>` or begin transforms from your UI. Default: the canvas makes one |
| `playback`, `playbackId`, `onPlaybackReveal` / `onplaybackreveal` | | Agent playback, as on `<ImageEditor>` (surface id default `image`) |
| `chromeRoot` | React `RefObject<HTMLElement>`, Svelte `() => HTMLElement` | Where the default playback lookups find tabs (`[data-image-tab]`), sliders (`[data-control-id]`) and layer rows (`[data-layer-id]`). Default: the canvas itself |
| `locate` | `(ref) => PlaybackRect \| null` | Your own lookup for a playback ref, in document pixels. Tried first |
| `locateElement` | `(ref) => Element \| null` | Your own element for a ref, anywhere on the page; its box is mapped into document pixels. Tried second |
| `open` | `(ref) => void \| Promise<void>` | Show a panel for an `open` step. Default: click its `[data-image-tab]` under `chromeRoot` unless it has `aria-selected="true"` |
| `className` / `class`, `style` | | On the canvas' root element |

## Theme

`ImageEditor`, the canvas and every image panel use shadcn theme tokens (`bg-background`, `bg-muted`, `border-border`, `text-muted-foreground`, `bg-primary`, `text-destructive`, …) through the class constants in `image-editor/styles.ts`, so they follow the host's light or dark theme. Every panel takes `className` (Svelte `class`) for your own additions.

## Agent playback with your own chrome

Playback coordinates are document pixels. The image tools' plans name panels (`{ kind: 'panel', id: 'paint' }`), controls (`{ kind: 'control', id: 'contrast' }`) and layers. Layers are found on the canvas; answer the rest from your chrome:

```tsx
<ImageEditorCanvas
  editor={editor}
  playback={playback}
  playbackId={`${node.id}:surface`}
  locateElement={(ref) => hud.current?.querySelector(`[data-hud="${ref.kind}:${ref.id}"]`) ?? null}
  open={(ref) => setPanel(ref.id)}
/>
```

Playback looks for a surface under the provider's `playbackSurface`, then its id, then its namespace, so give the node's image tool providers that surface id (see [agent playback](./agent-playback.md)). The cursor layer does not clip to the canvas, so the cursor can travel to chrome around it; keep that chrome inside an ancestor that does not clip it.
