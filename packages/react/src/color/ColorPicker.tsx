import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type ColorPickerState,
  contrastRatio,
  contrastLevel,
  formatHex,
  inSrgbGamut,
  parseColor,
  pickerAlphaBackground,
  pickerAreaBackground,
  pickerKeyStep,
  pickerStateFromAlpha,
  pickerStateFromArea,
  pickerStateFromColor,
  pickerStateFromHue,
  pickerStateToHex,
  pushRecentColor,
  PICKER_HUE_BACKGROUND,
} from "@pixerate/editor/color";

export interface ColorPickerProps {
  /** The current colour value (any valid CSS colour string or hex). */
  value: string;
  /** Called when the colour value changes. */
  onChange: (value: string) => void;
  /** Called when a continuous pointer drag or keyboard interaction starts. */
  onGestureStart?: () => void;
  /** Called when a continuous pointer drag or keyboard interaction ends. */
  onGestureEnd?: () => void;
  /** Whether the alpha channel slider is shown and alpha hex values emitted. Default: false. */
  alpha?: boolean;
  /** Palette swatches shown beneath the sliders. */
  swatches?: readonly string[];
  /** Controlled recent colours. If omitted, internal recents persisted in localStorage are used. */
  recent?: readonly string[];
  /** Called when the list of recent colours changes. */
  onRecentChange?: (recent: readonly string[]) => void;
  /** If provided, renders live WCAG contrast ratio badges against this background colour. */
  contrastAgainst?: string;
  /** Whether the picker is disabled. */
  disabled?: boolean;
  /** Additional CSS class names for the outer container. */
  className?: string;
  /** Optional DOM id for the container. */
  id?: string;
  /** Accessible label for the colour picker group. */
  "aria-label"?: string;
}

const LOCAL_STORAGE_KEY = "pixerate:color:recent";

function readLocalRecents(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalRecents(list: readonly string[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
    }
  } catch {}
}

/** Transparency checkerboard; themeable through `--pixerate-checker-a` / `--pixerate-checker-b`. */
const CHECKERBOARD_BG =
  "repeating-conic-gradient(var(--pixerate-checker-a, #d4d4d8) 0 25%, var(--pixerate-checker-b, #ffffff) 0 50%)";

