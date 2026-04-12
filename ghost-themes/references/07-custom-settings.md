# Custom Theme Settings


Custom theme settings let site owners configure a theme from Ghost Admin without touching code. They are declared in `package.json` under `config.custom` and accessed in templates via the `@custom` object.

## Table of Contents


- [Declaration anatomy](#declaration-anatomy)
- [Setting types](#setting-types)
  - [select](#select)
  - [boolean](#boolean)
  - [color](#color)
  - [image](#image)
  - [text](#text)
- [Setting groups](#setting-groups)
- [Setting visibility / conditional display](#setting-visibility--conditional-display)
- [The 20-setting limit](#the-20-setting-limit)
- [match helper with select settings](#match-helper-with-select-settings)
- [Color settings vs --ghost-accent-color](#color-settings-vs---ghost-accent-color)
- [Image settings: backgrounds, logos, hero overrides](#image-settings-backgrounds-logos-hero-overrides)
- [Text settings: limits, guards, fallbacks](#text-settings-limits-guards-fallbacks)
- [Custom font injection via ghost_head](#custom-font-injection-via-ghost_head)
- [Real-world example: full-featured theme](#real-world-example-full-featured-theme)
- [Real-world example: minimal theme](#real-world-example-minimal-theme)
- [Developer guidelines](#developer-guidelines)

---

## Declaration anatomy


Every setting lives at `config.custom.<key>` in `package.json`. The key becomes both the display label in Ghost Admin (converted from `snake_case` to Title Case) and the property name on `@custom`.

    {
        "config": {
            "custom": {
                "feed_layout": {
                    "type": "select",
                    "options": ["Dynamic grid", "Simple grid", "List"],
                    "default": "Dynamic grid",
                    "group": "homepage",
                    "description": "The layout of the post feed on the homepage, tag, and author pages"
                }
            }
        }
    }

Fields available on every setting:

- `type` — required. One of `select`, `boolean`, `color`, `image`, `text`.
- `default` — required for all types except `image` (forbidden on image).
- `group` — optional. One of `"homepage"`, `"post"`. Omit for site-wide.
- `description` — optional. Shown in Ghost Admin. Must be fewer than 100 characters.
- `visibility` — optional. NQL expression controlling when the setting appears.

Key naming rules:

- Lowercase `snake_case` only. No special characters.
- Changing a key in a new theme version is a **breaking change**: the old value is deleted and the default is restored for all existing installs.

---

## Setting types


### select


Renders a dropdown in Ghost Admin. Options are a fixed array of strings defined by the developer.

**Declaration:**

    "typography": {
        "type": "select",
        "options": ["Modern sans-serif", "Elegant serif"],
        "default": "Modern sans-serif",
        "description": "Define the default font used for the publication"
    }

Validation rules:

- `options` is required; must be a non-empty array of strings.
- `default` is required; must exactly match one of the defined options.

**Template usage** — use with the `{{#match}}` helper (covered in depth below):

    <body class="{{body_class}} {{#match @custom.typography "Elegant serif"}}font-alt{{/match}}">

---

### boolean


Renders a checkbox toggle in Ghost Admin.

**Declaration:**

    "show_feed_featured_image": {
        "type": "boolean",
        "default": false,
        "group": "homepage"
    }

Validation rules:

- `default` is required; must be `true` or `false` (JSON boolean, not a string).

**Template usage** — use with `{{#if}}`:

    {{#if @custom.show_feed_featured_image}}
        <img src="{{feature_image}}" alt="{{title}}">
    {{/if}}

---

### color


Renders a hex color picker in Ghost Admin.

**Declaration:**

    "button_color": {
        "type": "color",
        "default": "#15171a"
    }

Validation rules:

- `default` is required; must be a valid hexadecimal color string (e.g. `"#15171a"`).

**Template usage** — inject into a `<style>` block as a CSS custom property:

    <style>
        :root {
            {{#if @custom.button_color}}
            --button-bg-color: {{@custom.button_color}};
            {{/if}}
        }
    </style>

Always guard with `{{#if}}`. If the user has never set a value the property would be empty, which is valid CSS but sets the variable to an empty string rather than the default hex.

---

### image


Renders an image uploader in Ghost Admin. The value is either an empty string or an absolute URL.

**Declaration:**

    "cta_background_image": {
        "type": "image"
    }

Validation rules:

- `default` is **not allowed**. Omit it entirely.

**Template usage** — two patterns:

As a CSS background on an element:

    <section class="hero"
        {{#if @custom.cta_background_image}}
        style="background-image: url({{@custom.cta_background_image}});"
        {{/if}}>

As a resized `<img>` using `img_url`:

    {{#if @custom.cta_background_image}}
        <img src="{{img_url @custom.cta_background_image size="large"}}"
             alt="Custom background">
    {{/if}}

The `img_url` helper with a `size` parameter uses Ghost's image resizing pipeline, so the named size must exist in `config.image_sizes`.

---

### text


Renders a single-line text input in Ghost Admin. Value is an empty string or free-form text.

**Declaration:**

    "cta_text": {
        "type": "text",
        "default": "Sign up for more like this.",
        "group": "post"
    }

Validation rules:

- `default` is optional but recommended so Ghost Admin shows a meaningful placeholder.

**Template usage** — always guard with `{{#if}}` unless you provide an `{{else}}` fallback:

    {{#if @custom.cta_text}}
        <a href="#/portal/signup">{{@custom.cta_text}}</a>
    {{/if}}

When the theme **must** have a value (e.g. a copyright line), use an `{{else}}` fallback instead of relying on a non-empty default:

    <p>
        {{#if @custom.copyright_text_override}}
            {{@custom.copyright_text_override}}
        {{else}}
            {{@site.title}} © {{date format="YYYY"}}
        {{/if}}
    </p>

Do **not** encode fallback text directly in the template without a guard — the user clearing the field would produce a blank output rather than the hardcoded string, unless you use `{{else}}`.

---

## Setting groups


Settings appear in Ghost Admin under **Design & Branding → Theme**. They are sorted into three sections:

- **Site wide** — default when `group` is omitted.
- **Homepage** — declare with `"group": "homepage"`.
- **Post** — declare with `"group": "post"`.

Group the setting by where its effect is visible, not by type. A color that only affects post pages belongs in `"post"`, not site wide.

    {
        "config": {
            "custom": {
                "typography": {
                    "type": "select",
                    "options": ["Modern sans-serif", "Elegant serif"],
                    "default": "Modern sans-serif"
                },
                "feed_layout": {
                    "type": "select",
                    "options": ["Dynamic grid", "Simple grid", "List"],
                    "default": "Dynamic grid",
                    "group": "homepage",
                    "description": "Layout of the post feed on homepage, tag, and author pages"
                },
                "cta_text": {
                    "type": "text",
                    "default": "Sign up for more like this",
                    "group": "post",
                    "description": "CTA shown on post pages below the article"
                }
            }
        }
    }

---

## Setting visibility / conditional display


The `visibility` field takes an NQL expression. When the condition is false, the setting is hidden in Ghost Admin **and** its value is rendered as `null` in templates.

**Example: dependent boolean on a select**

    {
        "header_style": {
            "type": "select",
            "options": ["Landing", "Highlight", "Magazine", "Search", "Off"],
            "default": "Landing",
            "group": "homepage"
        },
        "use_publication_cover_as_background": {
            "type": "boolean",
            "default": false,
            "description": "Cover image used as background for Landing or Search styles",
            "group": "homepage",
            "visibility": "header_style:[Landing, Search]"
        }
    }

**Example: boolean conditioned on another select value**

    {
        "post_feed_style": {
            "type": "select",
            "options": ["List", "Grid"],
            "default": "List",
            "group": "homepage"
        },
        "show_images_in_feed": {
            "type": "boolean",
            "default": true,
            "description": "Toggles post card thumbnails when post feed style is List",
            "group": "homepage",
            "visibility": "post_feed_style:List"
        }
    }

NQL operators supported: `:[value]`, `:[v1, v2]` for "in" checks. Full NQL filter syntax applies — the same syntax used in the `get` helper's `filter` parameter.

When a hidden setting renders as `null`, any `{{#if @custom.the_setting}}` block is skipped, so dependent template logic is automatically suppressed.

---

## The 20-setting limit


Ghost enforces a hard cap of **20 custom settings** per theme. An unknown type or exceeding the limit causes a theme validation error in GScan.

Strategies for staying under 20:

- **Combine related options into one select.** Instead of separate booleans for dark mode, light mode, and system preference, use one `appearance` select with `["light", "dark", "system", "user"]`.
- **Avoid per-element micro-settings.** One `button_color` that applies to all buttons is one setting; a color per button blows the budget instantly.
- **Use visibility to reuse one setting for multiple contexts.** A single `hero_image` is hidden unless `header_style` is Landing — no need for a separate hero image per style.
- **Let Ghost's own fields carry the load.** Publication cover, logo, and accent color are already in Ghost Admin. Do not burn custom settings reproducing them.
- **Prefer select over multiple booleans.** Five layout variants represented as five booleans cost five settings; one select costs one.

Budget example across groups for a typical theme:

- Site wide: 4–5 settings (appearance, typography, accent override, social links toggle, cookie notice toggle)
- Homepage: 5–6 settings (hero layout, feed layout, show featured posts, hero title, hero text, CTA text)
- Post: 4–5 settings (post template, related posts layout, email CTA text, comments toggle, disqus shortname)

That leaves 4–7 slots for theme-specific differentiators.

---

## match helper with select settings


`{{#match}}` compares a value against a string literal. It is the canonical way to branch on `select` settings.

**Basic single-value match:**

    {{#match @custom.feed_layout "Dynamic grid"}}
        {{> partials/feed-dynamic}}
    {{/match}}

**else match chaining** — use `{{else match}}` to handle each option without nesting:

    {{#match @custom.feed_layout "Dynamic grid"}}
        {{> partials/feed-dynamic}}
    {{else match @custom.feed_layout "Simple grid"}}
        {{> partials/feed-simple}}
    {{else match @custom.feed_layout "List"}}
        {{> partials/feed-list}}
    {{else}}
        {{> partials/feed-dynamic}}
    {{/match}}

The `{{else}}` at the end acts as the fallback if none of the match arms fire. This is the correct pattern when the default might not have been persisted yet (e.g. older Ghost installs that pre-date the setting).

**Inline class application** — useful for a CSS-class-driven approach:

    <body class="{{body_class}}
        {{#match @custom.typography "Elegant serif"}}font-serif{{/match}}
        {{#match @custom.appearance "dark"}}theme-dark{{/match}}
        {{#match @custom.appearance "system"}}theme-system{{/match}}">

Each `{{#match}}` block emits its content (or nothing), so multiple independent matches can coexist on the same element.

**Using match with visibility-hidden settings** — when `visibility` conditions are not met, `@custom.the_setting` is `null`. A `{{#match}}` on `null` against any string returns false, so the block is silently skipped without error.

---

## Color settings vs --ghost-accent-color


Ghost exposes the publication's accent color (set in Design → Brand) as the CSS custom property `--ghost-accent-color`. This is injected by `{{ghost_head}}` automatically — no custom setting needed.

Custom `color` settings are for **additional** brand colors that are not the accent. Common uses:

- A secondary button color distinct from the accent
- A card background tint
- A hero overlay color

Key differences:

| | `--ghost-accent-color` | Custom color setting |
|---|---|---|
| Configured in | Design → Brand (built-in) | Design → Theme (custom) |
| Template access | CSS var in stylesheet | `@custom.your_key` in HBS |
| Counts against 20-limit | No | Yes |
| Requires theme code | Just reference the CSS var | Declare + inject via `<style>` |

Use `--ghost-accent-color` for primary interactive elements (links, buttons, highlights). Reserve custom color settings for secondary palette slots that the accent alone cannot cover.

Template pattern for a custom color:

    {{ghost_head}}
    <style>
        :root {
            {{#if @custom.button_color}}
            --theme-button-color: {{@custom.button_color}};
            {{else}}
            --theme-button-color: var(--ghost-accent-color);
            {{/if}}
        }
    </style>

This makes the custom color fall back to the accent if the user has not set it, keeping the theme coherent out of the box.

---

## Image settings: backgrounds, logos, hero overrides


Image settings return a URL string or empty string. They have no default and must always be guarded.

**Full-bleed section background:**

    <section class="hero"
        {{#if @custom.hero_background_image}}
        style="background-image: url({{@custom.hero_background_image}});"
        {{/if}}>
        <div class="hero-inner">{{@site.title}}</div>
    </section>

**Custom logo override** — when a theme wants a separate logo from the one in Ghost Admin:

    {{#if @custom.alternative_logo}}
        <img class="site-logo-alt"
             src="{{img_url @custom.alternative_logo size="s"}}"
             alt="{{@site.title}}">
    {{else}}
        {{#if @site.logo}}
            <img class="site-logo"
                 src="{{img_url @site.logo size="s"}}"
                 alt="{{@site.title}}">
        {{/if}}
    {{/if}}

The `img_url` helper with a named size resizes through Ghost's image pipeline. The size name must be declared in `config.image_sizes`.

**Hero image override** — override the post's own feature image with a custom one:

    {{#if @custom.hero_override_image}}
        <div class="hero" style="background-image: url({{@custom.hero_override_image}});"></div>
    {{else if feature_image}}
        <div class="hero" style="background-image: url({{feature_image}});"></div>
    {{/if}}

Do not set a `default` on an image setting. Ghost's schema validation rejects it.

---

## Text settings: limits, guards, fallbacks


There is no enforced character limit documented in Ghost's schema for text settings, but Ghost Admin presents a single-line input. Long values are technically accepted. Keep defaults concise — they appear as placeholder text in the admin UI.

**Description field limit** — the `description` field on the setting declaration itself is capped at 100 characters. This is enforced at theme upload time by GScan.

**Pattern 1: Optional text — hide when blank**

    {{#if @custom.email_signup_text}}
        <p class="signup-cta">{{@custom.email_signup_text}}</p>
    {{/if}}

**Pattern 2: Required text — always show, with a computed fallback**

    <h1>
        {{#if @custom.hero_title}}
            {{@custom.hero_title}}
        {{else}}
            {{@site.title}}
        {{/if}}
    </h1>

**Pattern 3: Conditional feature via presence** — a Disqus shortname enables the whole comments section only if provided:

    {{#if @custom.disqus_shortname}}
        <div id="disqus_thread"></div>
        <script>
            var disqus_config = function () {
                this.page.url = "{{url absolute="true"}}";
                this.page.identifier = "{{id}}";
            };
            (function() {
                var d = document, s = d.createElement('script');
                s.src = 'https://{{@custom.disqus_shortname}}.disqus.com/embed.js';
                s.setAttribute('data-timestamp', +new Date());
                (d.head || d.body).appendChild(s);
            })();
        </script>
    {{/if}}

This pattern avoids a dedicated `enable_disqus` boolean by treating a non-empty shortname as the enable signal — saving one of the 20 slots.

---

## Custom font injection via ghost_head


Ghost's custom font system is separate from custom settings. Users pick heading and body fonts from a curated list in Ghost Admin (Design → Brand → Typography). Ghost then injects the font via `{{ghost_head}}`:

    <link rel="preconnect" href="https://fonts.bunny.net">
    <link rel="stylesheet" href="https://fonts.bunny.net/css?family=fira-mono:400,700|ibm-plex-serif:400,500,600">
    <style>
        :root {
            --gh-font-heading: Fira Mono;
            --gh-font-body: IBM Plex Serif;
        }
    </style>

The variables `--gh-font-heading` and `--gh-font-body` are always injected when a font is selected. To consume them in a theme:

    body {
        font-family: var(--gh-font-body, Helvetica, sans-serif);
    }

    h1, h2, h3, h4, h5, h6 {
        font-family: var(--gh-font-heading, var(--theme-heading-font));
    }

The fallback inside `var()` fires when no custom font has been chosen, keeping the theme's own font stack active.

Ghost also injects font-specific classes onto `<body>` via `{{body_class}}`:

    <body class="gh-font-heading-fira-mono gh-font-body-ibm-plex-serif">

Use these classes for per-font overrides (e.g. tighter line height for a monospace heading font):

    body.gh-font-heading-fira-mono h1 {
        letter-spacing: -0.02em;
        line-height: 1.1;
    }

Custom fonts are **not** a custom setting and do not count toward the 20-setting limit. A theme supports them simply by referencing the CSS variables. No package.json declaration is needed.

---

## Real-world example: full-featured theme


A full-featured theme might use 12 custom settings across all three groups, structured as follows.

**Site wide (2 settings):**

    "navigation_layout": {
        "type": "select",
        "options": ["Logo on the left", "Logo in the middle"],
        "default": "Logo on the left"
    },
    "appearance": {
        "type": "select",
        "options": ["light", "dark", "system", "user"],
        "default": "system"
    }

- `navigation_layout` drives a CSS class or partial swap controlling where the site logo sits in the header.
- `appearance` controls the color scheme. The `"user"` option means the site respects the individual visitor's OS preference; `"system"` means the site follows the server-side default system preference. Both `"system"` and `"user"` differ from the explicit `"light"` / `"dark"` by delegating the decision rather than forcing it.

**Homepage (5 settings):**

    "hero_layout": {
        "type": "select",
        "options": ["Publication logo", "No logo"],
        "default": "Publication logo",
        "group": "homepage"
    },
    "primary_header": {
        "type": "text",
        "default": "Welcome to my site",
        "group": "homepage"
    },
    "secondary_header": {
        "type": "text",
        "default": "Subscribe below to receive my latest posts directly in your inbox",
        "group": "homepage"
    },
    "show_feed_featured_image": {
        "type": "boolean",
        "default": false,
        "group": "homepage"
    },
    "show_featured_posts": {
        "type": "boolean",
        "default": true,
        "group": "homepage"
    }

- `hero_layout` uses a select rather than a boolean so future layout variants can be added without changing the setting type.
- `primary_header` and `secondary_header` are text settings with meaningful defaults so the homepage is readable before the owner customizes anything.
- Both boolean flags default to the most common preference (`false` for featured images in feed, `true` for showing featured posts).

**Homepage (continued — text labels):**

    "featured_title": {
        "type": "text",
        "default": "Featured",
        "group": "homepage"
    },
    "feed_title": {
        "type": "text",
        "default": "Latest Stories",
        "group": "homepage"
    }

These are section headings editable without code changes. Templates should check `{{#if @custom.featured_title}}` before rendering the heading.

**Post (3 settings):**

    "default_post_template": {
        "type": "select",
        "options": ["No feature image", "Narrow feature image", "Wide feature image", "Full feature image"],
        "default": "Narrow feature image",
        "group": "post"
    },
    "related_feed_layout": {
        "type": "select",
        "options": ["Expanded", "Right thumbnail", "Text-only", "Minimal", "Vertical big"],
        "default": "Right thumbnail",
        "group": "post"
    },
    "email_signup_text": {
        "type": "text",
        "default": "Subscribe to our newsletter.",
        "group": "post"
    },
    "email_signup_desc": {
        "type": "text",
        "default": "Be the first to know - subscribe today",
        "group": "post"
    }

- `default_post_template` sets the feature image treatment globally, which Ghost's custom template system can then override per-post via the `custom-*` template naming convention.
- `related_feed_layout` offers five layout variants as a single select rather than individual booleans — efficient use of the budget.
- `email_signup_text` and `email_signup_desc` are the headline and subheading of the in-post subscription CTA.

Total: 12 settings — 8 slots remaining.

---

## Real-world example: minimal theme


A minimal theme might use just 7 custom settings, leaving substantial headroom.

**Site wide (3 settings):**

    "enable_about_in_sidebar": {
        "type": "boolean",
        "default": true
    },
    "about_title": {
        "type": "text",
        "default": "About"
    },
    "about_text": {
        "type": "text",
        "default": "Subtle is a simple & elegant Ghost theme for writers and bloggers. Feedback, questions, or ideas? Drop us a line via email."
    }

- `enable_about_in_sidebar` gates the sidebar "About" section. When `false`, `about_title` and `about_text` have no effect — a candidate for `visibility` to hide them automatically.
- `about_title` and `about_text` give site owners editable sidebar copy without injecting code. The verbose default for `about_text` is intentional: it prompts owners to write their own description.

**Homepage (2 settings):**

    "hero_title": {
        "type": "text",
        "default": "Hello & Welcome to Subtle",
        "group": "homepage"
    },
    "hero_text": {
        "type": "text",
        "default": "Subtle is an online magazine / blog dedicated to modern design, art, architecture, interior design, fashion and technology.",
        "group": "homepage"
    }

These populate the homepage hero headline and description. Both have defaults that make the theme feel complete immediately after installation.

**Post (2 settings):**

    "enable_disqus": {
        "type": "boolean",
        "default": false,
        "group": "post"
    },
    "disqus_shortname": {
        "type": "text",
        "default": "",
        "group": "post"
    }

The two-setting pattern (toggle + identifier) is an alternative to the one-setting shortname-as-enable pattern. Without the `"visibility": "enable_disqus:true"` annotation, `disqus_shortname` is always visible — an opportunity to add `visibility` to improve the admin UX. The template should guard the Disqus embed with both checks:

    {{#if enable_disqus}}{{#if @custom.disqus_shortname}}
        <!-- disqus embed -->
    {{/if}}{{/if}}

Total: 7 settings — 13 slots remaining.

---

## Developer guidelines


**Do:**

- Give every setting a `description` under 100 characters explaining its visible effect.
- Set defaults that make the theme immediately presentable — never leave owners with a blank, broken state.
- Use `visibility` to hide dependent settings when their parent condition is not met.
- Guard all `image` and `text` settings with `{{#if}}` or `{{else}}` fallbacks.
- Group settings by the part of the site they affect, not by type.
- Use select over multiple booleans when three or more variants exist.
- Treat a non-empty text value as an implicit enable for optional integrations (e.g. a tracking ID, a Disqus shortname) — saves a boolean slot.

**Do not:**

- Exceed 20 settings.
- Set a `default` on an `image` setting (validation error).
- Use custom settings to reproduce functionality already in Ghost Admin (logo, cover, accent color, navigation).
- Ask users to paste raw HTML into a text setting — use a structured identifier instead.
- Change a setting's key in a minor version — it is a breaking change that wipes the stored value.
- Use `color` custom settings to duplicate `--ghost-accent-color`; reference the CSS var directly instead.
