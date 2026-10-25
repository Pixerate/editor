import { useSyncExternalStore } from 'react';
import type { EffectAuthoringSession, EffectAuthoringState } from '@pixerate/editor/effects';

/**
 * Subscribes a React component to the observable state of an effect authoring session.
 * Re-renders only when the session's state changes. Returns null when session is null.
 */
export function useEffectAuthoring(session: EffectAuthoringSession | null): EffectAuthoringState | null {
  return useSyncExternalStore(
    (callback) => {
      if (!session) return () => {};
      return session.subscribe(callback);
    },
    () => (session ? session.getState() : null),
    () => null,
  );
}
