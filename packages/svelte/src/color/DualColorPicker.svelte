<script lang="ts">
  import ColorPicker from './ColorPicker.svelte';
  import {
    type ColorScheme,
    type ColorValue,
    type DualColor,
    DEFAULT_SCHEME_SURFACES,
    normalizeDualColor,
    resolveColor,
    setDualColorSide,
    deriveDualColor,
    checkDualColorContrast,
    isSameInBothSchemes
  } from '@pixerate/editor/color';

  interface Props {
    /** Dual colour value (CSS string, light-dark(), or { light, dark }) */
    value?: ColorValue;
    /** Called when the dual colour value changes */
    onchange?: (value: DualColor) => void;
    onChange?: (value: DualColor) => void;
    /** Controlled active scheme mode ('light' | 'dark') */
    scheme?: ColorScheme;
    /** Called when the user toggles active scheme tab */
    onschemechange?: (scheme: ColorScheme) => void;
    onSchemeChange?: (scheme: ColorScheme) => void;
    /** Expected background surfaces for derivation and preview */
    surfaces?: DualColor;
    /** Optional background colour to evaluate contrast against in both modes */
    contrastAgainst?: ColorValue;
    /** Whether alpha slider is shown */
    alpha?: boolean;
    /** Preset swatches */
    swatches?: readonly string[];
    /** Whether picker is disabled */
    disabled?: boolean;
    /** Additional CSS class name */
    class?: string;
    className?: string;
    /** Gesture callbacks */
    ongesturestart?: () => void;
    onGestureStart?: () => void;
    ongestureend?: () => void;
    onGestureEnd?: () => void;
  }

  let {
    value = DEFAULT_SCHEME_SURFACES,
    onchange,
    onChange,
    scheme: controlledScheme,
    onschemechange,
    onSchemeChange,
    surfaces = DEFAULT_SCHEME_SURFACES,
    contrastAgainst,
    alpha = false,
    swatches,
    disabled = false,
    class: classProp,
    className: classNameProp,
    ongesturestart,
    onGestureStart,
    ongestureend,
    onGestureEnd
  }: Props = $props();

  const className = $derived(classProp || classNameProp || '');

  const triggerChange = (val: DualColor) => {
    onchange?.(val);
    onChange?.(val);
  };

  const triggerSchemeChange = (s: ColorScheme) => {
    onschemechange?.(s);
    onSchemeChange?.(s);
  };

  const triggerGestureStart = () => {
    ongesturestart?.();
    onGestureStart?.();
  };

  const triggerGestureEnd = () => {
    ongestureend?.();
    onGestureEnd?.();
  };

  // Internal active scheme state
  let internalScheme = $state<ColorScheme>('light');
  const activeScheme = $derived(controlledScheme ?? internalScheme);

  // Normalised dual value
  const dual = $derived<DualColor>(
    normalizeDualColor(value) ?? DEFAULT_SCHEME_SURFACES
  );

  // Same in both mode state
  let sameInBoth = $state<boolean>(false);
  let initializedSame = false;

  $effect(() => {
    if (!initializedSame) {
      sameInBoth = isSameInBothSchemes(dual);
      initializedSame = true;
    } else if (isSameInBothSchemes(dual)) {
      sameInBoth = true;
    }
  });

  const handleSchemeSelect = (nextScheme: ColorScheme) => {
    if (disabled) return;
    internalScheme = nextScheme;
    triggerSchemeChange(nextScheme);
  };

  const handleToggleSameInBoth = (checked: boolean) => {
    if (disabled) return;
    sameInBoth = checked;
    if (checked) {
      const activeColor = activeScheme === 'dark' ? dual.dark : dual.light;
      triggerChange({ light: activeColor, dark: activeColor });
    }
  };

  const handleDerive = () => {
    if (disabled) return;
    triggerGestureStart();
    const currentActive = activeScheme === 'dark' ? dual.dark : dual.light;
    const derived = deriveDualColor(currentActive, {
      from: activeScheme,
      // An unreadable surfaces prop falls back to the defaults rather than throwing.
      surfaces: normalizeDualColor(surfaces) ?? DEFAULT_SCHEME_SURFACES
    });
    triggerChange(derived);
    triggerGestureEnd();
  };

  const handleInnerChange = (hex: string) => {
    if (sameInBoth) {
      triggerChange({ light: hex, dark: hex });
    } else {
      const updated = setDualColorSide(dual, activeScheme, hex);
      triggerChange(updated);
    }
  };

  const activeColor = $derived(activeScheme === 'dark' ? dual.dark : dual.light);
  const activeContrastTarget = $derived(
    contrastAgainst ? resolveColor(contrastAgainst, activeScheme) ?? undefined : undefined
  );

  const dualContrast = $derived(
    // An unreadable contrastAgainst shows no badges rather than throwing during render.
    contrastAgainst && normalizeDualColor(contrastAgainst)
      ? checkDualColorContrast(dual, contrastAgainst)
      : null
  );

  const CHECKERBOARD_BG =
    'linear-gradient(45deg, #2a2e39 25%, transparent 25%), linear-gradient(-45deg, #2a2e39 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2a2e39 75%), linear-gradient(-45deg, transparent 75%, #2a2e39 75%)';
</script>

<div
  class="pixerate-dual-color-picker {className}"
  style="display: flex; flex-direction: column; gap: 12px; padding: 12px; background: #1a1d24; color: #e2e8f0; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); width: 260px; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; box-sizing: border-box;"
