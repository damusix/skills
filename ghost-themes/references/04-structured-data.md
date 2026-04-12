# Structured Data & SEO (JSON-LD)

Ghost emits all SEO meta — JSON-LD, OpenGraph, Twitter Card, canonical URL, and `<meta name="description">` — automatically via `{{ghost_head}}`. This reference documents exactly what Ghost emits, which fields you can influence from theme code or admin settings, and when to add custom structured data vs. leave Ghost's output alone.

---

## How Ghost Emits Structured Data

`{{ghost_head}}` calls `getMetaData()` which assembles a `metaData` object, then calls two functions:

- `getStructuredData(metaData)` — produces the flat key/value map that becomes `<meta property="og:*">` and `<meta name="twitter:*">` tags.
- `getSchema(metaData, data)` — produces the JSON-LD object that is serialized into `<script type="application/ld+json">`.

Both are suppressed on paginated pages (`context` includes `paged`). Both are suppressed when the privacy config key `useStructuredData` is disabled. Preview pages get `noindex,nofollow` instead of structured data.

The injection order inside `{{ghost_head}}` output is:

1. `<meta name="description">`
2. Favicon `<link rel="icon">`
3. `<link rel="canonical">`
4. Referrer policy meta tag
5. `<link rel="prev">` / `<link rel="next">` (paginated only)
6. OpenGraph / Twitter `<meta>` tags (non-paginated only)
7. `<script type="application/ld+json">` (non-paginated only)
8. Generator meta, RSS link, Portal/Search/Announcement scripts, card assets
9. Global `codeinjection_head` (site-level Settings → Code injection)
10. Post/page `codeinjection_head` (per-post Code injection panel)
11. Tag `codeinjection_head` (per-tag settings)
12. Custom font CSS

---

## JSON-LD Schema Shapes by Context

Ghost selects a schema type based on the page context array. The dispatcher in `getSchema()`:

    if context includes 'post' OR 'page'  → Article
    if context includes 'home'            → WebSite
    if context includes 'tag'             → Series
    if context includes 'author'          → Person

### Post and Page — `Article`

    {
      "@context": "https://schema.org",
      "@type": "Article",
      "publisher": {
        "@type": "Organization",
        "name": "<site title>",
        "url": "<site url>",
        "logo": {
          "@type": "ImageObject",
          "url": "<logo url>",
          "width": <w>,
          "height": <h>
        }
      },
      "author": {
        "@type": "Person",
        "name": "<primary_author.name>",
        "image": {
          "@type": "ImageObject",
          "url": "<primary_author.profile_image>"
        },
        "url": "<author page url>",
        "sameAs": ["<website>", "<facebook url>", "<twitter url>", ...],
        "description": "<primary_author.meta_description>"
      },
      "contributor": [
        {
          "@type": "Person",
          "name": "<co-author name>",
          "image": { "@type": "ImageObject", "url": "..." },
          "url": "...",
          "sameAs": [...],
          "description": "..."
        }
      ],
      "headline": "<meta title>",
      "url": "<post url>",
      "datePublished": "<ISO 8601>",
      "dateModified": "<ISO 8601>",
      "image": {
        "@type": "ImageObject",
        "url": "<feature_image>",
        "width": <w>,
        "height": <h>
      },
      "keywords": "tag1, tag2, tag3",
      "description": "<excerpt>",
      "mainEntityOfPage": "<post url>"
    }

Fields with `null` values are stripped by `trimSchema()` before output — missing authors, no feature image, no tags will simply omit those keys.

The `contributor` array contains `authors[1..n]` (all authors except the primary). It is `null` and omitted when the post has only one author.

`sameAs` for an author is built from `author.website` plus any of: `facebook`, `twitter`, `threads`, `bluesky`, `mastodon`, `tiktok`, `youtube`, `instagram`, `linkedin`. Each non-empty field is run through `@tryghost/social-urls` to produce a full URL.

