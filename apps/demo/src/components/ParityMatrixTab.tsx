import React from "react";
// Keep in sync with the "Feature Parity Guarantee" table in the root README.
import { Check, ShieldCheck, Box } from "lucide-react";

/** `true` = supported; a string names how (e.g. "Headless", a hook or component). */
type ParityValue = boolean | string;

interface ParityRow {
  feature: string;
  core: ParityValue;
  react: ParityValue;
  svelte: ParityValue;
  note: string;
}

const row = (
  feature: string,
  core: ParityValue,
  react: ParityValue,
  svelte: ParityValue,
  note: string
): ParityRow => ({ feature, core, react, svelte, note });

// Rows added with the productivity-app features (see the root README matrix).
const PRODUCTIVITY_FEATURES: ParityRow[] = [
  row("Variable Defaults & Descriptions ({name|default|description})", true, true, true, "Defaults fill blank values; descriptions label form fields"),
  row("Conditional Sections ({?name}…{/name}, {!name}…{/name}) with Diagnostics", true, true, true, "Unbalanced tags stay literal and are reported"),
  row("Resolution with Values (values option, resolvePrompt)", true, true, true, "Templates, variables and sections resolved in one pass"),
  row("Variable Fill-In Form", "Headless", "<VariableForm />", "<VariableForm />", "getVariableFormFields: one field per variable, checkboxes for conditions"),
  row("Value Preview in <TemplateRenderer values />", "evaluatePromptTokens", true, true, "Variables show their value or default"),
  row("Comparison Conditions ({?amount>100}…{/amount})", true, true, true, "= <> < > <= >=, numeric when both sides are numbers"),
  row("Mail Merge (parseDataSource, matchFields, mergeRecords)", "Headless", "<MergePreview /> & useMergePreview", "<MergePreview /> & createMergePreview", "CSV/TSV/JSON records, fuzzy field mapping, skipIf, merge all"),
  row("Heading Outline & Navigation Panel (outline)", "createOutlineStore", "<OutlinePanel /> & useOutline", "<OutlinePanel /> & createOutline", "Stable heading ids; active section highlighted"),
  row("Table of Contents Block (tableOfContents, [[toc]])", true, true, true, "Live entries linked to headings"),
  row("Footnotes (footnotes, markdown [^n])", true, true, true, "Automatic numbering and footnotes list"),
  row("Bookmarks & Cross-References (bookmarks, crossReferences)", true, true, true, "References follow renames and flag broken targets"),
  row("Autocorrect Rules & Exceptions (autocorrect)", true, true, true, "Smart quotes, symbols, fractions, sentence capitals"),
  row("Document-Structure Slash/Toolbar Items", true, "Via core", "Via core", "getDocumentStructureCommandItems"),
  row("Canvas Align / Distribute / Make Same Size", true, "useCanvasArrange", "createCanvasArrange", "Locked nodes act as anchors"),
  row("Canvas Lock / Unlock & Layer Order (Front / Back)", true, "useCanvasArrange", "createCanvasArrange", "zIndex assigned per sibling group"),
  row("Canvas Smart Guides & Snap-to-Shape (edges, centres, spacing)", true, "Hook & <CanvasGuidesLayer>", "Rune & <CanvasGuidesLayer>", "Snap targets indexed once per drag"),
  row("Canvas Resize & Grid Snapping", "snapResize & snapToGrid", "useCanvasArrange (snapResizeChanges)", "createCanvasArrange (resizerHandlers)", "Opposite edge fixed; collapsing snaps rejected"),
  row("Canvas Distance Measuring (Alt-hover)", "measureBetween & measureSelection", "useCanvasMeasure & <CanvasGuidesLayer>", "createCanvasMeasure & <CanvasGuidesLayer>", "Inside, overlapping and separated boxes"),
  row("Canvas Auto Layout & Constraints (stack, wrap, grid)", "layoutFrame & layoutAll", "useCanvasAutoLayout", "createCanvasAutoLayout", "Hug / fill / fixed, min / max, fr tracks"),
  row("Canvas Auto Layout Drag Reorder", "getAutoLayoutInsertTarget", "useCanvasAutoLayout", "createCanvasAutoLayout", "One undo step; drop marker via guides"),
  row("Design Tokens (collections, modes, aliases)", "TokenStore & resolveToken", "useTokens & <TokensPanel>", "createTokens & <TokensPanel>", "W3C JSON and CSS variables per mode"),
  row("Canvas Token Bindings & Per-Frame Modes", "bindCanvasToken & setCanvasTokenMode", "useCanvasTokens & <TokenBindingPicker>", "createCanvasTokens & <TokenBindingPicker>", "Modes inherit; delete keeps last value"),
  row("Canvas Components & Instances (variants, properties, overrides)", "syncCanvasComponents & createCanvasComponentsController", "useCanvasComponents, <CanvasComponentsPanel>, <CanvasInstanceInspector>", "createCanvasComponents, <CanvasComponentsPanel>, <CanvasInstanceInspector>", "Overrides survive main edits; undoable; commands & agent tools"),
  row("Canvas Variant Editing (add / remove / rename variants)", "addCanvasVariant & removeCanvasVariant", "<CanvasComponentsPanel components>", "<CanvasComponentsPanel components>", "Duplicates refused; instances re-pointed; undoable"),
  row("Canvas Bézier Curve Fitting (boolean results, freehand)", "fitCubics & fitPathData", "Via core", "Via core", "Corners kept; error within tolerance"),
  row("Canvas Scenes (saved viewports, next / previous)", "CanvasScenesStore", "useCanvasScenes", "createCanvasScenes", "JSON persistence, reorder and rename"),
  row("Canvas Connector Snapping to Shape Sides", true, "Via core", "Via core", "findConnectorSnap, nearestHandlePositions"),
  row("Canvas Arrange Keyboard Shortcuts", "matchArrangeShortcut", "useCanvasArrangeShortcuts", "createCanvasArrangeShortcuts", "Matched by KeyboardEvent.code"),
  row("Mermaid Diagrams on the Canvas (flowchart, state, class, ER)", "parseMermaid, DiagramController & mermaidToCanvas (/diagram, /canvas)", "useMermaidDiagram & <MermaidDiagramNode>", "createMermaidDiagram & <MermaidDiagramNode>", "Untouched statements round-trip byte for byte; positions in %% @pixerate"),
  row("Mermaid Family Pictures (sequence, Gantt, pie, quadrant, XY, radar, timeline, journey, mindmap, gitGraph, C4, architecture)", "familyUI, mermaidToScene & diagramRenameOp (/diagram, /canvas)", "useMermaidDiagram().scene & <MermaidFamilyScene>", "createMermaidDiagram().scene & <MermaidFamilyScene>", "Drawn as Mermaid draws them; data fields edited in place or by agents"),
  row("Mermaid Streaming View & Finder", "DiagramStream & findMermaidSources", "useMermaidStream", "createMermaidStream", "Nodes glide in as a model writes Mermaid"),
  row("Mermaid Diagram Agent Tools", "createDiagramToolProvider", "useAgentToolProvider", "useAgentToolProvider", "23 tools, checked against the diagram and family fields before any change"),
  row("Mermaid Diagram Export & Thumbnails", "mermaidToSvg, rasterizeSvg & downloadDiagramPng", "<MermaidThumbnail>", "<MermaidThumbnail>", "SVG and PNG without the canvas mounted; render_diagram tool"),
  row("Inline Agent Carets in Text (presence, typeAgentText)", "AgentCaret & createRichTextToolProvider presence", "Via core & useAgentToolProvider", "Via core & useAgentToolProvider", "Named caret, selection and changed-text tint as decorations; typed edits stay one undo step"),
  row("Mermaid Diagram Agent Cursors", "DiagramDirector & draftFrames", "useDiagramDirector & <DiagramPresenceLayer>", "createDiagramDirector & <DiagramPresenceLayer>", "Agent edits acted out by a cursor; one undo step per call"),
  row("Canvas Keyframe Animation & Timeline", "evaluateAnimation & createCanvasAnimationController", "useCanvasAnimation & <AnimationTimeline>", "createCanvasAnimation & <AnimationTimeline>", "OKLab colours, springs, record mode, snapping"),
  row("Canvas Animation Export & Commands", "exportCssAnimation & createCanvasAnimationCommands", "Via core", "Via core", "CSS @keyframes, Web Animations, agent tools"),
  row("Chart Editor (bar, line, area, scatter, pie, donut, combos, stacking, horizontal bars)", "ChartController & layoutChart (/chart)", "useChartEditor & <ChartEditor>", "createChartEditor & <ChartEditor>", "DOM-free layout to drawing primitives; one spec drives the canvas, grid and agent tools"),
  row("Chart Selection, Drag-to-Edit & Keyboard Editing", "startChartPointDrag & handleChartKey", "<ChartCanvas>", "<ChartCanvas>", "A drag is one undo step; values snap to a tenth of the tick step"),
  row("Chart Data Grid, Paste & CSV Import", "pasteCells, importCsv & chartDataFromTable", "<ChartDataGrid>", "<ChartDataGrid>", "Numbers as typed (1,200 · 12% · blank gap); pasting grows the grid"),
  row("Chart Inspector (type, titles, axes, legend, formats, series)", "update, setAxis, setLegend & updateSeries", "<ChartInspector>", "<ChartInspector>", "All-or-nothing edits with sentence errors"),
  row("Chart SVG Export & Agent Commands", "chartToSvg & createChartCommands", "useChartCommands", "useChartCommands", "Series and categories addressed by name"),
  row("Chart Agent Tools (28, one per operation)", "createChartToolProvider", "useChartToolProvider", "useChartToolProvider", "Read-only hides writes; drags and keys go through the real interaction code"),
  row("Chart PNG Previews & Download", "rasterizeChartSvg, downloadChartPng & render_chart { format: \"png\" }", "useChartToolProvider (default rasterizer) & <ChartEditor> Download PNG", "useChartToolProvider (default rasterizer) & <ChartEditor> Download PNG", "CSS-variable paints are resolved before drawing; longest side ≤ 1024 px"),
  row("More Chart Types (bubble, radar, waterfall, histogram, box, funnel, treemap)", "layoutChart families", "<ChartCanvas>", "<ChartCanvas>", "Algorithms ported from GridCraft"),
  row("Secondary Axis, Numeric-X Scatter, Date Axes & Trendlines", "yAxis2, series.x, chartDateLabels & fitChartTrendline", "<ChartInspector>", "<ChartInspector>", "Trendline fits return coefficients and R²"),
  row("Chart Error Bars, Log & Reversed Axes", "series.errorBars / xErrorBars, axis.scale / logBase / reverse & chartErrorAmounts", "<ChartInspector>", "<ChartInspector>", "Office c:errBars, c:logBase and maxMin round trip; set through update_chart / update_chart_series"),
  row("Chart Mermaid & Office XML Round Trip", "chartToMermaid, chartFromMermaid, chartToOoxml & chartFromOoxml", "Via core", "Via core", "Charts in DOCX imports come back as specs"),
  row("Charts in Excel, PowerPoint & Word Files", "extractOfficeCharts & createOfficeChartToolProvider", "useOfficeChartToolProvider", "useOfficeChartToolProvider", "Sheet and anchor cell or slide number for each chart; Charts tab opens a file"),
  row("Chart Streaming, Agent Cursors & Sparklines", "ChartStream, ChartDirector & layoutSparkline", "<ChartStreamingView>, useChartDirector & <ChartSparkline>", "<ChartStreamingView>, createChartDirector & <ChartSparkline>", "Agent edits act out with a cursor and stay one undo step"),
  row("Chart Summaries, Colour Checks & Accessible SVG", "summarizeChart, checkChartColors & chartToSvg", "Via core", "Via core", "Agents verify charts without rendering"),
  row("Charts & Sparklines in Documents", "Chart & Sparkline nodes (chart preset option), getDocumentCharts", "createReactChartNodeView & <ChartNodeView>", "createSvelteChartNodeView & <ChartNodeView>", "Click to edit in place; mermaid in markdown, static SVG in HTML, DOCX charts become nodes; insert_chart / update_chart_in_document tools"),
  row("Parameters Editor (schema, groups, showIf, validation, presets, randomize)", "ParametersController (/parameters)", "useParameters & <ParametersPanel>", "createParameters & <ParametersPanel>", "One schema drives the panel and the agent tools"),
  row("Parameter Field Controls & Merged Slider Undo", "beginGesture / endGesture", "<ParameterSlider>, <ParameterColor>, <ParameterVector>, <ParameterImage>, …", "<ParameterSlider>, <ParameterColor>, <ParameterVector>, <ParameterImage>, …", "A drag is one undo step"),
  row("Parameter Keyframe Hooks & Commands; Shader @control Adapter", "createParameterKeyframeStore, createParameterCommands, parameterSchemaFromShaderControls", "<KeyframeDiamond> & useParameterCommands", "<KeyframeDiamond> & useParameterCommands", "AnimationTrack-shaped tracks"),
  row("Vector Editor (pen, pencil, shapes, direct selection, transforms, booleans, groups, smart guides & snapping)", "VectorEditorController (/vector)", "useVectorEditor & <VectorEditor>", "createVectorEditor & <VectorEditor>", "Headless pointer/key state machine; one undo step per gesture"),
  row("Vector Live Corners & Stroke Options (per-anchor radius, round / inverted / chamfer, inside / outside strokes, arrowheads, Outline Stroke)", "expandVectorCorners, setCornerRadius, vectorStrokeParts & outlineStroke", "<VectorCanvas> corner widgets & <VectorStylePanel>", "<VectorCanvas> corner widgets & <VectorStylePanel>", "Anchors stay sharp; one helper draws the cut geometry"),
  row("Vector Variable-Width Strokes (width profiles & presets, Width tool with copies, steps, multi-selection and Width Point Edit, pencil pressure, exact Bézier outlines)", "setWidthProfile, setWidthPoint, widthPointEdit, variableStrokeOutline & getVectorOverlayRenderData().widthPoints", "<VectorCanvas> width points, <VectorWidthPointEditor> & <VectorStylePanel> profile picker", "<VectorCanvas> width points, <VectorWidthPointEditor> & <VectorStylePanel> profile picker", "Monotone interpolation; outline refitted to cubics; SVG round-trips the profile; arrowheads sized from the profile"),
  row("Vector Pathfinder, Shape Builder & Paint Bucket (Divide, Trim, Merge, Crop, Outline, Minus Back; merge / delete faces, line pieces and outline edges; fill enclosed regions)", "pathfinder, shapeBuilder, fillRegion, PlanarMap, cutOutPiece & hatchPath", "<VectorCanvas> hatched face highlights & <VectorToolbar> Pathfinder group", "<VectorCanvas> hatched face highlights & <VectorToolbar> Pathfinder group", "Document space; faces merge along the planar map's own edges"),
  row("Vector Blends & Path Morphing (live blend groups, steps / distance / smooth colour, replace spine, Blend tool, Expand / Release, path keyframes)", "blend, setBlendOptions, replaceBlendSpine, expandBlend, createVectorMorph & evaluateVectorPathKeyframes", "<VectorCanvas> spines & <VectorToolbar> Blend group", "<VectorCanvas> spines & <VectorToolbar> Blend group", "Arc-length anchors, rotation-aware correspondence, Procrustes in-betweens, OKLab paint"),
  row("Vector Path Effects (Trim Paths, Round Corners, Pucker & Bloat, Twist, Zig Zag, Wiggle, Offset, Merge, Repeater; Expand Appearance)", "addEffect, updateEffect, expandAppearance, expandVectorAppearance & getVectorEffectsPanel", "<VectorEffectsPanel> in <VectorStylePanel>", "<VectorEffectsPanel> in <VectorStylePanel>", "After Effects stacking; one cached place for render, hit-test, bounds, snapping, booleans and SVG; a slider drag is one undo step"),
  row("Vector Live Booleans (editable operands, per-operand operations)", "booleanOp(op, { live }) & foldVectorBooleanOperands", "<VectorToolbar> Live toggle", "<VectorToolbar> Live toggle", "Prefix-cached fold: an edit recombines only the operands above it"),
  row("Vector Gradients (linear, radial with focal point, conic, reflected, diamond; midpoints, Oklab / linear-light interpolation, spread, along / across strokes; Gradient tool)", "setGradient, setGradientStop, vectorGradientSvgDefs, expandVectorGradientStops & getVectorOverlayRenderData().gradient", "<VectorGradientEditor> in <VectorStylePanel> & <VectorGradientAnnotator>", "<VectorGradientEditor> in <VectorStylePanel> & <VectorGradientAnnotator>", "Plain SVG: extra stops and patterns of gradient tiles; data-vector-gradient round-trips every field"),
  row("Vector SVG Import / Export & Agent Commands", "parseVectorSvg, vectorDocumentToSvg & createVectorCommands", "useVectorCommands", "useVectorCommands", "DOM-free SVG parser; gradients kept"),
  row("Vector Animation Scenes (shots of enter (including wipe, iris and split reveals), exit, draw, move, morph, follow, emphasis (pulse, shake, teeter, wave, wiggle, colour pulse) and live-effect commands; camera framing; timing from content)", "MotionScene, compileMotionScene & motionFrameAt (/animation-editor)", "<AnimationStage>", "<AnimationStage>", "Every frame a pure function of time"),
  row("Vector Animation Editor & Checks", "AnimationEditorController, applyMotionEdits & checkMotionScene", "useAnimationEditor, <AnimationEditor> & <ShotTimeline>", "createAnimationEditor, <AnimationEditor> & <ShotTimeline>", "All-or-nothing edits; coded issues with \"did you mean\""),
  row("Vector Animation Hand Controls", "motionCommandFields, motionEasingCurve, motionNodeAtElement & fitMotionSceneEdits", "<PlayheadScrubber>, <CommandList>, <CommandInspector>, <EasePicker>, <ShotInspector> & <SceneSettings>", "<PlayheadScrubber>, <CommandList>, <CommandInspector>, <EasePicker>, <ShotInspector> & <SceneSettings>", "Inspector generated from the tool schema; pick targets on the stage; one undo step per change"),
  row("Vector Animation Agent Tools & Flair Export", "createAnimationEditorToolProvider, toFlairSvgMotion & toFlairVectorEffect", "useAnimationEditorTools", "useAnimationEditorTools", "28 tools; Flair SvgMotion, catalog effects with colour controls"),
  row("Video Projects & Edits (assets, video / audio tracks, media, title and colour clips; insert, overwrite, sync-locked ripple, trim, split, move, slip, roll, slide, lift / extract, close gaps, rate stretch, speed ramps and freeze frames; all or nothing, never adds an error)", "VideoProject, applyVideoEdits & checkVideoProject (/video-editor)", "Via core", "Via core", "Plain JSON; times in ms on an fps grid"),
  row("Video Transitions, Frames & Playback (crossfade, dip, wipe, push, slide, iris over the cut with handle checks, equal-power sound through them; blend modes; colour grades and looks; entrance and exit animations; layers and sounds at any time; canvas preview syncing media elements)", "videoFrameAt, drawVideoFrame & VideoPreviewEngine", "<VideoPreview>", "<VideoPreview>", "One frame function for preview, SVG, export and agents"),
  row("Video Editor, Timeline & Panels (selection, snapping, drag to move (Alt inserts, Shift overwrites) / trim with ripple, keyboard, transport, clip inspector, media bin)", "VideoEditorController & planVideoClipDrag", "useVideoEditor, <VideoEditor> & <VideoTimeline>", "createVideoEditor, <VideoEditor> & <VideoTimeline>", "Drag maths in core; one undo step per gesture"),
  row("Video Keyframes (opacity, volume and transform keys in clip time; linear, hold, named and cubic-bezier easing; exact splits; baked to ffmpeg expressions)", "videoValueAt, splitVideoAnimatable & set_keyframes", "<ClipInspector> keyframe toggles", "<ClipInspector> keyframe toggles", "One value function for preview, SVG, export and agents"),
  row("Video Sound (shaped fades matching ffmpeg afade; waveforms from a peak pyramid decoded once per asset; levels and silence detection)", "videoFadeCurveGain, buildVideoAudioPeaks & VideoAudioPeaksCache", "<VideoTimeline> waveforms, <ClipInspector> fade curves", "<VideoTimeline> waveforms, <ClipInspector> fade curves", "Preview, export and agents read the same curves and peaks"),
  row("Video Text-Based Editing (transcripts from Whisper JSON, SRT or VTT mapped onto the timeline; cut words, fillers and pauses)", "videoTimelineTranscript, findVideoFillers & videoRemoveRangesEdits", "<TranscriptPanel>", "<TranscriptPanel>", "Transcripts timed in the source survive every cut"),
  row("Video Export & Agent Tools (ffmpeg command with loudness normalisation, CMX 3600 EDL in drop-frame at NTSC rates; 51 tools)", "toVideoFfmpeg, toVideoLoudnessMeasure, toVideoEdl & createVideoEditorToolProvider", "useVideoEditorTools", "useVideoEditorTools", "Write tools hidden while read-only"),
  row("Comments (threads, replies, resolve, orphan detection, JSON)", "Extension & CommentStore", "CommentsPanel, CommentButton, useComments", "CommentsPanel, CommentButton, createComments", "Anchored comment marks"),
  row("Track Changes (insert/delete marks, accept/reject, navigation)", "Extension & getTrackedChanges", "ReviewToolbar, useTrackChanges", "ReviewToolbar, createTrackChanges", "Suggestion mode"),
  row("Tracked-content export (trackedChanges: \"accepted\" default)", true, "Via core", "Via core", "Exports as if all changes were accepted"),
  row("Tracked moves (cut + paste / drag, accept or reject as one)", "TrackChanges (acceptMove, rejectMove)", "ReviewToolbar, TrackedChangesList", "ReviewToolbar, TrackedChangesList", "Green double strike / underline, as in Word"),
  row("Paragraph styles (basedOn, next style, linked character styles)", "ParagraphStyles & createStyleRegistry", "StylesGallery, useParagraphStyles", "StylesGallery, createParagraphStyles", "Update to match selection; new style from selection"),
  row("Compare documents into tracked changes", "compareDocuments, compareHtml, diffSequences, setContentFromComparison", "useDocumentCompare", "createDocumentCompare", "Word-style Compare: review differences with ReviewToolbar"),
  row("Find & Replace (^ codes, wildcards, regex; Mod+F / Mod+H)", "FindReplace", "FindReplaceBar, useFindReplace", "FindReplaceBar, createFindReplace", "Linear-time matcher; tracked replacements"),
  row("Tables (headers, spans, resizing, cell alignment; table commands)", "createTableExtensions, createTableCommands", "TableToolbar, TableBubbleMenu, InsertTableGrid", "TableToolbar, TableBubbleMenu, InsertTableGrid", "GFM markdown, tab-separated text, tracked rows/columns"),
  row("File Import Registry (.md, .html, .txt, .rtf; pluggable adapters)", true, "useFileImport + fileImport", "createFileImport + fileImport prop", "registerImportAdapter for new formats"),
  row("Word (.docx) export with comments, replies and tracked changes", "exportDocx & DocxExportController", "useDocxExport, ExportDocxButton", "createDocxExport, ExportDocxButton", "Styles, lists, tables, images; privacy: strip-authors"),
  row("Word (.docx) import of comments, tracked changes and styles", "docxToDocumentImport (trackedChanges: \"marks\") & applyImportedReviewData", "Via core", "Via core", "Replies, resolved state, moves, w:rPrChange / w:pPrChange"),
  row("Drag-and-Drop File Import at Drop Position", "FileImport", true, true, "Dropped files land where they are dropped"),
  row("PDF Structure Detection (columns, headings, lists, tables, running headers)", "analyzePdfLayout + createPdfImportAdapter", "useFileImport().structureSummary", "createFileImport().structureSummary", "adapterOptions: { pdf: { structure: false } } falls back to plain paragraphs"),
  row("Rich Clipboard MIME (application/x.pixerate.document+json)", "RichClipboard", "richClipboard", "richClipboard prop", "Lossless copy/paste between editors"),
  row("Dynamic Agent Tool Registry (MCP tools/list / tools/call, listChanged)", "ToolRegistry", "useAgentToolProvider", "useAgentToolProvider", "Providers register as editors mount"),
  row("Screenshot Capture for Agents (capture_view)", "createCaptureTool, createCanvasCaptureToolProvider & image capture_view", "useCanvasCapture", "createCanvasCapture", "Viewport, content, selection, nodes or a rect; returns the rect and scale"),
  row("MCP Bridge to Live Editors", "createToolBridge (/bridge) & connectToolBridge", "useToolBridge", "useToolBridge", "One stdio MCP server drives tabs over localhost; token, origins, cancellation"),
  row("Spreadsheet Sort (multi-column, range) & Transpose", true, true, true, "Header and footer rows stay put"),
  row("Spreadsheet Filters (per-column rules, toggle)", true, true, true, "Filters live in the view model"),
  row("Spreadsheet Freeze Panes, Header & Footer Rows", true, true, true, "Sticky frozen rows and columns"),
  row("Spreadsheet Hide/Unhide Rows & Columns", true, true, true, "Hidden state separate from filters"),
  row("Spreadsheet Merged Cells", true, true, true, "Normalized, non-overlapping ranges"),
  row("Spreadsheet Autofill (fill handle, series, formula shifting)", true, true, true, "Drag the fill handle to extend"),
  row("Spreadsheet Categories (grouped rows, summaries, collapse)", true, true, true, "SUM / COUNT / AVERAGE / MIN / MAX per group"),
  row("Spreadsheet CSV Import/Export (RFC 4180)", true, true, true, "Quoted fields, embedded newlines"),
  row("Spreadsheet CSV / TSV File Import Adapters (import registry)", "importFileIntoSpreadsheet", "Via core", "Via core", "registerSpreadsheetImportAdapters"),
  row("Spreadsheet Clipboard (TSV + HTML + lossless JSON)", true, true, true, "Paste from and to other spreadsheet apps"),
  row("Spreadsheet Table Context Menu", "Headless", "Component", "Component", "getSpreadsheetMenuItems"),
  row("Spreadsheet Formula Function Registry (86 functions, registerFormulaFunction)", true, "Via core", "Via core", "Argument metadata and indexed error messages"),
  row("Formula Error Diagnostics (CellData.errorMessage, error cell tooltips)", true, true, true, "Explains why a formula failed"),
  row("Formula Autocomplete & Argument Hints (<FormulaHints />)", "Headless (getFormulaHints)", "Component", "Component", "Function list and active-argument hint"),
];

