# Required Files & GScan Validation

## Required Files

Every Ghost theme must include these two files at the theme root. Without them, Ghost Admin will reject the upload outright:

- `index.hbs` — list of posts (used as fallback for tag, author, and home contexts if those templates are missing)
- `post.hbs` — single post view
- `package.json` — theme metadata and configuration (required; missing file is a fatal GScan error)

## Required Handlebars Helpers

For a theme to function, every template that outputs a full HTML page must include these helpers:

- `{{asset}}` — resolves paths to theme asset files
- `{{body_class}}` — outputs context-aware CSS classes on `<body>`
- `{{post_class}}` — outputs context-aware CSS classes on post wrapper elements
- `{{ghost_head}}` — injects Ghost-managed `<head>` content (SEO, scripts, styles, member portal)
- `{{ghost_foot}}` — injects Ghost-managed footer scripts

`{{ghost_head}}` and `{{ghost_foot}}` are typically placed in `default.hbs`. If you do not use `default.hbs`, they must appear in every template that renders a full page.

---

## Directory Structure Conventions

```
theme-name/
├── package.json          ← required
├── index.hbs             ← required
├── post.hbs              ← required
├── default.hbs           ← strongly recommended base layout
├── home.hbs              ← optional; only renders /
├── page.hbs              ← optional; falls back to post.hbs
├── tag.hbs               ← optional; falls back to index.hbs
├── author.hbs            ← optional; falls back to index.hbs
├── private.hbs           ← optional; password-protection form
├── error.hbs             ← optional; 404/500 fallback
├── error-4xx.hbs         ← optional; all 4xx errors
├── error-404.hbs         ← optional; exact 404 match (highest priority)
├── robots.txt            ← optional; overrides Ghost default
├── assets/
│   ├── css/
│   ├── js/
│   └── screenshot-desktop.jpg
│   └── screenshot-mobile.jpg
└── partials/
```

**Slug-specific templates** follow the pattern `post-:slug.hbs`, `page-:slug.hbs`, `tag-:slug.hbs`, `author-:slug.hbs`.

**Custom selectable templates** follow the pattern `custom-{{template-name}}.hbs` and appear in the Ghost Admin template selector for posts and pages.

**Error template priority** (highest to lowest): `error-{{code}}.hbs` > `error-{{class}}xx.hbs` > `error.hbs` > Ghost default.

---

## GScan: Errors vs Warnings

GScan is the official theme validator bundled with Ghost (version 5.4.3 in Ghost Core 6.29.0). It runs automatically on every theme upload. The distinction between fatal errors and warnings determines whether a theme can be activated.

### How Ghost uses GScan results

- `results.hasFatalErrors === true` → theme **cannot be activated**; upload is rejected
- Non-fatal `error` level items → theme is activated but **errors are shown** in Ghost Admin sidebar
- `warning` level items → shown during development only; **suppressed in production** (`config.env === 'production'`)

Ghost Admin displays a banner ("Your theme has errors") for any active error-level issues. The `GS110-NO-MISSING-PAGE-BUILDER-USAGE` code is filtered out of the sidebar banner by the admin UI even when present.

### Fatal errors (block upload)

These cause `hasFatalErrors: true` and prevent the theme from being used:

| Code | Rule |
|---|---|
| `GS001-DEPR-CON-AC` | `author.cover` replaced by `author.cover_image` |
| `GS001-DEPR-PURL` | `{{pageUrl}}` helper deprecated (use `{{pagination}}`) |
| Missing required files | `index.hbs` or `post.hbs` absent |
| Missing `package.json` | No theme metadata file |
| Invalid `package.json` | Malformed JSON or missing required fields |
| Unknown custom setting type | `config.custom` entry has an unrecognized `"type"` value |

Fatal errors are any GScan result where `fatal: true` is set on the error object. The `level` field is `"error"` for both fatal and non-fatal GScan errors; only `fatal: true` triggers upload rejection.

### Non-fatal errors (theme loads, errors shown in Admin)

