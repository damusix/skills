# Dark Mode, Accent Color & Search


## Dark Mode


Ghost has no built-in server-side dark mode toggle. Themes own the full implementation. The canonical pattern is a `<script>` block placed **before** `{{ghost_head}}` in `default.hbs`. Running before `ghost_head` is the key FOUC prevention technique: the script sets `data-theme` on `<html>` synchronously, before the browser parses any CSS, so there is never a flash of the wrong colour scheme.

**Head order in `default.hbs`:**

    <head>
        <link rel="stylesheet" href="{{asset "built/screen.css"}}">

        <script>
            /* theme-mode script — runs before ghost_head */
        </script>

        {{ghost_head}}
    </head>

If the script were placed after `{{ghost_head}}` the browser would already have applied `:root` colour tokens before the theme attribute was set, causing a white→dark flash on every page load.


### The `data-theme` attribute pattern


The script reads a custom setting (e.g. `{{@custom.appearance}}`), optionally localStorage, and optionally `prefers-color-scheme`, then calls:

    document.documentElement.setAttribute('data-theme', 'dark');  // or 'light'

All dark-mode CSS is then scoped to `[data-theme="dark"]`:

    :root {
        --color-bg: #ffffff;
        --color-text: #15171a;
    }

    [data-theme="dark"] {
        --color-bg: #15171a;
        --color-text: #ffffff;
    }

This approach keeps a single stylesheet and avoids a second HTTP request for a dark stylesheet.


### Appearance custom setting


A common approach is a `select` setting named `appearance` with options `light`, `dark`, `system`, and `user`. The script reads it as `'{{@custom.appearance}}'` at render time (it is a Handlebars string interpolation, so it is baked into the HTML). Logic:

- `light` / `dark` — force that theme, ignore system and localStorage.
- `system` — read `window.matchMedia('(prefers-color-scheme: dark)')` and follow system changes via `addListener`.
- `user` — check localStorage first, fall back to system preference; the toggle button writes back to localStorage via `localStorage.setItem('theme', theme)`.

When `appearance` is `user`, a `.gh-theme-toggle` button is rendered in the header. The `DOMContentLoaded` listener attaches the click handler after the DOM is ready. The toggle button itself can carry `data-theme` as a UI state hint, but the authoritative attribute is always on `<html>`.


### FOUC checklist


- Script is **before** `{{ghost_head}}` — never after, never deferred.
- Script is **inline** — no `src` attribute that would require a network round-trip.
- Script sets `data-theme` on `document.documentElement` — the attribute is available as soon as the tag is stamped.
- CSS is loaded via `<link rel="stylesheet">` which is also before `{{ghost_head}}` — so the stylesheet and the attribute are both present before first paint.
- No `document.write` or DOM manipulation that requires the body to exist.


---


## Accent Color


### What `ghost_head` injects