const FEATURES: ParityRow[] = [
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
  {
    feature: "Canvas Layout & Math Engine",
    core: true,
    react: true,
    svelte: true,
    note: "@pixerate/editor/canvas: Dagre layout, centering, and displacements",
  },
  {
    feature: "Incremental Layout & Collision Avoidance",
    core: true,
    react: true,
    svelte: true,
    note: "ensureLayout preserves user positions; placeBeside avoids overlap",
  },
  {
    feature: "Deterministic Animation Clock",
    core: true,
    react: true,
    svelte: true,
    note: "ManualClock and realClock: frame-by-frame stepping for testing & video",
  },
  {
    feature: "Streaming Canvas & Stabilization",
    core: true,
    react: true,
    svelte: true,
    note: "StreamingLayoutManager, connectedOnly edge filtering, and height estimation",
  },
  {
    feature: "Multi-Agent Presence & Narration",
    core: true,
    react: true,
    svelte: true,
    note: "<AgentPresenceLayer /> with cursor tags and speech narration bubbles",
  },
  {
    feature: "Design System Component Inversion",
    core: true,
    react: true,
    svelte: true,
    note: "<EditorSlotsProvider /> and useEditorSlots for host theme injection",
  },
  {
    feature: "Agent Remote Director & MCP Schemas",
    core: true,
    react: true,
    svelte: true,
    note: "planAgentCommand, validateAgentCommand, per-operation canvas_* / prompt_* tools, createMcpServer",
  },
  {
    feature: "Image Editor Canvas Engine & Transformations",
    core: true,
    react: true,
    svelte: true,
    note: "Crop presets (1:1, 4:3, 16:9, 3:2), 90° rotations, and horizontal/vertical flips",
  },
  {
    feature: "Image Filters & Adjustments",
    core: true,
    react: true,
    svelte: true,
    note: "Brightness, contrast, saturation, exposure, warmth, blur, and opacity",
  },
  {
    feature: "Image Annotations & Layer Vectors",
    core: true,
    react: true,
    svelte: true,
    note: "Freehand pen paths, rectangles, circles, arrows, lines, and text watermarks",
  },
  {
    feature: "Gleamforge Depth Alpha Masking",
    core: true,
    react: true,
    svelte: true,
    note: "Threshold and brightness depth alpha blending with softness, invert, and removeAlpha",
  },
  {
    feature: "Image Layer Stack (tiled surfaces, compositor, schema v3)",
    core: true,
    react: true,
    svelte: true,
    note: "Pixel, adjustment, group and annotation layers on copy-on-write 256 px tiles; per-tile compositor with prefix caches; v1 / v2 documents unchanged; list_layers agent tool",
  },
  {
    feature: "Image Layers Panel & Layer Operations",
    core: true,
    react: true,
    svelte: true,
    note: "New, duplicate, delete, drag to reorder and nest, groups, merge down / visible, flatten, layer via copy / cut, masks, clipping, locks, opacity, fill, blend, layer filters; 22 agent tools",
  },
  {
    feature: "Image Painting (Brush, Eraser, Fill, Move)",
    core: true,
    react: true,
    svelte: true,
    note: "Round brush with hardness, spacing, opacity vs flow, smoothing and pressure; mask painting; selection-limited; one undo step per stroke; paint_stroke / fill_pixels / clear_pixels agent tools",
  },
  {
    feature: "Image Layer Integrations (AI to layers, rasterize, sampling, asset store)",
    core: true,
    react: true,
    svelte: true,
    note: "Inpainting into a new layer and background removal as a mask in multi-layer documents; Rasterize Layer; sample all layers or the active layer; external asset store for v3 pixels",
  },
  {
    feature: "Image Selections, Refine Edge & Layer Masks",
    core: true,
    react: true,
    svelte: true,
    note: "Magic wand, colour range, marquees, lasso, selection modes, grow/shrink/feather/border/smooth, guided-filter Refine Edge, Quick Mask, adjustment layer masks",
  },
  ...PRODUCTIVITY_FEATURES,
];

function ParityCell({ value }: { value: ParityValue }) {
  if (value === true) return <Check className="w-4 h-4 text-emerald-400 mx-auto" />;
  if (value === false) return <span className="text-slate-600">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300 font-mono">
      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
      {value}
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
                    <ParityCell value={item.core} />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <ParityCell value={item.react} />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <ParityCell value={item.svelte} />
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
