---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
'@pixerate/swift': minor
---

Add mutation paint (`mutation` facet with `settle`, `patience` and `fade`; presets `mutation-wash` and `mutation-ink`): wet or dry paint strokes that settle into a pending mutation request (`onMutationRequest`, React `useMutationRequests`, Svelte `createMutationRequestStore`), sink away when claimed by an agent via `read_mutation` (releasing held wet ghost fade or fading a temporary dry layer), and are answered by the agent's presence cursor via `answer_mutation` (or kept as ordinary paint on `decline_mutation` or timeout). Includes `createMutationTools` (`list_mutations`, `read_mutation`, `answer_mutation`, `decline_mutation`), the `pixerate-paint-mutation` workflow skill with evals, Settle / Patience / Fade brush panel controls and agent connection status in React, Svelte and Swift, and full Swift parity.