These allow activation but display in the Ghost Admin theme error dialog:

| Code | Description |
|---|---|
| `GS001-DEPR-PURL` (non-fatal instance) | Deprecated `{{pageUrl}}` helper usage |
| `GS110-NO-MISSING-PAGE-BUILDER-USAGE` | Missing `@page.*` feature usage for page builder (filtered from sidebar banner) |
| Deprecated helper usage | Any `GS001-DEPR-*` code not marked fatal |

### Warnings (dev-only, suppressed in production)

Warnings appear on the GScan site and CLI during development but are cleared to an empty array when Ghost runs in production mode. They are non-blocking and invisible to end-users:

- Recommendations for optional but good-practice templates
- Suggestions to use newer API patterns
- Accessibility and performance hints

### Using GScan

```
    # Install globally
    npm install -g gscan

    # Validate a theme folder
    gscan /path/to/theme

    # Validate a zip file
    gscan -z /path/to/theme.zip

    # Fatal errors only (CI-friendly exit code)
    gscan --fatal --verbose /path/to/theme
```

The online validator at `https://gscan.ghost.org` provides the same results with a full formatted report.

GScan is also runnable locally as a dev dependency — include `"test": "gscan ."` in `package.json` scripts to run it during development.

---

## Deprecated Helpers & Replacements

These helpers still exist in Ghost source but are deprecated. Using them may trigger GScan errors or warnings depending on the specific code. New themes must use the replacements.

| Deprecated | Replacement | Notes |
|---|---|---|
| `{{facebook_url}}` | `{{social_url type="facebook"}}` | Still executes; GScan warns |
| `{{twitter_url}}` | `{{social_url type="twitter"}}` | Still executes; GScan warns |
| `{{pageUrl}}` | `{{pagination}}` | Triggers `GS001-DEPR-PURL`; can be fatal |
| `{{author.cover}}` | `{{author.cover_image}}` | Triggers `GS001-DEPR-CON-AC`; fatal |
| `accentColor` on content-cta | Removed in Ghost 5.16.1 | Internal only; not a theme-facing helper |
| Single `author` include | `authors` (multiple authors) | `author` still works but superceded since Ghost 1.22.0 |

---

## `package.json` Full Schema

The `package.json` at the theme root must be valid JSON with double-quoted property names. It is required — a missing or malformed file is a fatal GScan error.

### Minimal valid example

```
    {
        "name": "your-theme-name",
        "description": "A brief explanation of your theme",
        "version": "0.5.0",
        "license": "MIT",
        "engines": {
            "ghost": ">=5.0.0"
        },
        "author": {
            "email": "your@email.here"
        },
        "config": {
            "posts_per_page": 10,
            "image_sizes": {},
            "card_assets": true
        }
    }
```

### Full annotated schema

```
    {
        // REQUIRED
        "name": "theme-name",           // lowercase, no spaces
        "version": "1.0.0",             // semver

        // RECOMMENDED
        "description": "...",
        "license": "MIT",
        "author": {
            "name": "Your Name",
            "email": "you@example.com",
            "url": "https://example.com"
        },
        "engines": {
            "ghost": ">=5.0.0"          // minimum Ghost version required
        },

        // OPTIONAL METADATA
        "keywords": ["ghost", "theme", "ghost-theme"],
        "docs": "https://...",          // link shown in Ghost Admin Design page
        "screenshots": {
            "desktop": "assets/screenshot-desktop.jpg",
            "mobile":  "assets/screenshot-mobile.jpg"
        },

        // THEME CONFIGURATION
        "config": {
            "posts_per_page": 5,        // default: 5 (from Ghost engine defaults)
            "image_sizes": { ... },     // see below
            "card_assets": true,        // default: true (from Ghost engine defaults)
            "custom": { ... }           // see below; max 20 settings
        }
    }
```

### `config.posts_per_page`

Integer. Controls how many posts appear per page on list contexts (index, tag, author). Ghost engine default is `5` when not specified. Common values range from 5 to 25.

### `config.image_sizes`

