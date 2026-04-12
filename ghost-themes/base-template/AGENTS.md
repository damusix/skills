# Ghost Theme — Agent Onboarding Guide


## How to Use This Guide

This theme was generated from the Ghost Theme Skill. For deep reference on any topic, consult the skill's reference files at `skill/references/`. This file covers the essentials for working within this theme.


## Template Hierarchy

Ghost selects templates by walking an ordered list and using the first match:

| Context | Selection Order (first match wins) |
|---------|-----------------------------------|
| Post | `post-{slug}.hbs` → custom template → `post.hbs` |
| Page | `page-{slug}.hbs` → custom template → `page.hbs` → `post.hbs` |
| Index | `home.hbs` (homepage only) → `index.hbs` |
| Tag | `tag-{slug}.hbs` → `tag.hbs` → `index.hbs` |
| Author | `author-{slug}.hbs` → `author.hbs` → `index.hbs` |
| Error | `error-{code}.hbs` → `error.hbs` |

Custom templates: any HBS file prefixed with `custom-` appears in the Ghost Admin dropdown for posts/pages.

**Deep dive:** `skill/references/01-template-hierarchy.md`


## Key Data Per Context

- **Post/Page** (`{{#post}}`): `title`, `slug`, `excerpt`, `content`, `url`, `feature_image`, `feature_image_alt`, `primary_author`, `primary_tag`, `tags`, `reading_time`, `access`
- **Index/Collection**: `posts` array (use `{{#foreach posts}}`), `pagination` object. Detect homepage with `{{#is "home"}}`
- **Author** (`{{#author}}`): `name`, `bio`, `profile_image`, `cover_image` + `posts` + `pagination`
- **Tag** (`{{#tag}}`): `name`, `slug`, `description`, `feature_image`, `accent_color` + `posts` + `pagination`
- **Global**: `@site`, `@member`, `@custom`, `@config`

**Deep dive:** `skill/references/01-template-hierarchy.md` (full data shapes)


## Quick Reference

| Topic | Reference |
|-------|-----------|
| All Handlebars helpers | `skill/references/03-helper-api.md` |
| SEO & JSON-LD | `skill/references/04-structured-data.md` |
| Hero & layout patterns | `skill/references/05-hero-patterns.md` |
| Members & subscriptions | `skill/references/06-members-integration.md` |
| Custom theme settings | `skill/references/07-custom-settings.md` |
| Build pipeline | `skill/references/08-bun-build.md` |
| Responsive images | `skill/references/09-responsive-images.md` |
| Routing & routes.yaml | `skill/references/10-routing.md` |
| i18n | `skill/references/11-i18n.md` |
| Dark mode, accent color, search | `skill/references/12-appearance-search.md` |
| Required files & GScan | `skill/references/02-required-files.md` |


## Local Development & Testing

- `docker compose up -d` starts a local Ghost instance at http://localhost:2368
- Theme is bind-mounted — run `bun run dev` for watch-mode builds
- Ghost Admin: http://localhost:2368/ghost/ (complete setup wizard on first run)
- `.mcp.json` provides ghost-mcp for AI-driven testing — set `GHOST_ADMIN_API_KEY` after Ghost setup
- `bun run test:visual` captures screenshots of homepage, post, author, tag, and 404 pages at desktop/tablet/mobile viewports
- Uses `Bun.WebView` (headless browser) — screenshots go to `tmp/screenshots/`
- Workflow: use ghost-mcp to create sample content → `bun run test:visual` → review screenshots


## Rules

- Use **bun** exclusively — no npm, yarn, webpack, vite, or rollup
- `bun run build`, `bun run typecheck`, and `bun run lint` must all pass before committing
- All templates must be valid Handlebars for Ghost's GScan validator
- `default.hbs` must contain `{{ghost_head}}` before `</head>` and `{{ghost_foot}}` before `</body>`
- Always use `{{asset "..."}}` for static file URLs — never hardcode paths
- Always use `{{url}}` helper for object URLs — never access `.url` as a raw property
- Use `{{primary_author}}` not `{{author}}` (deprecated)
- Reference accent color via `var(--ghost-accent-color)` — never hardcode
- All image URLs must use `{{img_url}}` with a `size` parameter
- Max 20 custom settings in `package.json`, keys must be `snake_case`
- Guard text/image settings with `{{#if @custom.key}}` (they can be blank)
