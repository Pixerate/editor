---
"@pixerate/editor": patch
"@pixerate/editor-svelte": patch
---

Canvas proposal ghosts now carry the `pixerate-proposal` class in Svelte Flow too. `createCanvasProposals().withGhosts` (and so `createCanvasProposalState().view`) sets both `className` (React Flow) and `class` (Svelte Flow) on ghost nodes and edges, merged with any existing value of each. React behaviour is unchanged.
