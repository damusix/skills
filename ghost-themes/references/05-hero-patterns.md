# Hero Section & Layout Patterns


## Overview


Hero sections and layout variants are among the most common customization targets in Ghost themes. This reference covers hero variant patterns for production Ghost 5+ themes, including the full `@custom` settings system, responsive image strategy, featured post carousels, archive page headers, and feature image caption/alt handling.

All code blocks are complete partials an agent can copy directly.


---


## 1. The `@custom` Settings System


Ghost themes declare custom settings in `package.json` under `config.custom`. These are exposed in the Ghost Admin Design panel and accessed in templates as `@custom.<key>`.


### Defining Custom Settings (`package.json`)


    {
        "config": {
            "custom": {
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
                "show_featured_posts": {
                    "type": "boolean",
                    "default": true,
                    "group": "homepage"
                },
                "featured_title": {
                    "type": "text",
                    "default": "Featured",
                    "group": "homepage"
                },
                "feed_title": {
                    "type": "text",
                    "default": "Latest Stories",
                    "group": "homepage"
                },
                "show_feed_featured_image": {
                    "type": "boolean",
                    "default": false,
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
            }
        }
    }

**Key rules:**

- `type` must be one of: `"select"`, `"text"`, `"boolean"`, `"color"`, `"image"`
- `group` controls which Admin tab the setting appears in (`"homepage"`, `"post"`, etc.)
- `options` is required for `"select"` type
- Access in templates as `@custom.key_name` — underscores map directly
- Use `{{#match @custom.key "=" "Value"}}` for equality checks in templates


---


## 2. Homepage Hero Variants


### 2.1 Full Homepage Hero with Logo Toggle (`index.hbs`)


A common pattern is a self-contained hero block at the top of `index.hbs`. It uses `{{#match}}` to conditionally render the site logo image, then always renders the text content section.

    {{!< default}}

    <div class="content-area">
        <main class="site-main">
            <div class='hero-wrapper container'>
                <div class='hero-grid'>
                    {{#match @custom.hero_layout "=" "Publication logo"}}
                        <div class="hero-image">
                            {{#if @site.cover_image}}
                                <img class="gh-about-image round"
                                    src="{{img_url @site.cover_image size="m"}}"
                                    alt="{{@site.title}}">
                            {{/if}}
                        </div>
                    {{/match}}

                    <section class='hero-content'>
                        {{#if @custom.primary_header}}
                            <h1 class="single-title center-text">{{{@custom.primary_header}}}</h1>
                        {{/if}}
                        {{#if @custom.secondary_header}}
                            <p class="single-excerpt center-text">{{{@custom.secondary_header}}}</p>
                        {{/if}}
                        {{#if @site.members_enabled}}
                            {{#unless @member}}
                                {{> subscription-box}}
                            {{/unless}}
                        {{/if}}
                    </section>
                </div>
            </div>

            {{#if @custom.show_featured_posts}}
                {{> featured-posts}}
            {{/if}}

            <section class="kg-canvas">
                <div class="kg-width-wide">
                    <header class="feed-header">
                        {{#if @custom.feed_title}}
                            <div class="feed-header-wrapper">
                                <div class="feed-header-title">{{@custom.feed_title}}</div>
                            </div>
                        {{/if}}
                    </header>

                    <div class="post-feed gh-feed">
                        <div class="kg-grid kg-grid-3col kg-gallery-grid">
                            {{#foreach posts}}
                                {{> "loop-card"}}
                            {{/foreach}}
                        </div>
                    </div>
                    {{pagination}}
                </div>
            </section>
        </main>
    </div>

    {{#contentFor "body_class"}}{{#if next}} paged-next{{/if}}{{#if @member}} logged-in{{/if}}{{/contentFor}}

**Critical details:**

- `{{{@custom.primary_header}}}` uses triple-stash to allow HTML in the admin-entered text
- `@site.cover_image` is the publication cover image set in Ghost Admin → Design → Brand
- `@site.members_enabled` is a Ghost global that is `true` when Memberships are on
- `{{pagination}}` is a Ghost built-in helper — no partial needed


### 2.2 Hero Variants by `hero_layout` Value


| `@custom.hero_layout` | What renders |
|---|---|
| `"Publication logo"` | Cover image shown above hero text |
| `"No logo"` (or any other value) | Only text content block, no image |

The `{{#match}}` block for the logo only fires on exact string match. Any non-matching value (or unset) silently renders nothing in the logo slot.


### 2.3 Subscription Box Partial (`partials/subscription-box.hbs`)


Used inside the hero content section for members-enabled sites. Always wrapped in `{{#unless @member}}` so logged-in members don't see it.

    {{#unless @member}}
        <form class="form-wrapper cover-form inline-form" data-members-form>
            <input class="auth-email"
                type="email"
                data-members-email
                placeholder="{{t 'Your email...'}}"
                required="true"
                autocomplete="false">

            <button class="button button-primary form-button" type="submit" aria-label="Subscribe">
                <span class="default">{{t 'Subscribe'}}</span>
                <span class="loader">{{> icons/loader}}</span>
                <span class="success">{{t 'Email sent. Check your inbox'}}</span>
            </button>
        </form>
    {{/unless}}

- `data-members-form` activates Ghost's built-in membership JS form handling
- `data-members-email` binds the input to Ghost's subscriber flow
- Multi-state button spans (`default`, `loader`, `success`) are driven by Ghost's JS — no custom code needed
- `{{t '...'}}` is Ghost's i18n translation helper


---


## 3. Post Layout Variants: The 4 Custom Templates


One approach is to implement four distinct post feature image layouts. These exist as separate template files that override the default `post.hbs` for a specific post, **and** as a `@custom` setting that sets the global default for all posts.


### 3.1 The Global Default Dispatcher (`post.hbs`)


`post.hbs` uses `{{#match}}` to select the layout based on `@custom.default_post_template`:

    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{#match @custom.default_post_template "Full feature image"}}
                {{> "content" width="full" full=true}}
            {{else match @custom.default_post_template "Narrow feature image"}}
                {{> "content" width="narrow"}}
            {{else match @custom.default_post_template "Wide feature image"}}
                {{> "content" width="wide"}}
            {{else}}
                {{> "content" no_image=true}}
            {{/match}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>

The `{{> "content" width="full" full=true}}` syntax passes **hash arguments** to the partial — these become available as `{{width}}` and `{{full}}` inside `content.hbs`.


### 3.2 The Four Custom Template Files


Each custom template file overrides `post.hbs` for an individual post when selected in Ghost Admin → Post settings → Template. The file naming convention `custom-<slug>.hbs` is required by Ghost.


**`custom-full-feature-image.hbs`** — Full-bleed hero image:

    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{> "content" width="full" full=true}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>


**`custom-narrow-feature-image.hbs`** — Contained-width image (matches content column):

    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{> "content" width="full" full=true}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>

Note: `custom-narrow-feature-image.hbs` and `custom-full-feature-image.hbs` can share identical markup (`width="full" full=true`). The visual difference comes from CSS classes driven by the `width` value on the `<figure>` element inside `content.hbs`.


**`custom-wide-feature-image.hbs`** — Wider-than-content image:

    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{> "content" width="narrow"}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>


**`custom-no-feature-image.hbs`** — Suppresses the feature image entirely:

    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{> "content" no_image=true}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>


### 3.3 Layout Parameter Reference


| Template file | Hash args passed | Visual result |
|---|---|---|
| `custom-full-feature-image.hbs` | `width="full" full=true` | Full-bleed, edge-to-edge |
| `custom-narrow-feature-image.hbs` | `width="full" full=true` | Same markup as full (visual difference driven by CSS) |
| `custom-wide-feature-image.hbs` | `width="narrow"` | Contained/narrow image |
| `custom-no-feature-image.hbs` | `no_image=true` | Image suppressed, horizontal rule shown |

The `width` value maps to CSS class `kg-width-{width}` on the `<figure>` element (e.g., `kg-width-full`, `kg-width-narrow`, `kg-width-wide`). These are standard Ghost Koenig canvas width classes.


---


## 4. The Content Partial: Feature Image + Caption + Alt (`partials/content.hbs`)


This is the core post rendering partial. It receives `width` and `no_image` as hash args from the calling template.

    <article class="single ghost-content {{post_class}}">

        {{#match @page.show_title_and_feature_image}}
        <header class="single-header kg-canvas">
            {{#is "post"}}
                <div class="single-meta">
                    {{^has visibility="public"}}
                        <span class="single-meta-item single-visibility">
                            {{#has visibility="tiers"}}
                                {{> icons/star}}
                                {{tiers}}-only post
                            {{else}}
                                {{> icons/star}}
                                {{visibility}}-only post
                            {{/has}}
                        </span>
                    {{/has}}
                    <span class="single-meta-item single-meta-length">
                        {{ reading_time minute=(t '1 min read') minutes=(t '% min read') }}
                    </span>
                    {{#primary_tag}}
                        <span class="single-meta-item single-meta-tag">
                            <a class="post-tag post-tag-{{slug}}" href="{{url}}">{{name}}</a>
                        </span>
                    {{/primary_tag}}
                </div>
            {{/is}}

            <h1 class="single-title">{{title}}</h1>

            {{#if custom_excerpt}}
                <div class="single-excerpt">
                    {{custom_excerpt}}
                </div>
            {{/if}}

            {{#is "post"}}
                <div class="single-footer-top">
                    <div class="author-list">
                        {{#foreach authors limit="3"}}
                            <div class="author-image-placeholder u-placeholder square">
                                <a href="{{url}}" title="{{name}}">
                                    {{#if profile_image}}
                                        <img class="author-image u-object-fit"
                                            src="{{img_url profile_image size="xs"}}"
                                            alt="{{name}}"
                                            loading="lazy">
                                    {{else}}
                                        <span class="u-object-fit">{{> icons/avatar}}</span>
                                    {{/if}}
                                </a>
                            </div>
                        {{/foreach}}
                        <div class="author-wrapper">
                            <h4 class="author-name">
                                <span class="text-bold">{{authors}}</span>
                            </h4>
                            <div class="single-meta-item single-meta-date text-italic">
                                <span>{{t 'on'}}</span>
                                <time datetime="{{date format="dddd-YYYY-MM-DD"}}">
                                    {{date published_at format="MMM DD, YYYY"}}
                                </time>
                            </div>
                        </div>
                    </div>
                    {{> content-share}}
                </div>
            {{/is}}

            {{#if feature_image}}
                {{#unless no_image}}
                    <figure class="single-media kg-width-{{width}}">
                        <img
                            srcset="{{img_url feature_image size="l"}} 750w,
                                    {{img_url feature_image size="xl"}} 1140w,
                                    {{img_url feature_image size="xxl"}} 1920w"
                            sizes="(min-width: 1023px) 920px, 100vw"
                            src="{{img_url feature_image size="xxl"}}"
                            alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}">

                        {{#if feature_image_caption}}
                            <figcaption>{{feature_image_caption}}</figcaption>
                        {{/if}}
                    </figure>
                {{/unless}}
            {{/if}}

            {{#if no_image}}
                <hr class="gh-content-line">
            {{/if}}
        </header>
        {{/match}}

        <div class="single-content gh-content kg-canvas">
            {{content}}
        </div>

        {{#is "post"}}
            {{#unless @member}}
                {{#has visibility="public"}}
                    <div class="single-content gh-content kg-canvas">
                        <div class="single-cta">
                            <h3 class="single-cta-title">
                                {{#if @custom.email_signup_text}}
                                    {{@custom.email_signup_text}}
                                {{else}}
                                    {{@site.description}}
                                {{/if}}
                            </h3>
                            <p class="single-cta-desc">
                                {{#if @custom.email_signup_desc}}
                                    {{@custom.email_signup_desc}}
                                {{/if}}
                            </p>
                            {{> subscription-box}}
                        </div>
                    </div>
                {{/has}}
            {{/unless}}
        {{/is}}
    </article>


---


## 5. Feature Image Caption and Alt Text Handling


Ghost provides two dedicated post fields for feature image metadata:

- `feature_image_alt` — the alt attribute text (plain text, set in post editor)
- `feature_image_caption` — the caption displayed below the image (can contain HTML)


### The Correct Pattern


    <figure class="single-media kg-width-{{width}}">
        <img
            src="{{img_url feature_image size="xxl"}}"
            alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}">

        {{#if feature_image_caption}}
            <figcaption>{{feature_image_caption}}</figcaption>
        {{/if}}
    </figure>

**Rules:**

- Always fall back to `{{title}}` when `feature_image_alt` is empty — never use an empty `alt=""`
- `feature_image_caption` may contain HTML (set via the Ghost editor's caption field) — use `{{feature_image_caption}}` not `{{{feature_image_caption}}}` since Ghost escapes it safely
- Wrap in `{{#if feature_image_caption}}` — render no `<figcaption>` at all when empty, rather than an empty tag
- The `<figure>` + `<figcaption>` structure is semantically correct and expected by Ghost's default CSS


### Suppressing the Image (`no_image=true`)


When the no-feature-image layout is selected, show a visual separator instead:

    {{#if feature_image}}
        {{#unless no_image}}
            <figure ...>...</figure>
        {{/unless}}
    {{/if}}

    {{#if no_image}}
        <hr class="gh-content-line">
    {{/if}}

The double-check (`{{#if feature_image}}` then `{{#unless no_image}}`) ensures the `<figure>` only renders when the post actually has an image AND the layout doesn't suppress it.


---


## 6. Responsive Image Strategy with srcset + sizes


### The `image_sizes` Declaration (`package.json`)


Ghost resizes images at upload time into named buckets declared in `package.json`:

    {
        "config": {
            "image_sizes": {
                "xs":  { "width": 150  },
                "s":   { "width": 400  },
                "m":   { "width": 750  },
                "l":   { "width": 960  },
                "xl":  { "width": 1140 },
                "xxl": { "width": 1920 }
            }
        }
    }

These size names map directly to the `size` parameter of `{{img_url}}`.


### The srcset Partial (`partials/srcset.hbs`)


A reusable partial that outputs the four standard srcset descriptors:

    {{img_url feature_image size="s"}} 400w,
    {{img_url feature_image size="m"}} 750w,
    {{img_url feature_image size="l"}} 960w,
    {{img_url feature_image size="xl"}} 1140w

Usage inside an `<img>`:

    <img
        srcset="{{> srcset}}"
        sizes="(min-width: 1256px) calc((1130px - 60px) / 2), (min-width: 992px) calc((90vw - 60px) / 2), (min-width: 768px) calc((90vw - 30px) / 2), 90vw"
        src="{{img_url feature_image size="m"}}"
        alt="{{title}}"
        loading="lazy">

The `sizes` attribute here is the loop card formula (two-column grid layout). The `src` fallback uses `size="m"` as a reasonable mid-range default.


### Full Hero Image srcset (content.hbs pattern)


For single-column post hero images, a common pattern uses a larger range:

    <img
        srcset="{{img_url feature_image size="l"}} 750w,
                {{img_url feature_image size="xl"}} 1140w,
                {{img_url feature_image size="xxl"}} 1920w"
        sizes="(min-width: 1023px) 920px, 100vw"
        src="{{img_url feature_image size="xxl"}}"
        alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}">

The `sizes` breakpoint here (`920px` at viewport ≥ 1023px) reflects the fixed content column width. Below that breakpoint it's full viewport width (`100vw`).


### Sizes Formula Reference


| Context | `sizes` value |
|---|---|
| Post hero (single column) | `(min-width: 1023px) 920px, 100vw` |
| Two-column card grid | `(min-width: 1256px) calc((1130px - 60px) / 2), (min-width: 992px) calc((90vw - 60px) / 2), (min-width: 768px) calc((90vw - 30px) / 2), 90vw` |
| Author/tag avatar (square) | Use `size="s"` only, no srcset needed |


### `loading="lazy"` Policy


- Feed cards and thumbnails: always add `loading="lazy"`
- Post hero/feature image: omit `loading="lazy"` — it is above the fold and should load eagerly
- Author avatars in post header: add `loading="lazy"` (they render below the title)


---


## 7. Featured Posts Carousel Pattern (`partials/featured-posts.hbs`)


Uses `{{#get}}` to fetch posts with `featured:true` independent of the current page context.

    {{#get "posts" filter="featured:true" include="authors,tags" limit="2" as |featured|}}
        {{#if featured}}
            <section class="kg-canvas featured-post-wrapper">
                <div class="kg-width-wide featured-container">
                    <div class="featured-wrapper">
                        <div class="feed-header">
                            {{#if @custom.featured_title}}
                                <div class="feed-header-title">{{@custom.featured_title}}</div>
                            {{/if}}
                        </div>
                        <div class="featured-feed-card kg-grid kg-grid-2col">
                            {{#foreach featured}}
                                {{> "loop-card"}}
                            {{/foreach}}
                        </div>
                    </div>
                </div>
            </section>
        {{/if}}
    {{/get}}

**Critical details:**

- `{{#get}}` is the Ghost API helper for fetching data outside normal page context
- `filter="featured:true"` uses Ghost's NQL filter syntax — the colon format, not `=`
- `include="authors,tags"` must be explicit — these relations are not loaded by default in `{{#get}}`
- `as |featured|` assigns the result set to a named block param; use that name in `{{#foreach}}`
- `{{#if featured}}` guards against the case where no posts are featured (avoids empty section markup)
- `limit="2"` is intentional for a two-column grid — match `limit` to `kg-grid-2col` / `kg-grid-3col` column count
- `{{@custom.featured_title}}` provides an editable section label from Ghost Admin


### Toggling the Section from Admin


In `index.hbs`, the entire partial is guarded by a boolean custom setting:

    {{#if @custom.show_featured_posts}}
        {{> featured-posts}}
    {{/if}}

This lets site owners hide the featured section without editing template files.


### Common `{{#get}}` Patterns for Hero Sections


Fetching the single most recent post for a big hero card:

    {{#get "posts" limit="1" include="authors,tags" as |hero_post|}}
        {{#foreach hero_post}}
            <a href="{{url}}">
                <h2>{{title}}</h2>
            </a>
        {{/foreach}}
    {{/get}}

Fetching featured posts for a specific tag:

    {{#get "posts" filter="featured:true+tag:news" limit="3" include="authors" as |featured|}}
        {{#foreach featured}}
            {{> "loop-card"}}
        {{/foreach}}
    {{/get}}


---


## 8. Archive Page Header Pattern (`partials/page-header.hbs`)


Used on tag and author archive pages to display a header with optional cover image, title, and description. The partial uses `{{#page}}` context block — this resolves to tag/author data when rendered in those contexts.

    {{#page}}
        <section class="taxonomy kg-canvas">
            <header class="single-header-wrap kg-width-content">
                {{#if feature_image}}
                    <div class="taxonomy-media u-placeholder square">
                        <img
                            class="u-object-fit"
                            src="{{img_url feature_image size="s"}}"
                            alt="{{title}}">
                    </div>
                {{/if}}
                <div class="tag-wrapper">
                    <h1 class="single-title">{{title}}</h1>
                    {{#if custom_excerpt}}
                        <div class="single-excerpt">{{custom_excerpt}}</div>
                    {{/if}}
                </div>
            </header>
        </section>
    {{/page}}

**Critical details:**

- `{{#page}}` is the context block for page/tag/author data — it is NOT `{{#post}}`
- On a tag archive, `{{title}}` resolves to the tag name, `{{feature_image}}` to the tag cover image
- On an author archive, `{{title}}` resolves to the author name, `{{feature_image}}` to the author cover
- `{{custom_excerpt}}` on a tag is the tag description field in Ghost Admin
- `size="s"` (400px) is appropriate for a square avatar/thumbnail — this is not a full-width hero
- No srcset is needed here since `u-placeholder square` constrains the render size


### Tag Archive Template (tag.hbs)


    {{!< default}}

    <main class="site-main">
        {{> page-header}}

        <section class="kg-canvas">
            <div class="kg-width-wide">
                <div class="post-feed gh-feed">
                    {{#foreach posts}}
                        {{> "loop-card"}}
                    {{/foreach}}
                </div>
                {{pagination}}
            </div>
        </section>
    </main>


### Author Archive Template (author.hbs)


    {{!< default}}

    <main class="site-main">
        {{> page-header}}

        <section class="kg-canvas">
            <div class="kg-width-wide">
                <div class="post-feed gh-feed">
                    {{#foreach posts}}
                        {{> "loop-card"}}
                    {{/foreach}}
                </div>
                {{pagination}}
            </div>
        </section>
    </main>


---


## 9. Loop Card Partial with Conditional Feature Image (`partials/loop-card.hbs`)


The card partial used in both the feed and the featured-posts section. Uses `@custom.show_feed_featured_image` to optionally display the image.

    <article class="feed-card-wrapper {{#if @custom.show_feed_featured_image}}has-featured-image{{/if}} card-{{@index}}"
             data-month="{{date format="MMMM YYYY"}}">

        {{#if @custom.show_feed_featured_image}}
            {{#if feature_image}}
                <div class="feed-cover-image">
                    <img class="u-object-fit"
                        srcset="{{> srcset}}"
                        sizes="(min-width: 1256px) calc((1130px - 60px) / 2), (min-width: 992px) calc((90vw - 60px) / 2), (min-width: 768px) calc((90vw - 30px) / 2), 90vw"
                        src="{{img_url feature_image size="m"}}"
                        alt="{{title}}"
                        loading="lazy">
                </div>
            {{/if}}
        {{/if}}

        <div class="text-group">
            <div class="feed-meta">
                <div class="feed-line"></div>
                <div class="feed-card-author">
                    {{#foreach authors limit="1"}}
                        <div class="feed-author-avatar u-placeholder square round">
                            {{#if profile_image}}
                                <img class="author-image u-object-fit"
                                    src="{{img_url profile_image size="xs"}}"
                                    alt="{{name}}"
                                    loading="lazy">
                            {{/if}}
                        </div>
                        <span class="text-spacer">{{t 'by'}}</span>
                        {{name}}
                    {{/foreach}}
                </div>
                <span class="text-spacer">{{t 'on'}}</span>
                <time class="feed-card-date" datetime="{{date format="YYYY-MM-DD"}}">
                    {{date published_at format="MMM DD"}}
                </time>
                <div class="feed-visibility feed-visibility-{{visibility}}">
                    {{> icons/star}}
                </div>
            </div>
            <div class="feed-card-content">
                <h2 class="feed-card-title">{{title}}</h2>
                {{#if excerpt}}
                    <div class="feed-card-excerpt text-truncate-3-line">{{excerpt words="20"}}</div>
                {{/if}}
                <div class="feed-tags">
                    {{#foreach tags limit="3"}}
                        <span class="feed-tag">#{{name}}</span>
                    {{/foreach}}
                </div>
                <div class="button button-secondary button-small feed-button">{{t 'Continue Reading'}}</div>
            </div>
        </div>
        <a class="u-permalink" href="{{url}}" aria-label="{{title}}"></a>
    </article>

**Key patterns:**

- `{{@index}}` is the zero-based loop index — useful for CSS `nth-child`-style targeting
- `data-month` attribute enables JS-based month grouping in the feed without server logic
- `{{excerpt words="20"}}` is the Ghost excerpt helper with word limit — different from `{{custom_excerpt}}`
- The `<a class="u-permalink">` covers the entire card as a clickable area — keep it as the last child for stacking context
- `{{visibility}}` on the feed card drives CSS visibility badges without extra JS


---


## 10. The Minimal Default Layout (Reference)


A simpler `default.hbs` structure defines no hero in `default.hbs` itself — the hero lives in page-level templates. This is the standard Ghost pattern.

    <!DOCTYPE html>
    <html lang="{{@site.locale}}">
    <head>
        <meta charset="utf-8">
        <title>{{meta_title}}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {{> custom-fonts}}
        <link href="{{asset "css/style.css"}}" rel="stylesheet" />
        {{ghost_head}}
    </head>
    <body class="{{body_class}}">
        <div id="page" class="site">
            {{> header}}
            {{{body}}}
            {{> sidebar}}
            {{> footer}}
        </div>

        <script src="{{asset "js/plugins.js"}}"></script>
        <script src="{{asset "js/custom.js"}}"></script>
        {{ghost_foot}}
    </body>
    </html>

A `default-custom.hbs` can also be provided for custom page templates that need a stripped-down shell (no sidebar, no footer — just head + body). Use this pattern when a landing page or custom template needs full layout control:

    <!DOCTYPE html>
    <html lang="{{@site.locale}}">
        <head>
            <meta charset="utf-8">
            <title>{{{block "custom-meta-title"}}} - {{@site.title}}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            {{> custom-fonts}}
            <link rel="stylesheet" type="text/css" href="{{asset "css/style.css"}}" />
            {{ghost_head}}
        </head>
        {{{body}}}
    </html>

The `{{{block "custom-meta-title"}}}` pattern uses Ghost's `{{block}}` / `{{contentFor}}` system to let child templates inject a custom `<title>` tag.


---


## 11. Quick-Reference: Hero Pattern Decision Tree


Use this to choose the right pattern for a given requirement.

**I need a hero with customizable text and optional logo:**

- Use the index.hbs hero block with `@custom.hero_layout` select + `@custom.primary_header` text fields

**I need posts to default to a specific image layout site-wide:**

- Declare `default_post_template` as a select custom setting in `package.json`
- Use `{{#match @custom.default_post_template "..."}}` in `post.hbs` to dispatch to the content partial

**I need per-post layout override:**

- Create `custom-<layout-name>.hbs` files — Ghost Admin will list them in Post → Template dropdown
- Each file calls `{{> "content" width="..."}}` or `{{> "content" no_image=true}}`

**I need a carousel of featured posts:**

- Use `{{#get "posts" filter="featured:true" include="authors,tags" limit="N" as |featured|}}` in a dedicated partial
- Guard with `{{#if @custom.show_featured_posts}}` in the parent template

**I need a tag/author archive header:**

- Use `{{#page}}` context block with `{{title}}`, `{{feature_image}}`, `{{custom_excerpt}}`
- Include a single `size="s"` image — no srcset needed for small avatar thumbnails

**I need responsive images on a post hero:**

- Use `srcset` with `size="l"`, `size="xl"`, `size="xxl"` (750w / 1140w / 1920w)
- Set `sizes="(min-width: 1023px) 920px, 100vw"`
- Use `size="xxl"` as the `src` fallback
- Always set `alt` with `{{feature_image_alt}}` falling back to `{{title}}`
