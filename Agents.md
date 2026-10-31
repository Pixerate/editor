# Agent & Contributor Guidelines (`Agents.md`)

This repository (`@pixerate/editor`) is a multi-package monorepo containing UI-agnostic core libraries, React bindings, and Svelte bindings for rich text and prompt media editing.

All AI coding assistants (including Antigravity, Claude, Cursor, Copilot) and human contributors **must strictly follow these rules**.

---

## 1. How to Commit

### Conventional Commits
All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short description>

[optional body]

[optional footer(s)]
```

#### Allowed Types:
- `feat`: A new user-facing feature or API addition
- `fix`: A bug fix
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding missing unit tests or correcting existing tests
- `docs`: Documentation updates only
- `chore`: Maintenance, dependency bumps, tooling updates
- `ci`: CI/CD workflow and release configuration updates

#### Allowed Scopes:
- `core`: Changes to `packages/core` (`@pixerate/editor`)
- `react`: Changes to `packages/react` (`@pixerate/editor-react`)
- `svelte`: Changes to `packages/svelte` (`@pixerate/editor-svelte`)
- `demo`: Changes to `apps/demo`
- `monorepo`: Root configuration, pnpm workspace, changesets

#### Examples:
```bash
git commit -m "feat(core): add nested cycle detection for template recursion"
git commit -m "fix(react): resolve caret reset issue during controlled input update"
git commit -m "test(svelte): verify reactive editable toggle in EditableTextNodeEditor"
```

### Changeset Requirement
Whenever modifying code in `packages/core`, `packages/react`, or `packages/svelte` that affects package consumers, **you must include a changeset**:

```bash
pnpm changeset
```

Select the affected packages, choose the appropriate bump level (`patch`, `minor`, `major`), and provide a clear summary of the changes. Never push library code changes without a changeset file in `.changeset/`.

---

## 2. Always Create Unit Tests

Testing is non-negotiable in this repository.

1. **Test-Driven / Verified First**: Before marking any task as complete, unit tests covering the modified or added code **must be written and passing**.
2. **Every Grammar Token Rule**: Any new token pattern, variable syntax, or instruction delimiter added to `packages/core/src/grammar` must have comprehensive tests in `packages/core/tests/grammar.test.ts`.
3. **Every Serializer**: Any change to HTML escaping, paragraph unwrapping, or clipboard parsing must have tests in `packages/core/tests/serializers.test.ts`.
4. **Run Tests Locally**: Always run:
   ```bash
   pnpm test
   ```
   Ensure all package test suites pass with 0 errors before staging or committing changes.

---

## 3. Mandatory Cross-Framework Feature Parity

Our core value proposition is **parity across JavaScript, React, and Svelte**:

1. **No Framework Favoritism**: If an extension, command, parser, or visual capability is added to `@pixerate/editor-react`, equivalent functionality **must** simultaneously be implemented or exposed in `@pixerate/editor-svelte` and `@pixerate/editor` (where applicable).
2. **Core Logic Belongs in `@pixerate/editor`**:
   - Token regexes, parsing ASTs, recursive resolution, and sourcemapping **must live only in `@pixerate/editor`**.
   - Do **NOT** duplicate tokenizer or resolution logic inside `@pixerate/editor-react` or `@pixerate/editor-svelte`. They must import it from `@pixerate/editor`.
3. **Consumer Parity Check**:
   - Ensure the React package (`@pixerate/editor-react`) maintains full backwards compatibility with `usePromptEditor` options, milestone tracking, and clipboard handling.
   - Ensure the Svelte package (`@pixerate/editor-svelte`) maintains full backwards compatibility with `EditableTextNodeEditor` props, bubble menus, and reactive store behaviors.
4. **The Parity Test**: Before opening a PR or completing a refactor, review the feature matrix in `README.md` and ensure no cell in the React or Svelte column is left behind, and that the feature has an agent path (see section 4).

---

## 4. Agent Interactions Are First-Class Citizens

AI agents are users of this library in the same way that people at a keyboard are. Every capability must work equally well for both. An agent tool is never something to add later.

1. **Ship the agent path with the feature**: Any user-facing capability, in any package, must be reachable by an agent in the same change. Expose it through a tool provider (`AgentToolProvider` registered in a `ToolRegistry`) or through a command with a `params` JSON Schema (`CommandRegistry` → `createCommandToolProvider`). A feature that only has a UI is incomplete.
2. **Design tools for a model, not for a function signature**:
   - **One tool per operation.** Do not add catch-all tools with an `operation` enum and a loose bag of optional arguments. Each tool gets a strict `inputSchema` with `required` and `additionalProperties: false`.
   - **Describe everything.** Every tool has a `title`, a `description` saying what it does and what it returns, and all four annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Every argument has a `description` with units and defaults.
   - **Close the loop.** Write tools take ids or positions that a read tool returns (e.g. `find_text` → `replace_range`). Write tools return what they created or changed (new ids, the resulting range or value), so the agent never has to guess or re-read the whole state.
   - **Fail usefully.** Validate inputs against the current state (unknown ids, out-of-range positions, read-only targets) before changing anything. Throw errors that say what is wrong and how to fix it. They become `isError` tool results the model can act on. Never apply part of a change and then fail silently.
   - **One user action = one undo step.** Bulk tools (`set_range`, `replace_text`) apply as a single history entry. Side effects that cost money or can't be reversed take an idempotency key.
   - **Respect state.** Read-only or disabled surfaces still expose their read tools and hide or refuse their write tools, with the reason.
3. **Keep the tool layer dependency-free**: `ToolRegistry`, `validateJsonSchema`, the static tool definitions and `createMcpServer` live in `packages/core/src/tools` and must not import TipTap, ProseMirror, dagre or any framework (`tests/entry-isolation.test.ts` enforces this). Providers that need those live next to their feature or in `src/agent`.
4. **Parity applies to agents too**: React and Svelte expose providers through `useAgentToolProvider`. The demo tab for a feature must register its providers so they show in its agent-tools panel.
5. **Test it like a user would**: Every new tool needs tests that call it through `ToolRegistry.callTool` with valid and invalid arguments and check the result shape and error messages. Add new providers to the conformance test in `packages/core/tests/command-tools.test.ts`. It fails when a tool is missing a title, an annotation, or an argument description.
6. **Keep the domain's agent skills current**: Each editor domain ships a **reference skill** at `packages/core/skills/<skill>/SKILL.md` (see [`packages/core/skills/README.md`](./packages/core/skills/README.md)) that tells a model when and how to use each of its tools and the best practice of the domain. Some jobs also have a **workflow skill** (`pixerate-<editor>-<job>`), which covers that job from start to finish on the reference skill's tools. A tool or workflow is not done until its skills are updated in the same change:
   - **New, renamed or removed tool or command**: add, rename or remove its row in the skill's tool table (first cell is the backticked name), saying when to use it, what it returns, and what to call before or after.
   - **New workflow or changed best practice** (a new batch or check tool, a better default, a new import / export path): update the skill's working method, best practices and pitfalls, not only the table.
   - **New tool provider, command factory or editor domain**: map it in `expectedBySkill()` and `FACTORIES` in `packages/core/tests/agent-skills.test.ts`, and add a new skill directory (and a row in `skills/README.md`) for a new domain.
   - **Workflow skills built on the tools you changed**: each reference skill lists its workflow skills under `## Workflow skills`. When a new or changed tool changes the best way to do one of those jobs (a better selection method, a new check), update that workflow skill's method, decision table and `## Tools used`, and its evals if the outcome changes. A new workflow skill starts from `skills/WORKFLOW_TEMPLATE.md`, ships at least three evals in `evals/*.json`, and is mapped in `WORKFLOWS` in the test.
   - `tests/agent-skills.test.ts` fails when a skill misses a tool, lists one that no longer exists, or a factory is unmapped, and when a workflow skill names a tool that does not exist or is missing from the README or its reference skill. `tests/agent-skill-evals.test.ts` proves each eval against its known-good solution. Neither can check advice, so reread the skills' prose whenever behaviour changes.

