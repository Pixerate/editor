---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector connectors: open paths whose ends are glued to other objects' sides or centres.

- Connectors follow those objects through every edit.
- Routes can be straight, elbow (with an optional bend radius) or curved. `auto` sides pick the side facing the other end.
- A Connector tool (X) shows connection sites as you draw. Settings round-trip through SVG.
- New controller methods: `addConnector`, `setConnector`, `getConnectors` and `getConnectionSites`.
- New agent commands: `vector.connect`, `vector.setConnector`, `vector.listConnectors` and `vector.listConnectionSites`.
- New `VectorConnectorPanel` components for React and Svelte.