const DEFAULT_PICKER_STATE: ColorPickerState = { h: 0, s: 1, v: 1, alpha: 1 };

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  onGestureStart,
  onGestureEnd,
  alpha = false,
  swatches,
  recent: controlledRecent,
  onRecentChange,
  contrastAgainst,
  disabled = false,
  className,
  id,
  "aria-label": ariaLabel = "Color picker",
}) => {
  const generatedId = useId();
  const pickerId = id || generatedId;

  // Track picker HSV state with hue/sat memory
  const [pickerState, setPickerState] = useState<ColorPickerState>(
    () => pickerStateFromColor(value) ?? DEFAULT_PICKER_STATE,
  );
  const stateRef = useRef(pickerState);
  stateRef.current = pickerState;

  // Synchronise pickerState when external `value` changes
  useEffect(() => {
    const next = pickerStateFromColor(value, stateRef.current);
    if (next) {
      setPickerState(next);
    }
  }, [value]);

  // Recents management
  const [internalRecent, setInternalRecent] = useState<string[]>(() =>
    controlledRecent ? [] : readLocalRecents(),
  );
  const activeRecent = controlledRecent ?? internalRecent;

  const recordRecent = useCallback(
    (color: string) => {
      const updated = pushRecentColor(activeRecent, color, 12);
      if (!controlledRecent) {
        setInternalRecent(updated);
        writeLocalRecents(updated);
      }
      onRecentChange?.(updated);
    },
    [activeRecent, controlledRecent, onRecentChange],
  );

  // Text input local state
  const [textDraft, setTextDraft] = useState<string>(value);
  const [isInvalid, setIsInvalid] = useState(false);
  const [isClipped, setIsClipped] = useState(false);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!isTypingRef.current) {
      setTextDraft(value);
      setIsInvalid(false);
      const parsed = parseColor(value);
      setIsClipped(Boolean(parsed && !inSrgbGamut(parsed)));
    }
  }, [value]);

  // EyeDropper API check
  const [hasEyeDropper, setHasEyeDropper] = useState(false);
  useEffect(() => {
    setHasEyeDropper(typeof window !== "undefined" && "EyeDropper" in window);
  }, []);

  const emitColorChange = useCallback(
    (nextState: ColorPickerState) => {
      setPickerState(nextState);
      const hex = pickerStateToHex(nextState, alpha);
      onChange(hex);
    },
    [alpha, onChange],
  );

  // Pointer drags: listeners live on window and are removed on pointerup, or on unmount,
  // which also ends the host's gesture so it never stays open.
  const latest = useRef({ emitColorChange, recordRecent, onGestureEnd, alpha });
  latest.current = { emitColorChange, recordRecent, onGestureEnd, alpha };
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    next: (state: ColorPickerState, x: number, y: number) => ColorPickerState,
  ) => {
    if (disabled) return;
    e.preventDefault();
    endDragRef.current?.();
    onGestureStart?.();

    const rect = e.currentTarget.getBoundingClientRect();
    const update = (clientX: number, clientY: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      latest.current.emitColorChange(next(stateRef.current, x, y));
    };
    update(e.clientX, e.clientY);

    const onPointerMove = (ev: PointerEvent) => update(ev.clientX, ev.clientY);
    const end = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      endDragRef.current = null;
      latest.current.onGestureEnd?.();
    };
    const onPointerUp = () => {
      end();
      latest.current.recordRecent(pickerStateToHex(stateRef.current, latest.current.alpha));
    };
    endDragRef.current = end;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  const handleAreaPointerDown = (e: React.PointerEvent<HTMLDivElement>) =>
    startDrag(e, (state, x, y) => pickerStateFromArea(state, x, y));
  const handleHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) =>
    startDrag(e, (state, x) => pickerStateFromHue(state, x));
  const handleAlphaPointerDown = (e: React.PointerEvent<HTMLDivElement>) =>
    startDrag(e, (state, x) => pickerStateFromAlpha(state, x));

  // Keyboard navigation
  const handleAreaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, "area", e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      emitColorChange(next);
      recordRecent(pickerStateToHex(next, alpha));
    }
  };

  const handleHueKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, "hue", e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      emitColorChange(next);
      recordRecent(pickerStateToHex(next, alpha));
    }
  };

  const handleAlphaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, "alpha", e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      emitColorChange(next);
      recordRecent(pickerStateToHex(next, alpha));
    }
  };

  // Text input commit & revert
  const commitTextInput = (inputElement?: HTMLInputElement) => {
    isTypingRef.current = false;
    const parsed = parseColor(textDraft);
    if (parsed) {
      setIsInvalid(false);
      setIsClipped(!inSrgbGamut(parsed));
      const formatted = formatHex(parsed);
      onChange(formatted);
      recordRecent(formatted);
    } else {
      setIsInvalid(true);
      setTextDraft(value);
      if (inputElement) {
        inputElement.value = value;
      }
    }
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitTextInput(e.currentTarget);
    } else if (e.key === "Escape") {
      e.preventDefault();
      isTypingRef.current = false;
      setIsInvalid(false);
      setTextDraft(value);
      e.currentTarget.value = value;
    }
  };

  // EyeDropper activation
  const handleEyeDropper = async () => {
    if (disabled || !hasEyeDropper) return;
    try {
      const EyeDropperClass = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const eyeDropper = new EyeDropperClass();
      const res = await eyeDropper.open();
      if (res?.sRGBHex) {
        onChange(res.sRGBHex);
        recordRecent(res.sRGBHex);
      }
    } catch {
      // User cancelled or aborted
    }
  };

  // Contrast calculations
  const contrastResult = useMemo(() => {
    if (!contrastAgainst) return null;
    const fg = parseColor(value);
    const bg = parseColor(contrastAgainst);
    if (!fg || !bg) return null;
    const ratio = contrastRatio(fg, bg);
    const aa = ratio >= 4.5;
    const aaa = ratio >= 7;
    return { ratio, aa, aaa };
  }, [value, contrastAgainst]);

  const currentHex = pickerStateToHex(pickerState, alpha);
  const liveDescription = `Selected color: ${value}${
    contrastResult
      ? `, contrast ${contrastResult.ratio.toFixed(1)}:1 against ${contrastAgainst}, ${
          contrastResult.aa ? "passes AA" : "fails AA"
        }`
      : ""
  }`;

  return (
    <div
      id={pickerId}
      role="group"
      aria-label={ariaLabel}
      className={className}
      style={{
        boxSizing: "border-box",
        width: "var(--pixerate-color-picker-width, 240px)",
        borderRadius: "var(--pixerate-color-picker-radius, 8px)",
        background: "var(--pixerate-color-picker-bg, #1f2430)",
        color: "var(--pixerate-color-picker-fg, #f0f2f5)",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: "12px",
        userSelect: "none",
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      {/* Live region for accessibility announcements */}
      <span
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveDescription}
      </span>

      {/* 2D Area: Saturation and Brightness */}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(pickerState.s * 100)}%, Brightness ${Math.round(
          pickerState.v * 100,
        )}%`}
        aria-disabled={disabled}
        onPointerDown={handleAreaPointerDown}
        onKeyDown={handleAreaKeyDown}
        style={{
          position: "relative",
          width: "100%",
          height: "150px",
          borderRadius: "6px",
          background: pickerAreaBackground(pickerState),
          cursor: disabled ? "default" : "crosshair",
          touchAction: "none",
          outline: "none",
        }}
      >
        {/* Thumb */}
        <div
          style={{
            position: "absolute",
            width: "var(--pixerate-color-picker-thumb-size, 14px)",
            height: "var(--pixerate-color-picker-thumb-size, 14px)",
            borderRadius: "50%",
            transform: "translate(-50%, -50%)",
            left: `${pickerState.s * 100}%`,
            top: `${(1 - pickerState.v) * 100}%`,
            border: "2px solid #ffffff",
            boxShadow: "0 0 2px 1px rgba(0,0,0,0.6)",
            pointerEvents: "none",
            backgroundColor: currentHex,
          }}
        />
      </div>

      {/* Hue Slider */}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Hue"
        aria-valuenow={Math.round(pickerState.h)}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuetext={`${Math.round(pickerState.h)} degrees`}
        aria-disabled={disabled}
        onPointerDown={handleHuePointerDown}
        onKeyDown={handleHueKeyDown}
        style={{
          position: "relative",
          width: "100%",
          height: "12px",
          borderRadius: "6px",
          background: PICKER_HUE_BACKGROUND,
          cursor: disabled ? "default" : "pointer",
          touchAction: "none",
          outline: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            transform: "translate(-50%, -50%)",
            left: `${(pickerState.h / 360) * 100}%`,
            width: "var(--pixerate-color-picker-thumb-size, 14px)",
            height: "var(--pixerate-color-picker-thumb-size, 14px)",
            borderRadius: "50%",
            border: "2px solid #ffffff",
            boxShadow: "0 0 2px 1px rgba(0,0,0,0.6)",
            pointerEvents: "none",
            backgroundColor: `hsl(${pickerState.h}, 100%, 50%)`,
          }}
        />
      </div>

      {/* Alpha Slider (conditional) */}
      {alpha && (
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Alpha"
          aria-valuenow={Math.round(pickerState.alpha * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${Math.round(pickerState.alpha * 100)}%`}
          aria-disabled={disabled}
          onPointerDown={handleAlphaPointerDown}
          onKeyDown={handleAlphaKeyDown}
          style={{
            position: "relative",
            width: "100%",
            height: "12px",
            borderRadius: "6px",
            backgroundImage: CHECKERBOARD_BG,
            backgroundSize: "8px 8px",
            cursor: disabled ? "default" : "pointer",
            touchAction: "none",
            outline: "none",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: pickerAlphaBackground(pickerState),
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "50%",
              transform: "translate(-50%, -50%)",
              left: `${pickerState.alpha * 100}%`,
              width: "var(--pixerate-color-picker-thumb-size, 14px)",
              height: "var(--pixerate-color-picker-thumb-size, 14px)",
              borderRadius: "50%",
              border: "2px solid #ffffff",
              boxShadow: "0 0 2px 1px rgba(0,0,0,0.6)",
              pointerEvents: "none",
              backgroundColor: currentHex,
            }}
          />
        </div>
      )}

      {/* Controls row: Swatch preview, Text Input, EyeDropper, Gamut Warning */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "2px" }}>
        {/* Preview swatch with checkerboard */}
        <div
          style={{
            position: "relative",
            width: "28px",
            height: "28px",
            borderRadius: "4px",
            backgroundImage: CHECKERBOARD_BG,
            backgroundSize: "8px 8px",
            overflow: "hidden",
            flexShrink: 0,
            border: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: currentHex,
            }}
          />
        </div>

        {/* Text Field */}
        <input
          type="text"
          value={textDraft}
          disabled={disabled}
          aria-label="Color hex or CSS string"
          aria-invalid={isInvalid ? "true" : undefined}
          onChange={(e) => {
            isTypingRef.current = true;
            setTextDraft(e.target.value);
            setIsInvalid(false);
          }}
          onKeyDown={handleTextKeyDown}
          onBlur={(e) => commitTextInput(e.currentTarget)}
          style={{
            flex: 1,
            minWidth: 0,
            height: "28px",
            padding: "0 8px",
            fontSize: "12px",
            fontFamily: "monospace",
            borderRadius: "4px",
            border: isInvalid ? "1px solid #ef4444" : "1px solid rgba(255,255,255,0.2)",
            background: "rgba(0,0,0,0.2)",
            color: "inherit",
            outline: "none",
          }}
        />

        {/* EyeDropper button */}
        {hasEyeDropper && (
          <button
            type="button"
            disabled={disabled}
            aria-label="Pick color from screen"
            title="Pick color from screen"
            onClick={handleEyeDropper}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "28px",
              height: "28px",
              borderRadius: "4px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "transparent",
              color: "inherit",
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m19 11-8-8-8.5 8.5a2.12 2.12 0 0 0 0 3l2.5 2.5 1.5-1.5" />
              <path d="m5 16-3 3 1 1 3-3" />
              <path d="m14 6 4 4" />
            </svg>
          </button>
        )}
      </div>

      {/* Gamut clipping warning */}
      {isClipped && (
        <div
          role="note"
          title="This colour was outside standard sRGB and clipped."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "10px",
            color: "#f59e0b",
            background: "rgba(245, 158, 11, 0.1)",
            padding: "2px 6px",
            borderRadius: "4px",
            alignSelf: "flex-start",
          }}
        >
          <span>⚠ Clipped to sRGB</span>
        </div>
      )}

      {/* Contrast badge */}
      {contrastResult && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "11px",
            padding: "4px 8px",
            borderRadius: "4px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <span>
            Contrast: <strong>{contrastResult.ratio.toFixed(2)}:1</strong>
          </span>
          <div style={{ display: "flex", gap: "6px" }}>
            <span
              style={{
                color: contrastResult.aa ? "#10b981" : "#ef4444",
                fontWeight: 600,
              }}
            >
              AA {contrastResult.aa ? "✓" : "✗"}
            </span>
            <span
              style={{
                color: contrastResult.aaa ? "#10b981" : "#ef4444",
                fontWeight: 600,
              }}
            >
              AAA {contrastResult.aaa ? "✓" : "✗"}
            </span>
          </div>
        </div>
      )}

      {/* Palette Swatches */}
      {swatches && swatches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: "10px", textTransform: "uppercase", opacity: 0.6 }}>
            Palette
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {swatches.map((color, idx) => (
              <button
                key={`${color}-${idx}`}
                type="button"
                data-testid="color-picker-swatch"
                title={color}
                disabled={disabled}
                aria-label={`Color ${color}`}
                onClick={() => {
                  onChange(color);
                  recordRecent(color);
                }}
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "3px",
                  backgroundColor: color,
                  border: color.toLowerCase() === value.toLowerCase() ? "2px solid #ffffff" : "1px solid rgba(255,255,255,0.2)",
                  cursor: disabled ? "default" : "pointer",
                  padding: 0,
                  outline: "none",
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent Colours */}
      {activeRecent.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: "10px", textTransform: "uppercase", opacity: 0.6 }}>
            Recent
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {activeRecent.map((color, idx) => (
              <button
                key={`recent-${color}-${idx}`}
                type="button"
                data-testid="color-picker-recent"
                disabled={disabled}
                aria-label={`Color ${color}`}
                onClick={() => {
                  onChange(color);
                  recordRecent(color);
                }}
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "3px",
                  backgroundColor: color,
                  border: color.toLowerCase() === value.toLowerCase() ? "2px solid #ffffff" : "1px solid rgba(255,255,255,0.2)",
                  cursor: disabled ? "default" : "pointer",
                  padding: 0,
                  outline: "none",
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