### Home — `WebSite`

    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "publisher": {
        "@type": "Organization",
        "name": "<site title>",
        "url": "<site url>",
        "logo": { "@type": "ImageObject", "url": "...", "width": <w>, "height": <h> }
      },
      "url": "<site url>",
      "name": "<site title>",
      "image": {
        "@type": "ImageObject",
        "url": "<site cover_image>"
      },
      "mainEntityOfPage": "<site url>",
      "description": "<site meta_description>"
    }

### Tag Archive — `Series`

    {
      "@context": "https://schema.org",
      "@type": "Series",
      "publisher": {
        "@type": "Organization",
        "name": "<site title>",
        "url": "<site url>",
        "logo": { "@type": "ImageObject", "url": "..." }
      },
      "url": "<tag archive url>",
      "image": {
        "@type": "ImageObject",
        "url": "<tag.og_image or tag.feature_image or site cover_image>"
      },
      "name": "<tag.name>",
      "mainEntityOfPage": "<tag archive url>",
      "description": "<tag.meta_description or tag.description>"
    }

### Author Archive — `Person`

    {
      "@context": "https://schema.org",
      "@type": "Person",
      "sameAs": ["<website>", "<facebook>", "<twitter>", ...],
      "name": "<author.name>",
      "url": "<author archive url>",
      "image": {
        "@type": "ImageObject",
        "url": "<author.profile_image or author.cover_image>"
      },
      "mainEntityOfPage": "<author archive url>",
      "description": "<author.meta_description or author.bio>"
    }

