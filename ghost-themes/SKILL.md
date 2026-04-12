---
name: ghost-theme
description: >-
  Build, customize, and deploy Ghost CMS themes. Use this skill whenever the user
  mentions Ghost themes, Ghost CMS, Handlebars templates (.hbs files), Ghost
  Admin, Ghost membership/subscription integration, Ghost custom settings, or
  Ghost content API — even if they don't say "theme" explicitly. Trigger on:
  building a blog theme, creating a Ghost site, editing .hbs templates, adding
  member-only content, Ghost hero sections, Ghost routing (routes.yaml), Ghost
  image optimization, Ghost dark mode, Ghost search, Ghost deploy, gscan
  validation, Ghost JSON-LD/SEO, or any mention of {{ghost_head}}, {{ghost_foot}},
  {{#foreach}}, {{#get}}, {{img_url}}, {{asset}}, `@custom`, `@member`, or Portal.
  Also use when the user has an existing Ghost theme they want to modify, extend,
  or debug — not just for new themes.
---

# Ghost Theme Skill


## Quick Start

**If the user already has a Ghost theme**, work with it directly. Read its existing templates, package.json, and build setup. The reference files below apply to any Ghost theme — not just the base template.

**If the user wants to create a new theme**, copy the base template:

```bash
    cp -r <skill-install-path>/base-template/ <theme-name>
    cd <theme-name>
    bun install
    bun run build
```

Where `<skill-install-path>` is wherever this skill is installed (e.g. `~/.claude/skills/ghost-theme`).

The base template includes: all required HBS files, TypeScript + component CSS build pipeline, ESLint, GitHub Actions (CI + deploy), Docker Compose for local Ghost, and ghost-mcp for AI-driven testing.

After copying, update `"name"` in `package.json` to the new theme name.

Then start the local Ghost instance and build:

```bash
    docker compose up -d
    bun run dev
```

Ghost Admin will be at http://localhost:2368/ghost/. On first run, complete the setup wizard, then go to **Settings → Design** and activate the theme named **`dev-theme`** — that is the mount name in `docker-compose.yml`, regardless of what you named the theme folder or `package.json`.

**Do not write Ghost theme files from scratch.** When creating a new theme, always copy the base template.


## Routing

Identify what the user needs, then read **only** the relevant reference file(s). Most tasks need 1-2 files, not all 12.

| When you need to... | Read | Key topics |
|---|---|---|
| Choose or create templates | [01-template-hierarchy.md](references/01-template-hierarchy.md) | Template lookup order, context data shapes, custom templates, foreach variables |
| Validate theme for upload | [02-required-files.md](references/02-required-files.md) | GScan errors vs warnings, package.json schema, required helpers |
| Use Handlebars helpers | [03-helper-api.md](references/03-helper-api.md) | `{{#get}}` filters, `{{#foreach}}`, `{{#has}}`, `{{#is}}`, `{{#match}}`, `{{img_url}}` |
| Add SEO or structured data | [04-structured-data.md](references/04-structured-data.md) | JSON-LD per context, OpenGraph/Twitter cards, canonical URLs |
| Build hero sections or layouts | [05-hero-patterns.md](references/05-hero-patterns.md) | Hero variants, featured carousel, custom templates, responsive images |
| Integrate members/subscriptions | [06-members-integration.md](references/06-members-integration.md) | `@member` object, Portal `data-portal` values, content gating, tiers |
| Configure theme settings | [07-custom-settings.md](references/07-custom-settings.md) | Setting types, `{{#match}}`, groups, color/image/text patterns, font vars |
| Set up or modify the build | [08-bun-build.md](references/08-bun-build.md) | `build.ts`, watch mode, zip workflow, TypeScript, PostCSS |
| Handle responsive images | [09-responsive-images.md](references/09-responsive-images.md) | `image_sizes`, srcset/sizes, format conversion, lazy loading |
| Configure custom routing | [10-routing.md](references/10-routing.md) | `routes.yaml`, collections, channels, data binding |
| Add translations | [11-i18n.md](references/11-i18n.md) | `{{t}}` helper, locale files, pluralization, RTL |
| Add dark mode, search, or styling | [12-appearance-search.md](references/12-appearance-search.md) | Dark mode, accent color, custom fonts, search triggers |
| Use Ghost content as UI data | [13-content-as-data.md](references/13-content-as-data.md) | Featured flag as hero curation, tag metadata (accent_color, feature_image, count.posts), Ghost pages as section metadata, internal (#hash) tags, related posts filter, JS carousel pattern, custom homepage with no default feed |


## Common Workflows

**New custom page layout:** Read [01](references/01-template-hierarchy.md) for `custom-*.hbs` naming + template lookup, [05](references/05-hero-patterns.md) for layout patterns, [07](references/07-custom-settings.md) if it needs user-configurable options.

**Paid members content gating:** Read [06](references/06-members-integration.md) for `{{#has visibility}}` and Portal attributes, [01](references/01-template-hierarchy.md) for post vs page context data.

**New collection or site section:** Read [10](references/10-routing.md) for `routes.yaml` syntax, [01](references/01-template-hierarchy.md) for template resolution, [03](references/03-helper-api.md) for `{{#get}}` cross-collection queries.

**Image performance:** Read [09](references/09-responsive-images.md) for srcset/sizes and format conversion, [02](references/02-required-files.md) for `image_sizes` in package.json.

**Local dev + deploy:** Read [08](references/08-bun-build.md) for Docker Compose setup, build pipeline, and GitHub Actions deploy workflow when using the base template.

**Carousel, hero, or category grid:** Read [13](references/13-content-as-data.md) first — Ghost has no native widget system. The answer is always `{{#get}}` to query posts/tags + the `featured` flag or tag metadata as the data source + a JS library (Tiny Slider, Swiper) or CSS scroll snap for interactivity.

**Custom homepage with full layout control:** Read [13](references/13-content-as-data.md) for the `home.hbs` + `routes: /: home` pattern. Read [05](references/05-hero-patterns.md) for hero variants, [07](references/07-custom-settings.md) for making sections configurable from Ghost Admin.
