# Release — CI, Versioning, Distribution


The skill so far takes a CLI from its first command to a `bin` entry. This is the ship-it step. It comes down to two decisions:

1. **Distribution** — how users get the CLI: an npm package, a standalone binary, or both.
2. **Versioning** — how the version bumps and the changelog get produced: Changesets or release-please.

Make those two calls, then wire up CI. This skill ships ready-to-copy GitHub Actions files in [`workflows/`](workflows/) — pick the ones that match your decisions, drop them in `.github/workflows/`, and adjust the placeholders.


## Decision 1 — Distribution

### npm package

Publish to the npm registry so users run `npm i -g my-cli`, `npx my-cli`, or add it as a dependency.

- **For:** users who already have Node; CLIs meant to be composed into Node projects or run via `npx`.
- **Needs:** a `bin` field in `package.json` (see [sidecar-setup](sidecar-setup.md)), a build to `dist/`, and `npm publish` (driven by your versioning tool).
- **Trade-off:** the user needs a Node/Bun runtime installed. Startup pays Node's boot cost.

### Single binary (`bun build --compile`)

Compile a standalone executable with the Bun runtime embedded. The target machine needs nothing installed.

    bun build --compile src/cli.ts --outfile dist/my-cli

- **For:** users who may not have Node; `curl … | sh` installs; fast cold start; distributing to ops/non-JS teams.
- **Needs:** a cross-compile matrix, checksums, a GitHub Release to host the assets, and an `install.sh` (all provided as artifacts below).
- **Trade-off:** large files (the runtime ships with each binary); you build and host per-platform assets yourself.

Cross-compile from a single runner with `--target`:

| Platform | `--target` | Output name |
|----------|------------|-------------|
| macOS arm64 | `bun-darwin-arm64` | `my-cli-darwin-arm64` |
| macOS x64 | `bun-darwin-x64` | `my-cli-darwin-x64` |
| Linux x64 | `bun-linux-x64` | `my-cli-linux-x64` |
| Linux arm64 | `bun-linux-arm64` | `my-cli-linux-arm64` |
| Windows x64 | `bun-windows-x64` | `my-cli-windows-x64.exe` |

### Both (the common adoption choice)

Ship the npm package *and* attach binaries to the same release. The Node crowd gets `npx`; everyone else gets `curl … | sh`. Most CLIs that want broad adoption do this — it's one extra job in the release workflow (the `build-binaries` job in [`release-changesets.yml`](workflows/release-changesets.yml) is exactly that follow-on).


## Decision 2 — Versioning

Two tools own "bump the version, write the changelog, cut the tag." They differ mainly in *where the release intent comes from*.

| | Changesets | release-please |
|--|-----------|----------------|
| Where intent lives | a `.changeset/*.md` file you write per PR | your conventional-commit messages |
| Changelog | you hand-write each entry | generated from commit subjects |
| Multi-package monorepo | first-class (per-package bumps) | supported, more config |
| Ceremony per change | one `bunx changeset` prompt | none — just commit `feat:` / `fix:` |
| Natural fit | npm publishing, editorial release notes | single package, binary or one npm package |

**Choose Changesets when** you have a monorepo or multiple packages, you publish to npm, or you want editorial control over what each release's notes say (a human writes them).

**Choose release-please when** you have a single package, your team already writes conventional commits, and you want the changelog derived automatically with zero per-PR ceremony — a good fit when the deliverable is mainly a binary or one npm package.

### Setting up Changesets

1. Initialize:

        bunx changeset init

    This writes `.changeset/config.json`. The fields that matter:

    ```json
    {
        "access": "public",
        "baseBranch": "main",
        "updateInternalDependencies": "patch",
        "commit": false,
        "fixed": [["@myorg/cli", "@myorg/sdk"]]
    }
    ```

    - `access: "public"` — npm defaults scoped packages to restricted; this publishes them publicly.
    - `fixed` — packages listed together always bump to the same version (drop it for a single package).
    - `updateInternalDependencies` — how to bump internal dependency ranges on release.

2. Add the driver scripts to `package.json`:

    ```json
    {
        "scripts": {
            "changeset": "changeset",
            "version": "changeset version",
            "release": "bun run build && changeset publish"
        }
    }
    ```

    - `changeset version` consumes the pending `.changeset/*.md` files, bumps versions, writes `CHANGELOG.md`, and deletes the consumed files.
    - `changeset publish` publishes every package whose version is ahead of the registry and creates git tags.

3. **Per change**, run `bunx changeset`, pick the bump type, and write the summary. It produces a file like:

    ```md
    ---
    "@myorg/cli": patch
    ---

    Add `--json` flag to the status command
    ```

    These accumulate across PRs; the release workflow consumes them all at once.

