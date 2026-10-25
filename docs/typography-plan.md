# Shared typography module and font management: implementation plan

Status: **draft / not started.** This plan covers the architectural design and step-by-step implementation of a centralized, DOM-free typography engine in `@pixerate/editor/typography`, with React and Svelte UI controls, agent tools, cross-domain integration, and parity across all editors (including the recently merged dedicated effect authoring editor).

---

## Why

Typography is currently fragmented across the repository in isolated, uneven silos:

1. **Unequal capabilities & asymmetric font introspection**:
   - The **vector editor** is the only surface with font shaper queries (`vector.listFonts`), full OpenType/DTP metrics (`fontSize`, `tracking`, `leading`, `baselineShift`), inline UTF-16 style runs, overflow tracking, and vector outline conversion (`vector.createOutlines`).
   - The **video editor** supports title clips with only flat, crude font properties (`fontSize`, `fontFamily`, `fontWeight`, `color`, `background`)—lacking tracking, leading, styled text runs, and title-safe wrapping/overflow checks.
   - The **canvas editor** treats text as an opaque property on component instances or node labels (`data.label`), with no font discovery, styling commands, or hierarchy tokens.
   - The **chart editor** treats text solely as plain strings for titles and axis labels without font scaling, truncation, or minimum legibility rules.
   - The **rich text editor** depends entirely on browser DOM/CSS inheritance and cannot inspect visual line bounds, character measures, or text overflow.
   - The newly merged **effects authoring editor** (`@pixerate/editor/effects`, PR #326) and effect parameter system handle shaders and motion generators, including `title` effects (`use: 'title'`), but represent text controls merely as unconstrained strings (`{ type: 'text', default: '', maxLength }`), lacking font family pickers, weights, or scale tokens.

2. **Typography & accessibility disconnect**:
   - [`pixerate-color`](../packages/core/src/color) audits WCAG 2 contrast (`check_color_contrast`) and provides OKLCH lightness suggestions. However, real-world legibility depends simultaneously on **contrast, font size, and font weight** (e.g., WCAG 2 large-text thresholds: $\ge 18\text{pt} / 24\text{px}$ or $14\text{pt} / 18.5\text{px}$ bold).
   - Currently, color tools must be manually instructed whether text is "large". There are no automated tools to check whether typography complies with WCAG 1.4.12 (text spacing: 1.5× line height, letter spacing $\ge 0.12\text{em}$, word spacing $\ge 0.16\text{em}$) or whether line measures fall within comfortable reading ranges (45–75 characters per line).

3. **Motion and animation hurdles**:
   - The **animation editor** requires converting text into vector outlines (`vector.createOutlines`) before calling `get_text_layout` to split words and letters for staggered animations (`cascade`). A host-agnostic text segmenter would allow live text in video titles, animation shots, and canvas nodes to be animated without destructive outline conversion.

---

## Validation against the latest codebase (including Effects Editor)

The repository recently merged general-purpose effect authoring (`@pixerate/editor/effects`, PR #326), introducing:
- `EffectAuthoringEditor` in React and Svelte.
- `EffectAuthoringSession` in core (`packages/core/src/effects/authoring.ts`).
- Effect authoring agent tools (`pixerate-effect-authoring` skill).
- Control descriptors via `createEffectControlDescriptors` in `ui.ts` (`enum`, `color`, `vector2..4`, `text`).
- Dedicated support for `title` effects (`use: 'title'`) and `overlay` effects (`use: 'overlay'`).

### How this plan integrates with the effects editor:
1. **Semantic font controls for effects**: Extend effect parameter schemas and `createEffectControlDescriptors` to recognize semantic typography controls (`format: "font"` or `type: "font"`). Shaders and procedural title generators in effect authoring can now expose rich font selectors rather than raw text strings.
2. **Deterministic previewing & font preloading**: Effect authoring preview renders into WebGL / 2D canvases via `EffectRendererPool`. When rendering `title` effects, font metrics and web font loading states must be resolved before rasterizing preview frames to prevent Flash of Unstyled Text (FOUT) or black fallback frames.
3. **Pluggable shaper & runtime isolation**: In accordance with `AGENTS.md` and `tests/entry-isolation.test.ts`, `@pixerate/editor/typography` must remain **100% dependency-free in core**. It must not import DOM APIs, Node canvas, or heavy binary font engines directly. The core module defines pure mathematical models, token scales, fallback chains, and pluggable font shaper/provider interfaces (`FontProvider`), mirroring how `@pixerate/editor/effects` defines `EffectProvider` without bundling Flair.

---

## Architectural Principles (The "Color" Blueprint)

Following the proven architecture of [`pixerate-color`](../packages/core/src/color/):

```
packages/core/src/
├── color/       # DOM-free: spaces, contrast, harmonies, palettes, gradients
└── typography/  # DOM-free: font tokens, modular scales, measure audits, text segmentation
```

1. **Pure logic & DOM-free core**: No DOM access, no ProseMirror, no TipTap, and no framework dependencies in `packages/core/src/typography`.
2. **Strict separation of concerns**:
   - **Centralized**: Token definitions (`FontSpec`), modular scale generation, line-length/measure audits, readability rules, text segmentation (`Intl.Segmenter`), font stack fallbacks, and agent inspection tools.
   - **Decentralized (editor-specific)**: Document ASTs (ProseMirror tree vs. Vector Bezier shapes vs. Video tracks vs. Mermaid strings) and runtime renderers (Canvas2D vs. HarfBuzz vs. DOM layout).
3. **Cross-framework parity**: React (`@pixerate/editor-react`) and Svelte (`@pixerate/editor-svelte`) both provide identical headless bindings and UI components (`FontPicker`, `TypographyControls`).
4. **Agent tools as first-class citizens**: All capabilities are exposed via `createTypographyToolProvider`, covered by the `pixerate-typography` skill, and validated in `tests/agent-skills.test.ts` and `tests/command-tools.test.ts`.

---

## Phased Implementation Plan

### Phase 1: Core Typography Types, Scales & Math (`packages/core/src/typography`)

Create `packages/core/src/typography/`:

#### 1.1 Types (`types.ts`)
```ts
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 'normal' | 'bold';
export type FontStyle = 'normal' | 'italic' | 'oblique';
export type FontCategory = 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';

/** Normalized specification for a typographic style. */
export interface FontSpec {
	family: string;
	weight?: FontWeight;
	style?: FontStyle;
	size: number;              // in px (or pt where indicated)
	lineHeight?: number;       // unitless multiplier (e.g. 1.5) or px
	letterSpacing?: number;    // tracking in em or px
	category?: FontCategory;
}

/** Predefined modular scale ratios. */
export type ModularScaleRatio =
	| 'minor-second'    // 1.067
	| 'major-second'    // 1.125
	| 'minor-third'     // 1.200
	| 'major-third'     // 1.250
	| 'perfect-fourth'  // 1.333
	| 'augmented-fourth'// 1.414
	| 'perfect-fifth'   // 1.500
	| 'golden-ratio';   // 1.618

export interface TypeScaleStep {
	name: string;           // e.g. "caption", "body", "h4", "h3", "h2", "h1", "display"
	step: number;           // integer exponent from base 0
	size: number;           // computed size in px
	lineHeight: number;     // recommended unitless line-height
	letterSpacing: number;  // recommended tracking in em
}

export interface TypeHierarchy {
	ratio: number;
	baseSize: number;
	steps: Record<string, TypeScaleStep>;
}

export interface ReadabilityAuditResult {
	lineLength: {
		characters: number;
		words: number;
		status: 'optimal' | 'too-short' | 'too-long'; // optimal is 45-75 chars
		recommendation?: string;
	};
	lineSpacing: {
		ratio: number;
		passesWCAG1412: boolean; // line-height >= 1.5x body font size
		recommendation?: string;
	};
	allCaps: boolean;
	estimatedReadingTimeSeconds: number;
}
```

#### 1.2 Modular Scales & Hierarchy (`scale.ts`)
- Implement `getScaleRatio(name: ModularScaleRatio): number`.
- `computeTypeScale(baseSize: number, ratio: number | ModularScaleRatio, steps: number[]): TypeScaleStep[]`.
- `generateTypeHierarchy(options: { baseSize?: number; ratio?: ModularScaleRatio }): TypeHierarchy`: Generates tokens for `caption`, `body-sm`, `body`, `h4`, `h3`, `h2`, `h1`, `display` with appropriate tracking (tighter for large headings, looser for captions).
- `computeFluidSize(options: { minSize: number; maxSize: number; minViewport: number; maxViewport: number }): { clampCss: string; evaluateAt: (viewport: number) => number }`.

#### 1.3 Measure, Line-Length & Readability (`metrics.ts`)
- `auditTextReadability(text: string, font: Partial<FontSpec>): ReadabilityAuditResult`:
  - Evaluates average line lengths against the 45–75 character standard.
  - Checks line-height ratio against WCAG 1.4.12 ($\ge 1.5$).
  - Detects all-caps body text and flags readability penalties.

#### 1.4 Fallback Font Stacks (`stack.ts`)
- Standardized, cross-platform font stacks:
  - `system-ui`: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
  - `humanist-sans`: `Optima, Candara, Calibri, "Trebuchet MS", sans-serif`
  - `geometric-sans`: `"Century Gothic", Futura, AvantGarde, "URW Gothic L", sans-serif`
  - `editorial-serif`: `Charter, "Bitstream Charter", "Sitka Text", Cambria, serif`
  - `transitional-serif`: `"Baskerville Old Face", "Hoefler Text", Garamond, Times, serif`
  - `code-mono`: `ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace`
- `parseFontFamily(stack: string): string[]`: Tokenizes CSS font-family strings safely.
- `resolveFontFallback(family: string, category?: FontCategory): string`: Provides a robust fallback stack.

#### 1.5 Host-Agnostic Text Segmentation (`segment.ts`)
- `segmentText(text: string, granularity: 'grapheme' | 'word' | 'line'): { text: string; start: number; end: number }[]`:
  - Uses standard `Intl.Segmenter` (supported in modern JS/Node).
  - Enables breaking live text into letters, words, and lines for animation sequencing without requiring Bezier outlines.

#### 1.6 Unified Typography & Accessibility Audit (`accessibility.ts`)
- Connects directly with `packages/core/src/color/contrast.ts`:
  - `checkTypographyAccessibility(options: { font: FontSpec; foreground: string; background: string })`:
    - Evaluates whether text meets WCAG 2 AA/AAA using exact font metrics (determining large-text eligibility automatically from `size` and `weight`).
    - Reports required contrast ratio ($3:1$ vs. $4.5:1$ vs. $7:1$) and returns adjusted OKLCH color suggestions via `check_color_contrast`.

---

### Phase 2: Pluggable Font Registry & Catalog Interface

#### 2.1 Interface Definition (`registry.ts`)
```ts
export interface FontSummary {
	family: string;
	category: FontCategory;
	weights: FontWeight[];
	styles: FontStyle[];
	isVariable?: boolean;
	source: 'system' | 'web' | 'custom';
}

export interface FontProvider {
	readonly id: string;
	listFonts(): Promise<FontSummary[]>;
	hasFont(family: string): boolean | Promise<boolean>;
	loadFont?(family: string, weight?: FontWeight, style?: FontStyle): Promise<boolean>;
}
```

#### 2.2 Standard Font Catalog (`catalog.ts`)
- Bundle zero binary files; provide a metadata catalog of universal system fonts across macOS, Windows, iOS, Android, and Linux.
- Provide a `SystemFontProvider` using browser `document.fonts.check()` / `queryLocalFonts()` when available, falling back gracefully to catalog matching in headless/Node environments.

---

### Phase 3: Agent Tools & Skill (`pixerate-typography`)

#### 3.1 Agent Tools Factory (`tools.ts`)
Implement `createTypographyToolProvider(options?: { provider?: FontProvider })`:
- `list_fonts`: Lists available fonts filtered by category, weight, or source.
- `resolve_font_stack`: Takes a font family and returns a resilient cross-platform fallback stack.
- `suggest_type_scale`: Computes a modular type scale given a base size and ratio.
- `generate_type_hierarchy`: Generates standardized typographic tokens (Display $\dots$ Caption).
- `audit_text_readability`: Audits line-length measure, line-height ratio, and all-caps penalties.
- `check_typography_accessibility`: Evaluates font size, weight, and foreground/background colors against WCAG standards.
- `segment_text`: Splits text into graphemes, words, or lines with character indices.

#### 3.2 Agent Skill (`packages/core/skills/pixerate-typography/SKILL.md`)
- Create the domain skill adhering to `AGENTS.md` §4:
  - Mental model, working method, best practices, tool reference table, and pitfalls.
- Register factory in `packages/core/tests/agent-skills.test.ts` (`FACTORIES` and `expectedBySkill()`).

---

### Phase 4: Headless FontPicker Model (`packages/core/src/typography/picker.ts`)

Implement `FontPickerModel`:
- Manages selected family, weight, style, size, and category filter.
- In-memory search and recent font history.
- Preview text rendering state.
- Emits clean change events for UI bindings.

---

### Phase 5: React and Svelte UI Components

#### 5.1 React (`@pixerate/editor-react/typography`)
- `FontPicker`: Dropdown/combobox with category filters, font weight selector, and live preview.
- `TypographyControl`: Composite inspector control (Family, Weight, Size, Line Height, Letter Spacing).
- `useFontPicker` / `useTypography`: Hooks wrapping `FontPickerModel`.

#### 5.2 Svelte (`@pixerate/editor-svelte/typography`)
- `FontPicker.svelte` and `TypographyControl.svelte` with full reactive store / runes parity.
- `fontPickerOf` helper.

---

### Phase 6: Cross-Editor Integration

1. **Effects Editor & Authoring (`@pixerate/editor/effects`)**:
   - Update `packages/core/src/effects/ui.ts` (`createEffectControlDescriptors`):
     - Support `{ type: 'font' }` or schemas with `format: 'font'` / `x-pixerate-control: 'font'`.
     - Allow title effects (`use: 'title'`) to display rich font pickers in `EffectParameters.tsx` and `EffectParameters.svelte`.
     - In `EffectAuthoringEditor`, ensure fonts used in title shaders/generators are loaded prior to preview frame rendering.
2. **Video Editor (`@pixerate/editor/video`)**:
   - Upgrade `add_video_clip` and `update_video_clip` title configurations to accept `FontSpec`.
   - Add title-safe measure and legibility checks.
3. **Vector Editor (`@pixerate/editor/vector`)**:
   - Align `vector.listFonts` and `vector.setTextStyle` with `FontSpec` tokens.
4. **Animation Editor (`@pixerate/editor/animation`)**:
   - Integrate `segmentText` with shot timing and `get_timing_grid` so text can be animated without requiring vector outlines first.
5. **Canvas & Chart Editors**:
   - Expose typography tokens in component instance property panels.
   - Enforce minimum readable font sizes in chart axis labels.

---

### Phase 7: Verification & Quality Assurance

1. **Entry Isolation Test**:
   - Verify `packages/core/tests/entry-isolation.test.ts` passes with zero runtime dependencies.
2. **Agent Skills & Command Tools Tests**:
   - Verify `packages/core/tests/agent-skills.test.ts` and `tests/command-tools.test.ts` pass with full tool title, description, and annotation coverage.
3. **Framework Parity**:
   - Verify test suites in `packages/core`, `packages/react`, `packages/svelte`, and `apps/demo`.
4. **Changeset**:
   - Add documentation changeset `.changeset/typography-plan-docs.md`.
