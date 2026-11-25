---
'@pixerate/editor': minor
---

The tool bridge protocol now works over any transport.
- **`serveToolSource(source, { name, kind })`** is the editor half: what a page announces, and how it answers and cancels calls.
- **`createRemoteToolProvider({ editors, call })`** is the bridge half: editors' tools forwarded with `editor` routing, plus `list_editors`.

Both are exported from `@pixerate/editor/tools`. For example, a server can reach a browser tab through a database relay. `connectToolBridge` and `createToolBridge` are rebuilt on them with no change in behaviour, and the protocol types move to `bridge-protocol.ts` with the same exports.
