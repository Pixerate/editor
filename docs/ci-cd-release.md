# CI/CD and npm OIDC Release Workflow

This repository uses automated continuous integration and continuous delivery on GitHub Actions, running **Node.js 24**, **pnpm**, **Changesets**, and **npm Trusted Publishing via OpenID Connect (OIDC)**.

---

## Workflows Overview

```
.github/workflows/
├── ci.yml        # Triggered on pull requests and pushes to main: lints, tests, builds
└── release.yml   # Triggered on pushes to main: opens version PR or publishes to npm via OIDC
```

---

## 1. CI Workflow (`.github/workflows/ci.yml`)

Runs on:
- Every Pull Request targeting `main`
- Every direct push to `main`

### Matrix and Steps:
- **Runner**: `ubuntu-latest`
- **Node**: `24`
- **Package Manager**: `pnpm` (latest)
- **Steps**:
  1. Checkout repository with `actions/checkout@v7`
  2. Setup pnpm with `pnpm/action-setup@v6`
  3. Setup Node.js 24 with caching via `actions/setup-node@v7`
  4. `pnpm install --frozen-lockfile`
  5. On pull requests, fail if no changeset is pending
  6. `pnpm build` (compiles all library packages and the demo app on Node's default heap, and writes the build's peak memory to the job summary)
  7. `pnpm check:packages` (packs the three packages, type-checks a consumer of every subpath with `bundler`, `node16` ESM and `node16` CommonJS resolution, and imports every core and React subpath in Node; Release runs it too, before publishing)
  8. `pnpm typecheck`
  9. `pnpm test` (all Vitest suites across core, react, svelte and the demo)

---

## 2. Release Workflow (`.github/workflows/release.yml`)

Runs on:
- Push to `main` branch

### Automatic Version Bumping & Publishing
The release workflow is managed by `@changesets/action`:

1. **When Changesets are Pending**:
   - The action creates or updates an automated Pull Request: `"Version Packages"`.
   - The PR bumps versions in `package.json` according to the changeset semver rules and generates `CHANGELOG.md` entries.
2. **When the Version PR is Merged**:
   - The workflow detects bumped versions and runs:
     ```bash
     pnpm changeset publish --provenance --access public
     ```
   - All packages (`@pixerate/editor`, `@pixerate/editor-react`, `@pixerate/editor-svelte`) are published to the npm registry with cryptographically verifiable provenance.

---

## 3. npm Trusted Publishing (OIDC) Setup

This project uses npm's modern OpenID Connect (OIDC) Trusted Publishing mechanism, **eliminating the need for static, high-risk `NPM_TOKEN` secrets**.

### GitHub Workflow Configuration:
The workflow job declares explicit permissions:

```yaml
permissions:
  contents: write
  id-token: write
  pull-requests: write
```

- `id-token: write`: Authorizes GitHub Actions to generate a temporary OIDC JWT.
- `contents: write`: Allows changesets action to push tags and releases.
- `pull-requests: write`: Allows opening and updating the Version Packages PR.

### One-Time npm Configuration on npmjs.com:
1. Log into [npmjs.com](https://www.npmjs.com/) with the publisher account.
2. Navigate to each package settings (`@pixerate/editor`, `@pixerate/editor-react`, `@pixerate/editor-svelte`).
3. Click **Publishing access** -> **Add GitHub Actions**.
4. Configure:
   - **GitHub organization / user**: `Pixerate`
   - **Repository name**: `editor`
   - **Branch**: `main`
   - **Workflow filename**: `release.yml`
5. Save. The workflow can now publish securely using `--provenance` without any static token stored in GitHub repository secrets!

---

## Demo deployment (`demo.yml`)

`.github/workflows/demo.yml` builds `apps/demo` against the workspace packages and publishes it to GitHub Pages at **https://pixerate.github.io/editor/**.

- **When:** on pushes to `main` that touch `apps/demo/**`, `packages/**`, `pnpm-lock.yaml` or the workflow itself, and on demand from the Actions tab (`workflow_dispatch`).
- **Base path:** project pages are served from `/<repo>/`, so the workflow builds with `DEMO_BASE=/<repo>/`, which `apps/demo/vite.config.ts` uses as Vite's `base`. Locally `base` stays `/`. The demo uses hash links (`#sheet`, `#canvas`, …), so no 404 fallback is needed.
- **Permissions:** `pages: write` and `id-token: write` for `actions/deploy-pages`; deployments share one `pages` concurrency group and never cancel one in progress.

### One-time GitHub configuration

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. Until then the deploy job fails with "Pages site not found". After the first run, the `github-pages` environment shows the live URL.

To preview the Pages build locally:

```bash
pnpm --filter "./packages/*" build
cd apps/demo && DEMO_BASE=/editor/ npx vite build && DEMO_BASE=/editor/ npx vite preview
```

Then open http://localhost:4173/editor/.
