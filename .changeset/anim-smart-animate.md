---
"@pixerate/editor": minor
---

The animation editor gains Smart Animate: the `match` command tweens a group into another group (usually hidden), part by part.

- **Pairing:** parts pair by name, then by id with the groups' own ids taken out (`card-a-title` ↔ `card-b-title`), then by kind in stacking order. Nested groups pair their own parts the same way.
- **Morphing:** each part morphs into its partner's shape, paint and place. Parts with no partner fade out.
- **Checks:** `match-unpaired` notes the parts of `into` that have no partner (they cannot appear), and `match-self` refuses a group matched into itself or into a group it holds.
- **Agents:** `matchMotionNodes` returns the pairing, and the command has an agent-tool schema.
