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
  1. Checkout repository with `actions/checkout@v4`
  2. Setup pnpm with `pnpm/action-setup@v4`
  3. Setup Node.js 24 with caching via `actions/setup-node@v4`
  4. `pnpm install --frozen-lockfile`
  5. `pnpm test` (Runs all Vitest suites across core, react, and svelte packages)
  6. `pnpm build` (Compiles all library packages and demo app)

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
