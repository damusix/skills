# Ghost Theme Project Rules


## Build System

- Use **bun** exclusively — no npm, yarn, webpack, vite, or rollup
- `bun run build` must exit 0 before committing
- `bun run typecheck` to verify TypeScript types without building
- `bun run lint` to run ESLint
- Source: `assets/src/` → Built: `assets/built/` (built files are gitignored)
- Frontend TypeScript: add `.ts` files under `assets/src/components/`, import from `app.ts`
- Frontend CSS: add `.css` files under `assets/src/components/`, `@import` from `app.css`
- PostCSS with `postcss-import` resolves CSS `@import` chains into a single bundle


## Local Development

- Run `bash scripts/setup.sh` once after copying the template — starts Ghost and moves dotfiles (`.mcp.json`, `.github/`) into place
- After setup, `docker compose up -d` starts Ghost at http://localhost:2368
- The theme is bind-mounted into Ghost's themes directory — changes are live
- Run `bun run dev` alongside for watch-mode builds
- Ghost Admin is at http://localhost:2368/ghost/ — complete setup wizard on first run
- `.mcp.json` configures ghost-mcp for AI-driven testing — set `GHOST_ADMIN_API_KEY` after Ghost setup


## Visual Testing

- `bun run test:visual` captures screenshots of key pages at 3 viewport sizes (desktop, tablet, mobile)
- Requires Bun >= 1.3.12 (uses `Bun.WebView` headless browser — zero deps on macOS, Chrome on Linux)
- Screenshots saved to `tmp/screenshots/` (gitignored)
- Set `GHOST_URL` env var to test against a different instance (default: http://localhost:2368)
- Use ghost-mcp to populate sample content before running visual tests
- After making theme changes, re-run and compare screenshots to verify rendering


## CI/CD

- `.github/workflows/ci.yml` — runs typecheck, lint, build, and GScan on PRs
- `.github/workflows/deploy-theme.yml` — deploys to Ghost on push to main/master
- Set `GHOST_ADMIN_API_URL` and `GHOST_ADMIN_API_KEY` as repo secrets for deploy


## Template Rules

- All templates must be valid Handlebars for Ghost's GScan validator
- `default.hbs` must contain `{{ghost_head}}` before `</head>` and `{{ghost_foot}}` before `</body>`
- `default.hbs` must use `{{body_class}}` on the `<body>` element
- Post templates must use `{{post_class}}` on the article element
- Always use `{{asset "..."}}` for static file URLs — never hardcode paths
- Use `{{url}}` helper for object URLs — never access `.url` as a raw property


## Deprecated Helpers — Do Not Use

- `{{author}}` — use `{{primary_author}}` or `{{authors}}` instead
- `{{post.url}}` — use `{{url}}` inside `{{#post}}` block


## Styling Rules

- Reference Ghost's accent color via `var(--ghost-accent-color)` CSS variable — never hardcode accent colors
- Support Ghost Admin custom fonts via `var(--gh-font-heading)` and `var(--gh-font-body)` CSS variables
- All image URLs must use `{{img_url}}` with a `size` parameter from `package.json` image_sizes


## Custom Settings

- Maximum 20 custom settings in `package.json`
- Keys must be `snake_case` — no special characters
- Always guard text/image settings with `{{#if @custom.key}}` (they can be blank)
- Use `{{#match @custom.key "value"}}` for select comparisons


## File Structure

```
├── .mcp.json                # ghost-mcp config for AI testing
├── .github/workflows/       # CI + deploy GitHub Actions
├── docker-compose.yml       # Local Ghost dev environment
├── eslint.config.cjs        # ESLint flat config (TypeScript)
├── default.hbs              # Main layout shell
├── index.hbs                # Homepage / collection
├── post.hbs                 # Single post
├── page.hbs                 # Single page
├── author.hbs               # Author archive
├── tag.hbs                  # Tag archive
├── error.hbs                # Error page
├── error-404.hbs            # 404 page
├── package.json             # Theme manifest + config
├── routes.yaml              # Custom routing
├── tsconfig.json            # TypeScript config (type checking only)
├── scripts/
│   ├── setup.sh             # One-time setup: starts Ghost, moves dotfiles into place
│   ├── build.ts             # Bun build config
│   ├── test-screenshots.ts  # Visual screenshot tests (Bun.WebView)
│   ├── zip.sh               # Build + package dist.zip for Ghost upload
│   └── setup/
│       ├── mcp.json         # → .mcp.json (ghost-mcp config)
│       └── github/          # → .github/ (CI + deploy workflows)
├── locales/en.json          # i18n strings
├── partials/                # Reusable template fragments
│   ├── header.hbs
│   ├── footer.hbs
│   ├── navigation.hbs
│   ├── loop-card.hbs
│   ├── pagination.hbs
│   ├── members-cta.hbs
│   ├── structured-data.hbs
│   └── social-links.hbs
└── assets/
    ├── src/                 # Source files (edit these)
    │   ├── app.ts           # JS entrypoint — imports components
    │   ├── app.css          # CSS entrypoint — @imports components
    │   ├── base/            # Variables, reset, typography
    │   ├── layout/          # Container, responsive breakpoints
    │   └── components/      # Component-sized TS + CSS files
    └── built/               # Build output (gitignored)
        ├── app.css
        └── app.js
```
