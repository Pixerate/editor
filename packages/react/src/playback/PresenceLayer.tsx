import React, { useSyncExternalStore } from "react";
import type { PresenceActor, PresenceStore } from "@pixerate/editor/tools";

export interface PresenceLayerProps {
  /** The cursors to draw, e.g. from `usePlaybackSurface` or a director. */
  presence: PresenceStore;
  /**
   * How surface coordinates map to this layer's pixels: a canvas viewport
   * (`x * zoom + viewport.x`), or a function. Default: one to one.
   */
  viewport?: { x: number; y: number; zoom: number } | ((point: { x: number; y: number }) => { x: number; y: number });
  /** Clip the cursors to the layer's box (default true). `false` lets a cursor visit chrome outside it. */
  clip?: boolean;
  /**
   * Draws an actor's cursor in place of the default arrow, name tag and note (a host's own
   * presence cursor). It is placed at the actor's point; the focus ring is still drawn.
   */
  renderCursor?: (actor: PresenceActor) => React.ReactNode;
  className?: string;
}

/**
 * Agent cursors with their name tag or note, and a ring around what each one works on. Place it
 * in a `position: relative` box over the surface. It has the `pixerate-presence` class, so
 * snapshots and exports leave it out.
 */
export function PresenceLayer({ presence, viewport, clip = true, renderCursor, className = "" }: PresenceLayerProps) {
  const { actors } = useSyncExternalStore(presence.subscribe, presence.getState, presence.getState);
  if (!actors.length) return null;
  const map =
    typeof viewport === "function"
      ? viewport
      : viewport
        ? (p: { x: number; y: number }) => ({ x: p.x * viewport.zoom + viewport.x, y: p.y * viewport.zoom + viewport.y })
        : (p: { x: number; y: number }) => p;
  return (
    <div
      className={`pixerate-presence ${className}`.trim()}
      aria-hidden="true"
      data-testid="presence-layer"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: clip ? "hidden" : "visible", zIndex: 50 }}
    >
      {actors.map((a) => {
        const at = map(a);
        const ring = a.focus && (() => {
          const tl = map(a.focus);
          const br = map({ x: a.focus.x + a.focus.width, y: a.focus.y + a.focus.height });
          return { left: tl.x - 4, top: tl.y - 4, width: br.x - tl.x + 8, height: br.y - tl.y + 8 };
        })();
        return (
          <React.Fragment key={a.id}>
            {ring && (
              <div
                data-actor-focus={a.id}
                style={{ position: "absolute", ...ring, borderRadius: 8, border: `2px solid ${a.color}`, background: `${a.color}14`, transition: "all 160ms ease-out" }}
              />
            )}
            <div data-actor={a.id} style={{ position: "absolute", left: 0, top: 0, transform: `translate(${at.x}px, ${at.y}px)` }}>
              {renderCursor ? renderCursor(a) : (
                <>
                  <svg width="18" height="20" viewBox="0 0 12 18" style={{ display: "block", transform: a.pressed ? "scale(0.85)" : undefined, transformOrigin: "0 0", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
                    <path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style={{ fill: a.color, stroke: "#ffffff", strokeWidth: 1 }} />
                  </svg>
                  <span style={{ position: "absolute", left: 14, top: 16, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                    <span style={{ whiteSpace: "nowrap", borderRadius: 999, padding: "1px 7px", fontSize: 11, fontWeight: 600, color: "#ffffff", background: a.color }}>{a.name}</span>
                    {a.message && (
                      <span data-actor-message={a.id} style={{ width: "max-content", maxWidth: 240, borderRadius: 8, borderTopLeftRadius: 0, padding: "4px 8px", fontSize: 12, color: "#1e293b", background: "#ffffff", boxShadow: "0 4px 12px rgba(15,23,42,.18)" }}>
                        {a.message}
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