When the Ghost admin "Accent color" field is set, `ghost_head.js` appends a `<style>` tag to its output:

    <style>:root {--ghost-accent-color: #ff6b35;}</style>

This tag is piggybacked onto the last existing `<style>` or `<script>` tag in the head array (to save a tag), or appended last if none exists. It is always on `:root`, so it is available to every element on the page.

Source reference: `ghost/core/core/frontend/helpers/ghost_head.js`, lines 343–353.

If the accent color is not set in Ghost admin, the variable is not injected at all — themes must provide a fallback.


### Using `--ghost-accent-color` in CSS


    a {
        color: var(--ghost-accent-color, #ff6b35);
    }

    .gh-btn-primary {
        background-color: var(--ghost-accent-color, #ff6b35);
    }

The second argument to `var()` is the fallback used when the variable is not defined. Always supply one so the theme works without an accent color configured.


### Deriving hover and focus variants with `color-mix()`


`color-mix()` is the modern way to lighten or darken a custom property without JavaScript or Sass:

    .gh-btn-primary:hover {
        /* 80% accent + 20% white = lighter tint */
        background-color: color-mix(in srgb, var(--ghost-accent-color) 80%, white);
    }

    .gh-btn-primary:focus-visible {
        /* 70% accent + 30% black = darker shade for focus ring */
        outline-color: color-mix(in srgb, var(--ghost-accent-color) 70%, black);
    }

    a:hover {
        color: color-mix(in srgb, var(--ghost-accent-color) 75%, black);
    }

Browser support: all evergreen browsers (Chrome 111+, Firefox 113+, Safari 16.2+). For older targets, fall back to a hard-coded colour:

    @supports not (color: color-mix(in srgb, red 50%, blue)) {
        .gh-btn-primary:hover {
            background-color: #cc5229; /* manually darkened fallback */
        }
    }


---


## Custom Fonts


### What `ghost_head` injects


When a site owner selects heading or body fonts in Ghost admin (Design → Typography), `ghost_head.js` injects a `<link>` to Bunny Fonts and a `<style>` setting two CSS custom properties:

    <link rel="preconnect" href="https://fonts.bunny.net">
    <link rel="stylesheet" href="https://fonts.bunny.net/css?family=space-grotesk:700|poppins:400,500,600">
    <style>:root {--gh-font-heading: Space Grotesk;--gh-font-body: Poppins;}</style>

The font CSS and the custom properties are only emitted when the admin has selected valid fonts from Ghost's built-in font list (`@tryghost/custom-fonts`). If neither heading nor body font is configured, no `<link>` or font `<style>` is written.

Source reference: `ghost/core/core/frontend/helpers/ghost_head.js`, lines 366–387.


### Body classes


`{{body_class}}` appends slugified font classes when fonts are active:

    <body class="post-template tag-foo gh-font-heading-space-grotesk gh-font-body-poppins">

This gives themes a CSS hook to conditionally adjust spacing or fallback stacks based on which font is active, without JavaScript.


### Using the variables in theme CSS


    body {
        font-family: var(--gh-font-body, Georgia, serif);
    }

    h1, h2, h3, h4, h5, h6 {
        font-family: var(--gh-font-heading, system-ui, sans-serif);
    }

The fallbacks (second argument) are what renders when no custom font is selected. Choose system fonts that degrade gracefully.


### Availability timing


The `<style>` injected by `ghost_head` appears after the theme's own `<link rel="stylesheet">` in document order, so `--gh-font-heading` and `--gh-font-body` are always defined before they are used — as long as the theme stylesheet is loaded before `{{ghost_head}}` (the standard pattern). Do not attempt to read these properties before `DOMContentLoaded`.


### Theme-managed fonts (no Ghost admin integration)


Themes that manage their own Google Fonts or Bunny Fonts load them directly from a partial before `{{ghost_head}}`:

    {{> custom-fonts}}
    {{ghost_head}}

The `custom-fonts.hbs` partial contains `<link rel="preconnect">` and `<link href="...googleapis.com/css2?...">` tags hardcoded for that theme's typeface choices. These fonts do not appear as `--gh-font-*` variables; they are applied via direct `font-family` declarations in the theme CSS.

Use this approach when the theme has a fixed identity that should not change based on admin settings, or when the fonts fall outside Ghost's built-in font list.


---


## Search


### How Ghost search works at runtime


`ghost_head` always injects the sodo-search script (unless explicitly excluded):

    <script defer
        src="https://cdn.jsdelivr.net/ghost/sodo-search@~X.Y/umd/sodo-search.min.js"
        data-key="<content-api-key>"
        data-styles="https://cdn.jsdelivr.net/ghost/sodo-search@~X.Y/umd/main.css"
        data-sodo-search="https://example.com/"
        data-locale="en"
        crossorigin="anonymous">
    </script>

The script is `defer`-ed, so it does not block rendering. On load it scans the document for `[data-ghost-search]` elements and attaches click listeners. It also registers the keyboard shortcut. The search modal itself is rendered into an `<iframe>` injected by the script — it does not live in the theme's DOM.

Source reference: `ghost/core/core/frontend/helpers/ghost_head.js`, `getSearchHelper()`, lines 83–101.


### Three ways to open search


**1. `{{search}}` helper**

The simplest option. Outputs a pre-styled button with a magnifying-glass SVG and `data-ghost-search` already set:

    {{search}}

Rendered HTML:

    <button class="gh-search-icon" aria-label="search" data-ghost-search
        style="display: inline-flex; justify-content: center; align-items: center;
               width: 32px; height: 32px; padding: 0; border: 0;
               color: inherit; background-color: transparent;
               cursor: pointer; outline: none;">
        <svg ...></svg>
    </button>

The inline styles make the button functional without any theme CSS. Themes can override visuals with their own class-based styles.

**2. `data-ghost-search` attribute**

Add the attribute to any element — button, anchor, div — to make it a search trigger:

    <button class="gh-search" data-ghost-search>
        {{> "icons/search"}}
    </button>

The sodo-search script queries `[data-ghost-search]` with `document.querySelectorAll` and attaches a click handler to every match. Multiple triggers on the same page all work independently.

**3. `#/search` navigation URL**

Adding `#/search` as a navigation item in Ghost admin (or as an `<a>` href in a theme) intercepts the hash change and opens the search modal. No `data-ghost-search` attribute is needed on the link. This is the lowest-friction option for sites where the theme has no dedicated search button.

    <a href="#/search">Search</a>


### Keyboard shortcut


`Cmd+K` (macOS) opens the search modal. The shortcut is registered by the sodo-search script automatically when at least one `[data-ghost-search]` element is present in the document — themes do not need to write any keyboard event code. The sodo-search source binds to `e.key === 'k' && e.metaKey` on the `keydown` event.

The official Ghost docs describe this as "Cmd/Ctrl + K". On Windows/Linux, `Ctrl+K` is the conventional equivalent, though the sodo-search source only explicitly checks `metaKey`. If Ctrl+K support is required, add a supplemental listener in the theme:

    document.addEventListener('keydown', function (e) {
        if (e.key === 'k' && e.ctrlKey && !e.metaKey) {
            document.querySelector('[data-ghost-search]')?.click();
        }
    });


### Search data scope


- Searches across post titles and excerpts from the most recent 10,000 posts.
- Member-only post excerpts are excluded from the index.
- Tags and authors appear in results only when their taxonomy routes exist (i.e., `tags` and `authors` are present in `routes.yaml`).


### Styling the search modal


The search modal lives inside an `<iframe>` that sodo-search injects. Ghost loads a CDN stylesheet into that iframe via the `data-styles` attribute. Themes cannot directly target iframe internals with normal CSS.

However, sodo-search checks for a custom styles URL and loads it into the iframe head if provided. To inject theme-specific search styles, pass the URL via the `data-styles` data attribute — this requires a custom `ghost_head` exclude and manual script injection, which is advanced usage.

For the trigger button itself (which lives in the theme's DOM), all normal CSS applies:

    .gh-search {
        display: flex;
        align-items: center;
        padding: 8px;
        border-radius: 6px;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
    }

    .gh-search:hover {
        background: var(--color-bg-secondary);
    }

    [data-theme="dark"] .gh-search {
        color: var(--color-text-dark);
    }


---


## What `{{ghost_head}}` Injects (full summary)


`{{ghost_head}}` is a single async Handlebars helper that assembles and outputs everything in the following order:

- Meta description, favicon link, canonical URL, prev/next pagination links.
- Open Graph and Twitter Card meta tags (structured data).
- JSON-LD schema markup.
- `<meta name="generator" content="Ghost X.Y">` and RSS `<link>`.
- Portal script (`<script defer src="...portal.min.js" data-ghost="..." data-key="..." ...>`), injected when members, donations, or recommendations are enabled.
- `<style id="gh-members-styles">` — Portal CTA inline styles.
- Stripe.js script when paid members are enabled.
- sodo-search script (`<script defer src="...sodo-search.min.js" data-key="..." data-styles="..." data-sodo-search="..." data-locale="...">`).
- Announcement bar script when announcement content is configured.
- Webmention discovery `<link>`.
- Card assets (`public/cards.min.js` and `public/cards.min.css`) for Koenig card rendering.
- Comment counts script when comments are enabled.
- Member attribution script when source tracking is enabled.
- Tinybird analytics tracker when web analytics is enabled.
- Accent color: `<style>:root {--ghost-accent-color: #XXXXXX;}</style>` — appended to the last style/script tag.
- Global, post-level, and tag-level code injection (Site Settings → Code injection → Site header, and per-post/tag header injection).
- Custom font preconnect `<link>`, Bunny Fonts stylesheet `<link>`, and `<style>:root {--gh-font-heading: …; --gh-font-body: …;}</style>`.

The helper accepts an `exclude` hash to suppress specific items:

    {{ghost_head exclude="search,portal"}}

Valid exclude keys: `metadata`, `social_data`, `schema`, `portal`, `cta_styles`, `search`, `announcement`, `card_assets`, `comment_counts`.