>
  <!-- Segmented Control -->
  <div
    role="tablist"
    aria-label="Color scheme mode"
    style="display: flex; background: #111318; border-radius: 6px; padding: 2px; gap: 2px;"
  >
    <button
      type="button"
      role="tab"
      aria-selected={activeScheme === 'light'}
      onclick={() => handleSchemeSelect('light')}
      {disabled}
      style="flex: 1; padding: 6px 8px; border: none; border-radius: 4px; background: {activeScheme === 'light' ? '#2d3342' : 'transparent'}; color: {activeScheme === 'light' ? '#ffffff' : '#8c95a6'}; font-weight: {activeScheme === 'light' ? 600 : 400}; cursor: {disabled ? 'not-allowed' : 'pointer'}; font-size: 12px; transition: all 0.15s ease;"
    >
      Light
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeScheme === 'dark'}
      onclick={() => handleSchemeSelect('dark')}
      {disabled}
      style="flex: 1; padding: 6px 8px; border: none; border-radius: 4px; background: {activeScheme === 'dark' ? '#2d3342' : 'transparent'}; color: {activeScheme === 'dark' ? '#ffffff' : '#8c95a6'}; font-weight: {activeScheme === 'dark' ? 600 : 400}; cursor: {disabled ? 'not-allowed' : 'pointer'}; font-size: 12px; transition: all 0.15s ease;"
    >
      Dark
    </button>
  </div>

  <!-- Dual Preview Swatches -->
  <div style="display: flex; gap: 8px;">
    <!-- Light preview button -->
    <button
      type="button"
      onclick={() => handleSchemeSelect('light')}
      {disabled}
      title="Light scheme colour preview"
      style="flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: {activeScheme === 'light' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.2)'}; border: 1px solid {activeScheme === 'light' ? '#4f46e5' : 'rgba(255,255,255,0.08)'}; border-radius: 6px; cursor: {disabled ? 'not-allowed' : 'pointer'}; text-align: left;"
    >
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #8c95a6;">
        <span>Light</span>
        <span style="font-family: monospace; font-size: 10px;">{dual.light}</span>
      </div>
      <div
        style="height: 24px; border-radius: 4px; background-image: {CHECKERBOARD_BG}; background-size: 8px 8px; overflow: hidden; border: 1px solid rgba(0,0,0,0.15);"
      >
        <div style="width: 100%; height: 100%; background: {dual.light};"></div>
      </div>
    </button>

    <!-- Dark preview button -->
    <button
      type="button"
      onclick={() => handleSchemeSelect('dark')}
      {disabled}
      title="Dark scheme colour preview"
      style="flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: {activeScheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.2)'}; border: 1px solid {activeScheme === 'dark' ? '#4f46e5' : 'rgba(255,255,255,0.08)'}; border-radius: 6px; cursor: {disabled ? 'not-allowed' : 'pointer'}; text-align: left;"
    >
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #8c95a6;">
        <span>Dark</span>
        <span style="font-family: monospace; font-size: 10px;">{dual.dark}</span>
      </div>
      <div
        style="height: 24px; border-radius: 4px; background-image: {CHECKERBOARD_BG}; background-size: 8px 8px; overflow: hidden; border: 1px solid rgba(0,0,0,0.15);"
      >
        <div style="width: 100%; height: 100%; background: {dual.dark};"></div>
      </div>
    </button>
  </div>

  <!-- Dual Toolbar: Same in both toggle and Derive button -->
  <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #cbd5e1;">
    <label style="display: flex; align-items: center; gap: 6px; cursor: {disabled ? 'not-allowed' : 'pointer'}; user-select: none;">
      <input
        type="checkbox"
        checked={sameInBoth}
        onchange={(e) => handleToggleSameInBoth(e.currentTarget.checked)}
        {disabled}
        style="margin: 0; cursor: {disabled ? 'not-allowed' : 'pointer'};"
      />
      Same in both
    </label>

    <button
      type="button"
      onclick={handleDerive}
      {disabled}
      title="Automatically derive the opposing scheme colour preserving contrast"
      style="padding: 2px 8px; font-size: 11px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #cbd5e1; cursor: {disabled ? 'not-allowed' : 'pointer'};"
    >
      Derive {activeScheme === 'light' ? 'Dark' : 'Light'}
    </button>
  </div>

  <!-- Embedded Headless ColorPicker for the active scheme side -->
  <ColorPicker
    value={activeColor}
    onchange={handleInnerChange}
    contrastAgainst={activeContrastTarget}
    {alpha}
    {swatches}
    {disabled}
    ongesturestart={triggerGestureStart}
    ongestureend={triggerGestureEnd}
  />

  <!-- Optional Dual Contrast Badge Summary -->
  {#if dualContrast}
    <div
      style="display: flex; gap: 8px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px;"
    >
      <div style="flex: 1; display: flex; justify-content: space-between; align-items: center;">
        <span style="color: #8c95a6;">Light:</span>
        <span
          style="padding: 1px 4px; border-radius: 3px; font-weight: 600; font-family: monospace; background: {dualContrast.light.level === 'fail' ? '#7f1d1d' : '#14532d'}; color: {dualContrast.light.level === 'fail' ? '#fca5a5' : '#86efac'};"
        >
          {dualContrast.light.ratio}:1 ({dualContrast.light.level.toUpperCase()})
        </span>
      </div>
      <div style="flex: 1; display: flex; justify-content: space-between; align-items: center;">
        <span style="color: #8c95a6;">Dark:</span>
        <span
          style="padding: 1px 4px; border-radius: 3px; font-weight: 600; font-family: monospace; background: {dualContrast.dark.level === 'fail' ? '#7f1d1d' : '#14532d'}; color: {dualContrast.dark.level === 'fail' ? '#fca5a5' : '#86efac'};"
        >
          {dualContrast.dark.ratio}:1 ({dualContrast.dark.level.toUpperCase()})
        </span>
      </div>
    </div>
  {/if}
</div>