The author image resolves to `author-image.js` for post/page contexts (primary author's `profile_image`) and falls back to `cover-image.js` for the author archive itself.

---

## Auto-Populated vs. Theme-Supplementable Fields

All JSON-LD is built entirely from Ghost's data layer. Themes have no Handlebars API to modify the JSON-LD object before it is emitted. Fields are populated as follows.

### Auto-Populated (no theme action required)

- Post `headline` — resolved from `post.og_title → post.meta_title → post.title`
- Post `description` — resolved from `post.custom_excerpt → post.meta_description → auto-excerpt (50 words)`
- Post `datePublished` / `dateModified` — from `post.published_at` / `post.updated_at`
- Post `keywords` — from all tags on the post, joined with `, `
- Post `author.sameAs` — auto-built from every social field populated on the author record
- Publisher block — always uses site title, site URL, and the blog logo from settings
- Home `name` / `description` — from site title and `meta_description` setting
- Tag `name` — from `tag.name`
- Author `name` / `url` — from author record

### Theme-Supplementable (editor or settings input)

These fields appear in the JSON-LD only when the corresponding admin field is filled in:

| JSON-LD field | Where to set it |
|---|---|
| Post `image` | Post feature image |
| Post `description` | Post custom excerpt or SEO meta description |
| Post `author.image` | Author profile image |
| Post `author.description` | Author bio (falls back from `meta_description`) |
| Post `author.sameAs` | Author social links (website + all platform fields) |
| Post `contributor[].sameAs` | Co-author social fields |
| Home `image` | Site cover image (Settings → Design) |
| Home `description` | Site meta description (Settings → SEO) |
| Tag `image` | Tag feature image or OG image |
| Tag `description` | Tag description or meta description |
| Author `image` | Author profile image or cover image |
| Author `description` | Author meta description or bio |
| Publisher `logo` | Site logo (Settings → Design) |

---

## When NOT to Add Custom JSON-LD

Do not add a second `Article`, `WebSite`, `Series`, or `Person` block in a theme. Ghost already emits these correctly and duplicate type declarations for the same URL will confuse validators and may dilute signal for crawlers.

Specifically, avoid:

- A hand-written `Article` in `post.hbs` — Ghost emits one automatically.
- A `WebSite` with `SearchAction` potential action baked into a theme partial — Ghost owns this type for the home context.
- Re-declaring `Person` for the author in `author.hbs`.
- Injecting JSON-LD via `codeinjection_head` at the site level that duplicates Ghost's `WebSite` block.

### When You SHOULD Add Custom JSON-LD

Add custom JSON-LD via `codeinjection_head` (post-level or site-level) or via a theme partial only when Ghost does not emit it:

- **`BreadcrumbList`** — Ghost does not emit breadcrumbs. Add via a Handlebars partial using `{{#get}}` data or static values.
- **`FAQPage`** — Ghost emits `Article`, not FAQ markup. Use post-level `codeinjection_head` for posts that are structured as FAQs.
- **`HowTo`** — Same reasoning; Ghost has no HowTo type.
- **`Product`** — For e-commerce or review posts, Ghost's `Article` does not carry `offers` or `aggregateRating`.
- **`Event`** — Ghost does not emit Event schema for any context.
- **`Organization` with `sameAs`** — The publisher block Ghost emits has `name`, `url`, and `logo` but no `sameAs` array for the publication's own social profiles. If you need that, add a supplemental `Organization` block via site-level `codeinjection_head`.

When adding supplemental JSON-LD via a theme partial, use a separate `<script type="application/ld+json">` block. Multiple valid JSON-LD blocks on a page are fine per the spec.

---

## OpenGraph and Twitter Card Meta

`getStructuredData()` produces the following flat properties. Each becomes one `<meta>` tag via `finaliseStructuredData()` in `ghost_head.js`.

### OpenGraph Tags

    og:site_name      → site.title
    og:type           → 'article' (post), 'profile' (author), 'website' (all others)
    og:title          → post.og_title → post.meta_title → post.title  (post context)
                        tag.og_title  → tag.meta_title  → tag.name    (tag context)
                        site og_title → site title                     (home)
    og:description    → post.og_description → post.custom_excerpt → post.meta_description → 50-word excerpt (post)
                        tag.og_description  → tag.meta_description → tag.description      (tag)
                        site og_description → site meta_description → site description    (home)
    og:url            → canonical URL
    og:image          → post.og_image → post.feature_image → site og_image → site cover_image
    og:image:width    → resolved from image dimensions (async fetch)
    og:image:height   → resolved from image dimensions (async fetch)
    article:published_time  → post.published_at   (post/page only)
    article:modified_time   → post.updated_at     (post/page only)
    article:tag       → one <meta> per tag (expanded from keywords array)
    article:publisher → facebook page URL from site settings (if set)
    article:author    → author's Facebook URL (if set on author record)

### Twitter Card Tags

    twitter:card        → 'summary_large_image' if any image resolves; else 'summary'
    twitter:title       → post.twitter_title → post.meta_title → post.title  (post)
    twitter:description → post.twitter_description → post.custom_excerpt → post.meta_description → 50-word excerpt
    twitter:url         → canonical URL
    twitter:image       → post.twitter_image → post.feature_image (resolved same as og:image but separate field)
    twitter:label1      → 'Written by'  (only when authorName is set)
    twitter:data1       → primary author name
    twitter:label2      → 'Filed under'  (only when keywords exist)
    twitter:data2       → comma-joined tag list
    twitter:site        → site Twitter handle from settings
    twitter:creator     → post author's Twitter handle

The Twitter card type is determined purely by image presence. If `metaData.twitterImage` or `metaData.coverImage.url` is truthy, the card is `summary_large_image`; otherwise `summary`.

All OpenGraph and Twitter tags are suppressed on paginated pages (context includes `paged`). This prevents duplicate og:url signals across `/tag/news/`, `/tag/news/page/2/`, etc.

---

## How `codeinjection_head` Interacts with Theme Meta

Ghost resolves three sources of code injection and appends them at the end of the `{{ghost_head}}` output, after all meta, structured data, and script tags:

    1. globalCodeinjection   → Settings → Code injection → Site header
    2. postCodeInjection     → dataRoot.post.codeinjection_head (post/page editor)
    3. tagCodeInjection      → dataRoot.tag.codeinjection_head (tag settings)

All three are appended unconditionally if non-empty (`_.isEmpty` check). They appear after Ghost's own meta, so any tags they contain are not deduplicated against Ghost's output. This means:

- Injecting a second `<meta property="og:title">` via `codeinjection_head` will produce a duplicate tag. Crawlers generally use the first occurrence. Prefer leaving OG/Twitter fields empty in injection and using Ghost's built-in fields instead.
- Injecting a `<script type="application/ld+json">` via `codeinjection_head` is safe and will not conflict with Ghost's JSON-LD block, as long as the types are different or the `@id` values do not overlap.
- Tag-level `codeinjection_head` fires on every page that renders within that tag's archive, but only when `dataRoot.tag` is set — i.e., the tag archive page itself, not individual posts filtered by that tag.

The global injection fires on every non-500 page. Post injection fires only when `dataRoot.post` is present (post and page contexts).

---

## Canonical URL Behavior

`getCanonicalUrl()` in `canonical-url.js` uses this resolution order:

### Posts and Pages

1. If `post.canonical_url` is explicitly set (via the post settings panel), use it verbatim.
2. Otherwise, construct from site URL + post's relative URL path.

This means you can override the canonical on any post or page to point to an external URL or a different internal path. Ghost will emit that override in both `<link rel="canonical">` and `og:url` / `twitter:url`.

### Tags

1. If `tag.canonical_url` is set, use it verbatim.
2. Otherwise, construct from site URL + tag archive relative URL.

### Paginated Collections

`getPaginatedUrl()` constructs `<link rel="prev">` and `<link rel="next">` for paginated archive pages. The pattern is:

    Page 1:  /tag/news/           (no prev)   next → /tag/news/page/2/
    Page 2:  /tag/news/page/2/    prev → /tag/news/   next → /tag/news/page/3/
    Page N:  /tag/news/page/N/    prev → /tag/news/page/N-1/   (no next)

On page 2+, the canonical URL is the page's own URL (`/tag/news/page/2/`), not page 1. Ghost does not consolidate paginated archives under the first page's canonical. OpenGraph and JSON-LD schema are entirely suppressed on all pages where `context` includes `paged` — only canonical, prev/next links, and meta description are emitted for paginated pages.

### Home

The home page canonical is always the site's root URL. There is no override mechanism for the home canonical from theme code.

---

## Title and Description Resolution Summary

Understanding the fallback chains is essential for knowing when admin-set fields take effect.

### Meta Title Fallback (for `<title>` and `og:title`, `twitter:title`)

    post context:    post.og_title / post.twitter_title → post.meta_title → post.title
    page context:    page.og_title / page.twitter_title → page.meta_title → page.title
    tag context:     tag.og_title  / tag.twitter_title  → tag.meta_title  → tag.name + ' - Site Title'
    author context:  author.name + ' - Site Title'
    home context:    site og_title / site twitter_title → site meta_title → site title
    paged context:   base title + ' (Page N)'

### Meta Description Fallback (for `<meta name="description">`)

    post/page:  post.meta_description → post.custom_excerpt  (no auto-excerpt for plain description)
    tag:        tag.meta_description  → tag.description  (empty on paged)
    author:     author.meta_description → author.bio  (empty on paged)
    home:       site.meta_description → site.description

### OG/Twitter Description Fallback

    post/page:  post.og_description / post.twitter_description
                → post.custom_excerpt → post.meta_description → auto-excerpt (50 words)
                → site description (final fallback)
    tag:        tag.og_description → tag.meta_description → tag.description → site meta_description
    home:       site og_description / twitter_description → site meta_description → site description

The key difference: `<meta name="description">` for posts does **not** auto-generate an excerpt — it is blank unless `meta_description` or `custom_excerpt` is set. The OG and Twitter descriptions do auto-generate a 50-word excerpt as a final fallback.