Object mapping named size keys to width constraints. Ghost uses these to generate responsive image srcsets. Keys are arbitrary strings (conventional names: `xxs`, `xs`, `s`, `m`, `l`, `xl`, `xxl`). Each value is an object with a `width` property (integer, pixels).

```
    "image_sizes": {
        "xxs": { "width": 30   },
        "xs":  { "width": 100  },
        "s":   { "width": 300  },
        "m":   { "width": 600  },
        "l":   { "width": 1000 },
        "xl":  { "width": 2000 }
    }
```

Sizes are referenced in templates via the `size` parameter of `{{img_url}}`:

```
    {{img_url feature_image size="m"}}
```

### `config.card_assets`

Controls whether Ghost automatically injects card CSS and JS for the Koenig editor's content cards (e.g. bookmark, gallery, video). Three valid forms:

- `true` — inject all card assets (default when not specified)
- `false` — inject no card assets (theme handles card styling itself)
- Object with `exclude` array — inject all card assets except the listed card types

```
    "card_assets": true

    "card_assets": false

    "card_assets": {
        "exclude": ["blockquote", "bookmark", "gallery", "header"]
    }
```

The `exclude` form is useful when a theme opts out of specific card types it styles manually.

### `config.custom`

Object defining up to **20** custom settings editable by site owners in Ghost Admin under Design → Theme. Keys become `snake_case` display names and `@custom.key_name` template variables.

**Setting types:**

| Type | Required fields | Optional fields | Notes |
|---|---|---|---|
| `select` | `type`, `options` (array of strings), `default` (must match an option) | `group`, `description`, `visibility` | Use with `{{#match}}` helper |
| `boolean` | `type`, `default` (true or false) | `group`, `description`, `visibility` | Use with `{{#if}}` helper |
| `color` | `type`, `default` (valid hex string) | `group`, `description`, `visibility` | Outputs hex value directly |
| `image` | `type` | `group`, `description`, `visibility` | No `default` allowed; outputs URL or blank |
| `text` | `type` | `default`, `group`, `description`, `visibility` | Free-form text |

**Setting groups** (controls which tab in Ghost Admin Design panel):

- omitted → "Site wide" tab (default)
- `"group": "homepage"` → "Homepage" tab
- `"group": "post"` → "Post" tab

**Setting visibility** — conditional display based on another setting's value using NQL syntax:

```
    "visibility": "header_style:[Landing, Search]"
    "visibility": "post_feed_style:List"
```

When the visibility condition is not met, the dependent setting evaluates to `null` in templates.

**Key naming rules:**

- All lowercase, `snake_case` only
- No special characters
- Renaming a key between releases is a breaking change (old value is lost)
- Description must be fewer than 100 characters
- Unknown `type` values cause a theme validation error on upload

**Full `config.custom` example:**

```
    "custom": {
        "navigation_layout": {
            "type": "select",
            "options": ["Logo on the left", "Logo in the middle"],
            "default": "Logo on the left"
        },
        "appearance": {
            "type": "select",
            "options": ["light", "dark", "system", "user"],
            "default": "system"
        },
        "show_featured_posts": {
            "type": "boolean",
            "default": true,
            "group": "homepage"
        },
        "primary_header": {
            "type": "text",
            "default": "Welcome to my site",
            "group": "homepage"
        },
        "default_post_template": {
            "type": "select",
            "options": [
                "No feature image",
                "Narrow feature image",
                "Wide feature image",
                "Full feature image"
            ],
            "default": "Narrow feature image",
            "group": "post"
        }
    }
```

### `engines.ghost`

Semver range string declaring the minimum Ghost version the theme supports. Used by Ghost Marketplace and tooling; not enforced at runtime by GScan but expected by conventions. Common values:

- `">=5.0.0"` — Ghost 5.x and later
- `">=4.0.0"` — Ghost 4.x and later

### `docs`

URL string. When present, a link to the theme's documentation is shown in Ghost Admin on the Design page. Example: `"docs": "https://example.com/docs/my-theme"`.