---

## 5. Maintain and Check `GOTCHAS.md`

All agents and contributors must consult and maintain [`GOTCHAS.md`](./GOTCHAS.md):

1. **Check Before Starting Work**: Always review `GOTCHAS.md` before beginning any task to be aware of known issues, framework quirks, and existing workarounds in the codebase.
2. **Populate with New Findings**: Whenever you encounter, diagnose, or resolve a tricky bug, pitfall, unexpected behavior, or framework-specific edge case (e.g., ProseMirror, React, Svelte, Tailwind, or bundling quirks), document it in `GOTCHAS.md`.
3. **Include Solutions and Workarounds**: Every entry must clearly describe:
   - **Issue / Symptom**: What goes wrong.
   - **Root Cause**: Why it occurs.
   - **Solution / Workaround**: How to fix it or work around it safely.

---

## 6. Build and Verification Checklist

Before pushing changes:
```bash
# 1. Typecheck and build all workspace packages
pnpm build

# 2. Run all unit tests
pnpm test

# 3. Verify demo app compiles and runs
pnpm --filter demo build

# 4. Check that new capabilities have agent tools (section 4), with tests,
#    and that the domain's packages/core/skills/<skill>/SKILL.md describes them

# 5. Record any newly discovered pitfalls or workarounds in GOTCHAS.md
```
