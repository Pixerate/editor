---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Generation records and Recreate, and asset mentions with roles.

- Core (`/generation`): `createGenerationRecord` (built on provenance, plus template/capability/prompt hashes, original settings, seed, assets with roles and content hashes, lineage). `recreateRequest(record, { templates, capabilities, assets, mode: "exact" | "latest" })` returns the re-planned request and a drift report (template changed/deleted, model missing/changed, setting unsupported/changed, asset missing/changed). Also adds `variationRequest`, `createGenerationRecordStore` on the persistence storage adapters (filter by model/template/asset/role, prune, subscribe), and `hashText` / `hashCapabilities`. `recreateRequest(provenance)` keeps its old behaviour.
- Roles are extensible: models may declare custom roles. Each role can list accepted media (`accepts`). Aliases such as `style` and `start-frame` map to built-in roles. `planGenerationRequest` accepts `mentions` and validates them per role. `validateAssetMentions`, `describeAssetMentions` and `getAssetRoleOptions` are new. Agent schemas list custom roles and `mediaType`.
- Mentions: opt-in `@handle:role` text syntax (`extractMentions(text, { details: true, roles: true })`, `preprocessMarkdownMentions(…, { roles })`). `findTextMentions` and `setMentionRoleInText` are new. The Mention node has an `assetRole` attribute (`data-role`), with `setMentionRoleAt` / `getMentionNodes`. `htmlToPlainText` writes `@label:role`. Output without roles is unchanged.
- React and Svelte: `<AssetMentionChips>` (role badges, role picker popover), `<GenerationHistory>` (drift report, Recreate exact/latest, Variation), `useGenerationRecords` / `createGenerationRecords`.
