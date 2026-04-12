# Handlebars Helper API


Ghost exposes 53+ Handlebars helpers. This reference covers every parameter,
every valid attribute value, and the context constraints that determine whether
a helper works or fails silently.

---

## Table of Contents


- [`{{#get}}` — API Data Fetcher](#get--api-data-fetcher)
- [`{{#foreach}}` — Enhanced Loop](#foreach--enhanced-loop)
- [`{{#has}}` — Property Checks](#has--property-checks)
- [`{{#is}}` — Context Guard](#is--context-guard)
- [`{{#match}}` — Comparison Operator](#match--comparison-operator)
- [`{{content}}` — Post HTML](#content--post-html)
- [`{{excerpt}}` — Plain-text Summary](#excerpt--plain-text-summary)
- [`{{img_url}}` — Responsive Image URLs](#img_url--responsive-image-urls)
- [`{{navigation}}` — Site Nav](#navigation--site-nav)
- [`{{pagination}}` — Page Links](#pagination--page-links)
- [`{{date}}` — Date Formatting](#date--date-formatting)
- [`{{prev_post}}` / `{{next_post}}`](#prev_post--next_post)
- [Other Inline Helpers](#other-inline-helpers)
- [Context × Helper Compatibility Matrix](#context--helper-compatibility-matrix)

---

## `{{#get}}` — API Data Fetcher


`{{#get}}` is a block helper that fires a live Content API query during
template rendering. It is the primary mechanism for loading data not already
in the page context — related posts, tag clouds, author lists, tier walls, etc.

Valid resource types: `posts`, `pages`, `tags`, `authors`, `tiers`,
`newsletters`.

### Basic form

    {{#get "posts" limit="3" filter="featured:true"}}
        {{#foreach posts}}
            <a href="{{url}}">{{title}}</a>
        {{/foreach}}
    {{else}}
        <p>No posts found.</p>
    {{/get}}

The `{{else}}` branch fires on API error or zero results.

### Block params (named result variables)

    {{#get "posts" limit="5" as |posts meta|}}
        {{#foreach posts}}…{{/foreach}}
        <p>Page {{meta.pagination.page}} of {{meta.pagination.pages}}</p>
    {{/get}}

`meta.pagination` inside block params mirrors the pagination object (see
[`{{pagination}}`](#pagination--page-links) for field list).

---

### Parameter reference

#### `filter`

NQL (Ghost Query Language) string. Supports `+` (AND), `,` (OR), `-` (NOT),
and comparison operators `>`, `<`, `>=`, `<=`.

Common field names for `posts`:

- `featured:true` / `featured:false`
- `tag:slug-here`
- `primary_tag:slug-here`
- `author:slug-here`
- `primary_author:slug-here`
- `visibility:public` / `visibility:members` / `visibility:paid`
- `published_at:>2024-01-01`
- `id:-{{id}}` (exclude current post — dynamic path syntax, see below)

Examples:

    {{!-- Featured posts tagged "tutorial" --}}
    {{#get "posts" filter="featured:true+tag:tutorial"}}

    {{!-- Any of two tags --}}
    {{#get "posts" filter="tag:news,tag:announcements"}}

    {{!-- Exclude current post by id --}}
    {{#get "posts" filter="id:-{{id}}" limit="3"}}

    {{!-- Tags that are not the current tag --}}
    {{#get "tags" filter="id:-{{id}}+visibility:public" limit="16"}}

    {{!-- Posts published after a date --}}
    {{#get "posts" filter="published_at:>'2024-06-01'"}}

**Dynamic path syntax** — double-mustache `{{path}}` inside a filter string is
resolved against the current template context before the API call:

- `{{id}}` → current object's ID
- `{{slug}}` → current object's slug
- `{{post.tags}}` → expands to comma-separated tag slugs (path alias for
  `post.tags[*].slug`)
- `{{post.author}}` → expands to author slug (path alias for
  `post.author.slug`)
- `{{@custom.some_setting}}` → global template data via `@` prefix

---

#### `limit`

Number of results to return. Use `"all"` to fetch every record. Ghost's
internal cap is applied automatically (default max 100 for most resources).

    {{#get "tags" limit="all" include="count.posts"}}
    {{#get "posts" limit="6"}}

---

#### `order`

Space-separated `field direction` pairs. Direction is `asc` or `desc`.
Multiple fields are comma-separated.

    {{#get "posts" order="published_at desc"}}
    {{#get "tags" order="count.posts desc"}}
    {{#get "posts" order="published_at desc,title asc"}}

Common sortable fields: `published_at`, `title`, `slug`, `count.posts`
(tags/authors only), `created_at`, `updated_at`.

---

#### `include`

Comma-separated list of relations to sideload. Without `include`, relation
fields are `null`.

    {{!-- Load tags and authors on posts --}}
    {{#get "posts" include="tags,authors"}}

    {{!-- Load post counts on tags --}}
    {{#get "tags" include="count.posts"}}

    {{!-- Load post counts and authors for tiers --}}
    {{#get "tiers" include="monthly_price,yearly_price,benefits"}}

Available includes by resource:

- `posts` / `pages`: `tags`, `authors`, `tiers`
- `tags`: `count.posts`
- `authors`: `count.posts`
- `tiers`: `monthly_price`, `yearly_price`, `benefits`

---

#### `page`

Page number for paginated results. Works in tandem with `limit`. Defaults to 1.

    {{#get "posts" limit="5" page="2"}}

---

#### `offset`

Skip N records before returning results. Alternative to `page` for manual
windowing.

    {{!-- Skip first 3, return next 6 --}}
    {{#get "posts" limit="6" offset="3"}}

---

#### `id` / `slug` (read mode)

Passing `id` or `slug` switches from "browse" (list) to "read" (single record)
mode. The result is still wrapped in an array inside the block.

    {{#get "posts" slug="my-post-slug"}}
        {{#foreach posts}}{{title}}{{/foreach}}
    {{/get}}

---

### Per-request deduplication

Ghost deduplicates identical `{{#get}}` calls within a single page render via
an internal `_queryCache` Map keyed on resource + sorted options JSON. Identical
calls in partials that fire multiple times on a page will share the same promise.

---

## `{{#foreach}}` — Enhanced Loop


`{{#foreach}}` replaces Handlebars' native `{{#each}}` for Ghost collections.
It adds loop-position variables, windowing via `from`/`to`, column helpers, and
visibility filtering.

### Basic usage

    {{#foreach posts}}
        <article class="{{post_class}}">
            <h2><a href="{{url}}">{{title}}</a></h2>
        </article>
    {{/foreach}}

    {{!-- Loop over authors inside a post context --}}
    {{#foreach authors limit="2"}}
        <img src="{{img_url profile_image size="xs"}}" alt="{{name}}">
    {{/foreach}}

---

### Loop variables (available as `@variable`)

| Variable | Type | Description |
|---|---|---|
| `@index` | integer | 0-based position in the rendered slice |
| `@number` | integer | 1-based position (`@index + 1`) |
| `@key` | string/int | Object key or array index |
| `@first` | boolean | `true` on the first rendered item |
| `@last` | boolean | `true` on the last rendered item |
| `@odd` | boolean | `true` when `@index` is odd |
| `@even` | boolean | `true` when `@index` is even |
| `@rowStart` | boolean | `true` when `@index % columns === 0` |
| `@rowEnd` | boolean | `true` when at the last column position |

`@first` and `@last` are relative to the rendered slice, not the full array —
so if `from="3"` is set, `@first` is `true` on item 3.

---

### Parameters

#### `limit`

Caps the number of items rendered (does not slice the data; use `{{#get}}`
`limit` to reduce data fetched). Combined with `from`, determines the `to`
boundary automatically.

    {{#foreach posts limit="3"}}…{{/foreach}}

#### `from` / `to`

1-indexed window. Render items starting at position `from`, ending at `to`.
If `limit` is also set and `from + limit <= length`, `to` is overridden by
`from + limit - 1`.

    {{!-- Render items 2 through 5 --}}
    {{#foreach posts from="2" to="5"}}…{{/foreach}}

    {{!-- Skip first item (useful for hero + grid patterns) --}}
    {{#foreach posts from="2"}}…{{/foreach}}

#### `visibility`

Controls which posts are included based on their `visibility` field. Ghost
automatically defaults to `"all"` for post collections, overriding the
`"public"` default used by other iterables.

    {{!-- Explicitly show all visibility tiers (default for posts) --}}
    {{#foreach posts visibility="all"}}…{{/foreach}}

    {{!-- Only public posts --}}
    {{#foreach posts visibility="public"}}…{{/foreach}}

Valid values: `"all"`, `"public"`, `"members"`, `"paid"`, `"tiers"`.

#### `columns`

Integer that powers `@rowStart` / `@rowEnd` grid helpers.

    {{#foreach posts columns="3"}}
        {{#if @rowStart}}<div class="row">{{/if}}
            <div class="col">{{title}}</div>
        {{#if @rowEnd}}</div>{{/if}}
    {{/foreach}}

---

### `{{else}}` branch

Renders when the collection is empty.

    {{#foreach posts}}
        {{title}}
    {{else}}
        <p>No posts yet.</p>
    {{/foreach}}

---

## `{{#has}}` — Property Checks


`{{#has}}` tests properties of the current context object. It is most useful
inside post/page contexts but can be used wherever a matching object exists.
Multiple attributes in a single call are OR'd together.

Valid attributes (from source): `tag`, `author`, `slug`, `visibility`, `id`,
`number`, `index`, `any`, `all`.

---

### `tag`

Checks if the current post/page has a tag by name (case-insensitive). Comma
separates an OR list.

    {{#has tag="Video"}}
        {{> video-post-layout}}
    {{/has}}

    {{#has tag="News, Announcements"}}
        <span class="breaking">Breaking</span>
    {{/has}}

Count syntax:

    {{!-- Exactly one tag --}}
    {{#has tag="count:1"}}…{{/has}}

    {{!-- More than two tags --}}
    {{#has tag="count:>2"}}…{{/has}}

    {{!-- Fewer than four tags --}}
    {{#has tag="count:<4"}}…{{/has}}

---

### `author`

Checks author names (case-insensitive). Useful inside `{{#foreach authors}}`
loops or post contexts.

    {{#has author="count:1"}}
        {{authors}}
    {{else has author="count:2"}}
        {{authors separator=" and "}}
    {{else has author="count:>2"}}
        {{authors separator=", " limit="2"}} and others
    {{/has}}

---

### `visibility`

Checks the `visibility` field of the current post/page.

    {{#has visibility="public"}}
        <span class="free">Free</span>
    {{else has visibility="paid"}}
        <span class="premium">Members only</span>
    {{/has}}

---

### `slug` / `id`

Exact string match against the current object's `slug` or `id` field
(case-insensitive).

    {{#has slug="about"}}
        {{!-- Special layout for the About page --}}
    {{/has}}

---

### `number` / `index`

Used inside `{{#foreach}}` to check the current loop position. `number` is
1-based; `index` is 0-based. Both support an `nth:N` modulo form.

    {{#foreach posts}}
        {{#has number="1"}}
            <article class="featured">…</article>
        {{else}}
            <article>…</article>
        {{/has}}

        {{!-- Every third item --}}
        {{#has number="nth:3"}}
            <div class="clearfix"></div>
        {{/has}}
    {{/foreach}}

---

### `any` / `all`

Check whether the current object has a non-empty value for any (OR) or all
(AND) of a comma-separated property list. Supports `@data` paths for global
template data.

    {{!-- True if any of these properties exists and is non-empty --}}
    {{#has any="feature_image, custom_excerpt"}}
        {{> rich-card}}
    {{/has}}

    {{!-- True only if ALL are non-empty --}}
    {{#has all="title, feature_image, excerpt"}}
        {{> og-card}}
    {{/has}}

    {{!-- Check global data via @ prefix --}}
    {{#has any="@site.cover_image, @site.logo"}}
        {{> header-with-image}}
    {{/has}}

---

### Chaining with `{{else has}}`

`{{#has}}` supports chained `{{else has …}}` branches (similar to
`if/else if`):

    {{#has tag="Video"}}
        {{> video-layout}}
    {{else has tag="Podcast"}}
        {{> audio-layout}}
    {{else}}
        {{> default-layout}}
    {{/has}}

---

## `{{#is}}` — Context Guard


`{{#is}}` checks the current page context. Contexts are set by Ghost's router
and injected into every template as `options.data.root.context` (an array).

### Valid context strings


- `"home"` — the root `/` URL (index page, page 1 only)
- `"index"` — any page of the main post feed (includes `"home"`)
- `"post"` — a single post
- `"page"` — a static page
- `"author"` — author archive
- `"tag"` — tag archive
- `"private"` — password-protected site gate
- `"error"` — error page (404, 500, etc.)
- `"paged"` — any paginated URL (page 2+); appears alongside `"index"`,
  `"tag"`, or `"author"`
- `"preview"` — Ghost Admin preview render
- `"amp"` — AMP (Accelerated Mobile Pages) context, if enabled

A page simultaneously has multiple contexts. The home page has both `"home"`
and `"index"`. Page 2 of a tag archive has `"tag"` and `"paged"`.

### Usage

    {{#is "post"}}
        {{> post-footer}}
    {{/is}}

    {{!-- Multiple contexts are OR'd --}}
    {{#is "tag, author"}}
        <div class="taxonomy-header">…</div>
    {{/is}}

    {{#is "home"}}
        {{> hero-banner}}
    {{else is "paged"}}
        <h2>More posts</h2>
    {{else}}
        {{> standard-header}}
    {{/is}}

### Common patterns

    {{!-- Show comments only on posts, not pages --}}
    {{#is "post"}}
        {{comments}}
    {{/is}}

    {{!-- Show pagination on all list views --}}
    {{#is "index, tag, author"}}
        {{pagination}}
    {{/is}}

    {{!-- Suppress the featured image on the home page only --}}
    {{#is "home"}}
        {{!-- no feature image --}}
    {{else}}
        {{#if feature_image}}
            <img src="{{img_url feature_image size="l"}}" alt="{{title}}">
        {{/if}}
    {{/is}}

---

## `{{#match}}` — Comparison Operator


`{{#match}}` compares values with explicit operators. It works as both a block
helper and an inline helper (returns a SafeString `true`/`false`). It is
essential for `@custom` setting branches.

### Signatures

    {{!-- Single value: truthy/falsy check (like {{if}}) --}}
    {{#match value}}…{{/match}}

    {{!-- Two values: implicit equality --}}
    {{#match left right}}…{{/match}}

    {{!-- Three values: explicit operator --}}
    {{#match left operator right}}…{{/match}}

### Operators

| Operator | Meaning |
|---|---|
| `=` (default) | strict equality (`===`) |
| `!=` | strict inequality (`!==`) |
| `<` | less than |
| `>` | greater than |
| `<=` | less than or equal |
| `>=` | greater than or equal |
| `~` | string contains (case-sensitive) |
| `~^` | string starts with |
| `~$` | string ends with |

### Examples

    {{!-- @custom select option match (most common use) --}}
    {{#match @custom.hero_layout "=" "Publication logo"}}
        <div class="hero-logo">…</div>
    {{else match @custom.hero_layout "=" "No logo"}}
        {{!-- nothing --}}
    {{/match}}

    {{!-- Two-arg equality (implicit =) --}}
    {{#match @custom.appearance "dark"}}
        <link rel="stylesheet" href="{{asset "css/dark.css"}}">
    {{/match}}

    {{!-- Numeric comparison --}}
    {{#match posts.length ">" "0"}}
        <p>{{posts.length}} posts total</p>
    {{/match}}

    {{!-- String contains --}}
    {{#match title "~" "Ghost"}}
        <span class="meta">Ghost-related post</span>
    {{/match}}

### Chained `{{else match}}`

    {{#match @custom.default_post_template "Full feature image"}}
        {{> "content" width="full"}}
    {{else match @custom.default_post_template "Narrow feature image"}}
        {{> "content" width="narrow"}}
    {{else match @custom.default_post_template "Wide feature image"}}
        {{> "content" width="wide"}}
    {{else}}
        {{> "content" no_image=true}}
    {{/match}}

### Inline (non-block) usage

When called without a block body, `{{match}}` returns `"true"` or `"false"` as
a SafeString. Useful for constructing dynamic class names.

    <article class="post {{#match featured true}}is-featured{{/match}}">

---

## `{{content}}` — Post HTML


Outputs the full rendered HTML of a post. Must be used inside a post/page
context. Returns a `SafeString` (triple-stash not required).

### Basic usage

    {{content}}

### Word truncation

    {{!-- Truncate to 50 words --}}
    {{content words="50"}}

    {{!-- Truncate to 256 characters --}}
    {{content characters="256"}}

Truncation is tag-safe (uses the `downsize` library) — it will not split an
HTML tag mid-attribute.

### Access-gated content

When a post's `access` field is `false` (the member does not have access), the
helper renders the built-in `content-cta` template instead of the post HTML.
This template shows a subscription prompt. Override it by providing a custom
`content-cta.hbs` partial.

---

### Card CSS and JS

Each Koenig editor card requires matching CSS and JavaScript to render
correctly. Ghost injects `cards.min.css` and `cards.min.js` via
`{{ghost_head}}` automatically when `card_assets: true` (the default) in
`package.json`.

To exclude specific cards from the default asset bundle:

    "config": {
        "card_assets": {
            "exclude": ["bookmark", "gallery"]
        }
    }

To disable the card assets entirely:

    "config": {
        "card_assets": false
    }

When a card is excluded, you must supply your own CSS for that card type.

---

### Card CSS class reference

All cards output a root element with `kg-card` plus a card-specific class.
Width modifier classes (`kg-width-wide`, `kg-width-full`) are added for wide
and full-width variants.

| Card | Root class |
|---|---|
| Image | `kg-image-card` |
| Gallery | `kg-gallery-card` |
| Bookmark | `kg-bookmark-card` |
| Embed / video iframe | `kg-embed-card` |
| Audio | `kg-audio-card` |
| Video (upload) | `kg-video-card` |
| File download | `kg-file-card` |
| Button | `kg-button-card` |
| Callout | `kg-callout-card` |
| Toggle | `kg-toggle-card` |
| Header | `kg-header-card` |
| NFT | `kg-nft-card` |
| Product | `kg-product-card` |
| Signup | `kg-signup-card` |
| Alt blockquote | `kg-blockquote-alt` |

The `kg-image` class is on the `<img>` element inside image cards; the figure
is `kg-image-card`. Image size is controlled by `kg-width-wide` and
`kg-width-full` classes on the figure — normal width images have no extra class.

Gallery cards additionally require: `.kg-gallery-container`,
`.kg-gallery-row`, `.kg-gallery-image`. Ghost validates these are present
during theme validation (`gscan`).

---

### Image srcset output

Ghost automatically generates responsive `srcset` and `sizes` attributes on
`<img>` elements inside `{{content}}` when the image was uploaded to Ghost
Storage and resized copies exist:

    <img src="…/coastline.jpg"
        srcset="…/size/w600/coastline.jpg 600w,
                …/size/w1000/coastline.jpg 1000w,
                …/size/w1600/coastline.jpg 1600w,
                …/size/w2400/coastline.jpg 2400w"
        sizes="(min-width: 720px) 720px"
        loading="lazy" width="2000" height="3000">

External images and Unsplash images are passed through without transformation.

---

## `{{excerpt}}` — Plain-text Summary


Strips all HTML and returns a plain-text excerpt. Defaults to 50 words.

    {{excerpt}}
    {{excerpt words="30"}}
    {{excerpt characters="140"}}

If the post has a `custom_excerpt` set in the editor, it is used as-is and the
`words` limit is ignored (the full custom excerpt is returned). Only `characters`
truncation applies to custom excerpts.

---

## `{{img_url}}` — Responsive Image URLs


Transforms a Ghost-stored image path into a sized, optionally formatted URL.
Returns `undefined` (renders nothing) if the image value is `null`.

### Basic usage

    {{img_url feature_image}}
    {{img_url profile_image size="s"}}
    {{img_url @site.cover_image absolute="true"}}

The first argument is required. `{{img_url}}` with no argument logs a warning
and returns nothing.

---

### `size` parameter

Maps to a named size defined in the theme's `package.json`
`config.image_sizes` object. Ghost inserts the size into the image storage
path as `/size/w{N}/` (width) or `/size/h{N}/` (height) or both.

Themes define their own size names. A common set of conventional names:

| Name | Typical width | Common use |
|---|---|---|
| `xxs` | 45px | Avatar thumbnails (2× retina base) |
| `xs` | 90–150px | Small avatars, retina `xxs` source |
| `s` | 300–400px | Card thumbnails, tag icons |
| `m` | 600–750px | Mid-size card images |
| `l` | 800–960px | Standard post feature images |
| `xl` | 1140–1600px | Large feature images, hero images |
| `xxl` | 1920–2000px | Full-width hero, retina `xl` |

These names are not built into Ghost — they must be declared in `package.json`:

    "config": {
        "image_sizes": {
            "xs": { "width": 150 },
            "s":  { "width": 400 },
            "m":  { "width": 750 },
            "l":  { "width": 960 },
            "xl": { "width": 1140 },
            "xxl": { "width": 1920 }
        }
    }

If a requested size is not declared, `img_url` returns the original URL with
no path transformation.

---

### `format` parameter

Converts the image to a different format. Works for Ghost-stored images and
Unsplash images.

    {{img_url feature_image size="m" format="webp"}}

Supported formats: `avif`, `gif`, `jpg` (alias `jpeg`), `png`, `webp`.

Ghost checks `imageTransform.canTransformToFormat(format)` before applying
the format segment. Unsupported server-side conversions are silently skipped
and the original image is returned.

---

### `absolute` parameter

Forces an absolute URL including scheme and domain.

    {{img_url feature_image absolute="true"}}

Defaults to relative URLs. Required for Open Graph and Twitter Card meta tags.

---

### Unsplash images

Unsplash URLs (`images.unsplash.com`) are detected and handled separately.
Ghost appends `?w=N` and `?h=N` query params (or removes existing ones) and
applies `?fm=format` for format conversion. All other external images are
returned unmodified.

---

### srcset helper pattern

    <img
        srcset="{{img_url feature_image size="s"}} 400w,
                {{img_url feature_image size="m"}} 750w,
                {{img_url feature_image size="l"}} 960w"
        sizes="(min-width: 960px) 960px, 100vw"
        src="{{img_url feature_image size="m"}}"
        alt="{{title}}">

---

## `{{navigation}}` — Site Nav


Renders the site navigation configured in Ghost Admin (Design > Navigation).
Uses a built-in `navigation.hbs` template that can be overridden by placing
a `navigation.hbs` partial in your theme.

### Primary navigation

    {{navigation}}

### Secondary navigation

    {{navigation type="secondary"}}

Internally, `type="secondary"` reads `@site.secondary_navigation` instead of
`@site.navigation`. Returns an empty string if no secondary nav is configured.

### Data available inside `navigation.hbs`

Each navigation item exposes:

- `label` — display text
- `url` — absolute or relative URL as configured
- `slug` — slugified version of the label
- `current` — `true` when item URL matches the current page URL (trailing
  slashes stripped for comparison)

The `isSecondary` boolean is also available to differentiate primary vs
secondary in a shared partial.

### Custom navigation template

Create `partials/navigation.hbs` (or `navigation.hbs` at theme root) to fully
control nav markup:

    <nav class="site-nav">
        {{#foreach navigation}}
            <a class="nav-{{slug}}{{#if current}} nav-current{{/if}}"
               href="{{url}}">{{label}}</a>
        {{/foreach}}
    </nav>

---

## `{{pagination}}` — Page Links


Renders previous/next page links for paginated contexts. Uses a built-in
`pagination.hbs` template overridable via a theme partial.

**Context requirement:** `{{pagination}}` throws an error if called outside a
paginated context (i.e., when `this.pagination` is not an object). Valid
contexts: `index`, `tag`, `author`, and any route with `data.posts` + page
info. It also works inside `{{#get}}` blocks that expose pagination via block
params.

### Usage

    {{pagination}}

### Variables available in `pagination.hbs`

| Variable | Type | Description |
|---|---|---|
| `page` | number | Current page number (1-based) |
| `pages` | number | Total number of pages |
| `total` | number | Total number of matching posts |
| `limit` | number | Posts per page |
| `next` | number\|null | Next page number, or `null` on last page |
| `prev` | number\|null | Previous page number, or `null` on first page |

`next` and `prev` are page numbers, not URLs. Build URLs with:

    {{#if next}}<a href="{{page_url next}}">Older</a>{{/if}}
    {{#if prev}}<a href="{{page_url prev}}">Newer</a>{{/if}}

### Pagination in templates (typical pattern)

    {{!-- index.hbs / tag.hbs / author.hbs --}}
    {{#foreach posts}}
        {{> loop-card}}
    {{/foreach}}
    {{pagination}}

---

## `{{date}}` — Date Formatting


Formats a date using `moment-timezone`. Defaults to `published_at` of the
current context.

    {{date}}                                    {{!-- default: "Jun 5, 2024" (ll format) --}}
    {{date format="MMMM DD, YYYY"}}             {{!-- "June 05, 2024" --}}
    {{date format="YYYY-MM-DD"}}                {{!-- ISO short --}}
    {{date updated_at format="DD MMM YYYY"}}    {{!-- explicit field --}}
    {{date timeago=true}}                        {{!-- "3 days ago" --}}

Parameters:

- `format` — moment.js format string; default `"ll"` (locale-aware short date)
- `timeago` — boolean; renders relative time ("2 hours ago") instead of a
  formatted date
- `timezone` — IANA timezone string; defaults to site timezone from
  `@site.timezone`
- `locale` — BCP 47 locale string; defaults to `@site.locale`

---

## `{{prev_post}}` / `{{next_post}}`


Block helpers that fetch the chronologically adjacent post. Only valid in `post`
context; silently return the `{{else}}` branch for pages or non-post contexts.

    {{#prev_post}}
        <a href="{{url}}">← {{title}}</a>
    {{/prev_post}}

    {{#next_post}}
        <a href="{{url}}">{{title}} →</a>
    {{/next_post}}

The `in` option restricts adjacency to posts sharing a taxonomy:

    {{#prev_post in="primary_tag"}}…{{/prev_post}}
    {{#next_post in="primary_author"}}…{{/next_post}}

Valid values for `in`: `"primary_tag"`, `"primary_author"`, `"author"`.

Both helpers return an `{{else}}` branch when no adjacent post exists (first or
last post in the series).

---

## Other Inline Helpers


### `{{url}}`

Returns the relative URL of the current object. Pass `absolute="true"` for a
full URL.

    <a href="{{url}}">{{title}}</a>
    <link rel="canonical" href="{{url absolute="true"}}">

### `{{title}}`

Outputs the post/page/tag/author title. Safe for use in all contexts where the
object has a `title` property.

### `{{tags}}`

Renders a list of tags for the current post.

    {{tags}}
    {{tags separator=" · "}}
    {{tags separator=", " autolink="false"}}
    {{tags separator=" " prefix="In " suffix="."}}
    {{tags limit="3" visibility="public"}}

Parameters: `separator` (default `", "`), `prefix`, `suffix`, `limit`,
`autolink` (default `true`), `visibility`.

### `{{authors}}`

Renders a list of authors for the current post.

    {{authors}}
    {{authors separator=" & "}}
    {{authors limit="2"}}

Accepts the same parameters as `{{tags}}`.

### `{{post_class}}`

Outputs space-separated CSS classes for the current post article element.
Includes `post`, `featured` (if `featured:true`), `tag-{slug}` for each tag.

    <article class="{{post_class}}">

### `{{body_class}}`

Outputs body-level CSS classes. Includes context classes (`home-template`,
`post-template`, `tag-template`, `author-template`, `page-template`,
`page-{slug}`, `tag-{slug}`, `paged`). Also appends custom font classes when
brand fonts are configured.

### `{{ghost_head}}`

Required in `<head>`. Injects SEO meta, Open Graph tags, structured data,
`cards.min.css`, `cards.min.js`, code injections, and member scripts. Must
appear once in `default.hbs`.

### `{{ghost_foot}}`

Required before `</body>`. Injects footer code injections and member
scripts. Must appear once in `default.hbs`.

### `{{asset}}`

Returns a cache-busted URL for a theme asset file.

    <link rel="stylesheet" href="{{asset "css/screen.css"}}">
    <script src="{{asset "js/main.js"}}"></script>

### `{{t}}`

Translates a string using the theme's `locales/` directory.

    {{t "Read More"}}
    {{t "By"}} {{authors}}

### `{{social_url}}`

Returns a social profile URL given a `type` and the current author context.

    <a href="{{social_url type="twitter"}}">Twitter</a>

Supported types: `twitter`, `facebook`, `linkedin`, `bluesky`, `threads`,
`mastodon`, `tiktok`, `youtube`, `instagram`.

### `{{excerpt}}`

See [dedicated section above](#excerpt--plain-text-summary).

### `{{encode}}`

URL-encodes a string. Useful for building share links.

    <a href="https://twitter.com/intent/tweet?text={{encode title}}&url={{encode (url absolute="true")}}">
        Share on Twitter
    </a>

### `{{plural}}`

Singular/plural output based on a count.

    {{plural ../pagination.total empty='No posts' singular='% post' plural='% posts'}}

### `{{reading_time}}`

Estimates reading time in minutes for the current post.

    <span>{{reading_time}}</span>
    {{reading_time minute="1 min" minutes="% mins"}}

### `{{comments}}` / `{{comment_count}}`

`{{comments}}` renders the Ghost native comments widget. Only active when
comments are enabled in site settings. Use inside `{{#is "post"}}`.

    {{#is "post"}}
        {{#post}}{{comments}}{{/post}}
    {{/is}}

`{{comment_count}}` renders an inline count for a specific post.

### `{{cancel_link}}`

Renders a "cancel subscription" link. Only active for logged-in paying members.

### `{{content_api_key}}` / `{{content_api_url}}`

Output the Ghost Content API key and URL configured for the current site.
Used when building client-side search or other JS-driven API consumers.

---

## Context × Helper Compatibility Matrix


Some helpers only function in specific contexts. Others fail silently or throw.

| Helper | `post` | `page` | `index` | `tag` | `author` | `home` | Notes |
|---|---|---|---|---|---|---|---|
| `{{content}}` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | Only inside `{{#post}}` / `{{#page}}` |
| `{{excerpt}}` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | Inside post/page scope only |
| `{{prev_post}}` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | Returns `{{else}}` for pages |
| `{{next_post}}` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | Returns `{{else}}` for pages |
| `{{comments}}` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | `is "post"` guard required |
| `{{pagination}}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✓¹ | Throws outside paginated context |
| `{{#foreach posts}}` | ✗² | ✗² | ✓ | ✓ | ✓ | ✓ | `posts` not available in post context |
| `{{#get}}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Works anywhere; async |
| `{{navigation}}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Always available via `@site` |
| `{{#has tag=}}` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | Requires `tags` on the context object |
| `{{#has author=}}` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | Requires `authors` on context |
| `{{#has number=}}` | inside `{{#foreach}}` only | — | — | — | — | — | Uses loop frame data |
| `{{social_url}}` | — | — | — | — | ✓³ | — | Inside `{{#author}}` block |
| `{{reading_time}}` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | Post/page context only |

¹ `{{pagination}}` on the home page works when `home` is also `index` (page 1);
  it renders empty prev/next but does not throw if `pagination` data is present.

² `posts` is not in the template data for a single post context, but you can
  use `{{#get "posts"}}` to load posts from any template.

³ `{{social_url}}` reads fields from the current author object — use it inside
  `{{#author}}` or `{{#foreach authors}}`.

---

### Context detection quick reference


Use `{{#is}}` to branch on context:

    {{#is "home"}}          {{!-- / only (page 1 of index) --}}
    {{#is "index"}}         {{!-- all pages of main feed --}}
    {{#is "post"}}          {{!-- single post --}}
    {{#is "page"}}          {{!-- static page --}}
    {{#is "tag"}}           {{!-- tag archive --}}
    {{#is "author"}}        {{!-- author archive --}}
    {{#is "paged"}}         {{!-- page 2+ of any list --}}
    {{#is "error"}}         {{!-- error page --}}
    {{#is "post, page"}}    {{!-- OR: either context --}}