4. **Prerelease / alpha mode.** To cut `x.y.z-alpha.N` versions under a separate npm dist-tag, enter pre mode once:

        bunx changeset pre enter alpha

    This writes `.changeset/pre.json`. While it exists, `changeset version` produces `1.0.0-alpha.3` and `changeset publish` ships under the `alpha` dist-tag — so `npm i my-cli` still resolves the latest *stable* and only `npm i my-cli@alpha` pulls the prerelease. Leave pre mode before a stable cut:

        bunx changeset pre exit

### Setting up release-please

1. Add two files at the repo root.

    `release-please-config.json`:

    ```json
    {
        "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
        "packages": {
            ".": {
                "release-type": "node",
                "bump-minor-pre-major": true,
                "include-v-in-tag": true,
                "changelog-path": "CHANGELOG.md"
            }
        }
    }
    ```

    `release-please-manifest.json` (the current version; release-please updates it):

    ```json
    { ".": "0.1.0" }
    ```

    - `bump-minor-pre-major: true` — while < 1.0, a breaking change bumps the *minor*, not the major.
    - `include-v-in-tag: true` — tags look like `v0.2.0`.

2. **How it runs.** On every push to the default branch, the action reads commits since the last release and maps them: `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major (or minor while pre-1.0). It opens or updates a **release PR** carrying the computed version and CHANGELOG. Merging that PR creates the tag and GitHub Release. No changeset files to author — the commit messages are the source of truth, so enforce conventional commits in review.


## What CI needs to do

Two pipelines, two triggers:

1. **The gate** — on every push and PR. Install → lint → typecheck → build → test. Nothing releases until this is green. Order it cheapest-first so a lint error fails in seconds instead of after the test run. Use a frozen lockfile so CI can't silently resolve a different dependency tree than the commit. See [`ci.yml`](workflows/ci.yml).

2. **The release** — on push to the default branch. Run the versioning tool (Changesets or release-please). When it reports that a release actually happened, do the distribution work: publish to npm and/or compile binaries and attach them to the GitHub Release.

The release job must key the binary build off the versioning step's **output**, not off a tag-push event:

<constraints>

A tag pushed by `GITHUB_TOKEN` does **not** trigger another workflow — GitHub suppresses workflow-token-created events to prevent recursion. So a standalone workflow listening for `on: push: tags` will silently never run when Changesets `publish` or release-please creates the tag. Build and attach binaries in the **same** run, gated on the versioning step's output (`published` for Changesets, `release_created` for release-please). Both provided workflows already do this.

</constraints>


## Set it up on GitHub

Copy the files you need from [`workflows/`](workflows/) into your repo and adjust the placeholders (each file lists its own at the top — typically `src/cli.ts`, `my-cli`, `@myorg/cli`, `main`).

| File | Put it at | Use when |
|------|-----------|----------|
| [`ci.yml`](workflows/ci.yml) | `.github/workflows/ci.yml` | always — the gate |
| [`release-changesets.yml`](workflows/release-changesets.yml) | `.github/workflows/release.yml` | versioning with Changesets (npm, optional binary) |
| [`release-please.yml`](workflows/release-please.yml) | `.github/workflows/release-please.yml` | versioning with release-please (binary; plus its two config files at repo root) |
| [`install.sh`](workflows/install.sh) | repo root | distributing a binary via `curl … \| sh` |

### Permissions and secrets

- **`permissions:`** in the workflow — `contents: write` to create tags/releases, `pull-requests: write` for the version PR (both tools open one).
- **npm auth** (Changesets publish) — two options. Either npm **OIDC trusted publishing**: keep `id-token: write` in the workflow and register the repo as a trusted publisher on npmjs.com (no stored secret, short-lived token minted at publish time). Or a classic **`NPM_TOKEN`** secret exposed as `NODE_AUTH_TOKEN` (uncomment it in the workflow, drop `id-token: write`).
- **`GITHUB_TOKEN`** is provided automatically and is enough for tagging, releases, and uploading binary assets.
- **release-please** optionally takes a `RELEASE_PLEASE_TOKEN` (a PAT or GitHub App token) so the release PR's checks run as a real actor; it falls back to `GITHUB_TOKEN`.

<constraints>

The `install.sh` verifies the binary's sha256 against the release's `checksums.txt` before moving it into place, and fails closed on mismatch. Keep that check. A `curl … | sh` installer runs with the user's shell privileges — skipping verification means a corrupted or tampered download installs silently. Always publish `checksums.txt` alongside the binaries (the release workflows do).

</constraints>

### Docs deploy (optional)

If the CLI has a docs site, deploy it from the same repo on pushes under `docs/**`. The lightweight path: build the static site and force-push the output to a `gh-pages` branch with a `GITHUB_TOKEN`. The native path: `actions/upload-pages-artifact` + `actions/deploy-pages`, which deploys straight from the run when the repo's Pages source is set to "GitHub Actions." Either works; the native one needs no extra branch.
