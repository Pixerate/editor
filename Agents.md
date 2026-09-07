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
4. **The Parity Test**: Before opening a PR or completing a refactor, review the feature matrix in `README.md` and ensure no cell in the React or Svelte column is left behind.

---

## 4. Build and Verification Checklist

Before pushing changes:
```bash
# 1. Typecheck and build all workspace packages
pnpm build

# 2. Run all unit tests
pnpm test

# 3. Verify demo app compiles and runs
pnpm --filter demo build
```
