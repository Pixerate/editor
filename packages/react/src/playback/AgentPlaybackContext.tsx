import React, { createContext, useContext } from "react";
import type { AgentPlayback } from "@pixerate/editor/tools";

const AgentPlaybackContext = createContext<AgentPlayback | null>(null);

/** Makes `playback` the default for every editor surface below it (`useAgentPlayback`). */
export function AgentPlaybackProvider({ playback, children }: { playback: AgentPlayback | null | undefined; children?: React.ReactNode }) {
  return <AgentPlaybackContext.Provider value={playback ?? null}>{children}</AgentPlaybackContext.Provider>;
}

/** The nearest `AgentPlaybackProvider`'s playback, or `null`. */
export function useAgentPlayback(): AgentPlayback | null {
  return useContext(AgentPlaybackContext);
}
