# Ghost Content as UI Data

Ghost has no native widget system, drag-and-drop sections, or CMS blocks. Instead, the theme layer uses Ghost's content model — posts, pages, tags, authors — as a structured data source, with `{{#get}}` as the query engine and custom settings as the configuration layer. This reference documents the patterns that emerge from that constraint.


---


## The Core Mental Model

Ghost's data model maps to UI patterns like this:

| Ghost concept | How themes use it as UI |
|---|---|
| Post `featured: true` flag | Editorial curation — marks posts for hero/carousel display |
| Tag `feature_image` + `accent_color` | Visual identity for category cards and section headers |
| Tag `description` | Subtitle for section landing pages |
| Ghost Page (slug) | Holds title/body/meta for custom site sections |
| Internal tag (`#hash-name`) | Invisible metadata — routes and filters without polluting public tags |
| `{{#get}}` | The "widget query" — fetch any content anywhere, independently of page context |

When a user asks for a homepage carousel, a category grid, a sidebar widget, or a curated "featured" section — this is always the answer.


---


## 1. Featured Flag as Hero Curation

The simplest Ghost "hero" is a `{{#get}}` query for `featured:true` posts. Editors flag posts in Ghost Admin (Post settings → Feature this post), and the theme surfaces them.

    {{#get "posts" filter="featured:true" include="authors,tags" limit="3" as |featured|}}
        {{#if featured}}
            <section class="featured-posts">
                {{#foreach featured}}
                    {{> "loop-card"}}
                {{/foreach}}
            </section>
        {{/if}}
    {{/get}}

- `filter="featured:true"` — NQL syntax, colon not `=`
- `include="authors,tags"` — relations are not loaded by default inside `{{#get}}`, must be explicit
- `as |featured|` — named block param; use the same name in `{{#foreach}}`
- `{{#if featured}}` — guards against empty sections when no posts are featured
- Match `limit` to your grid column count (`limit="2"` for 2-col, `limit="3"` for 3-col)

To make the section optional from Ghost Admin, gate it with a boolean custom setting:

    {{#if @custom.show_featured_posts}}
        {{> featured-posts}}
    {{/if}}

The `show_featured_posts` setting is declared in `package.json` under `config.custom`.


---


## 2. Tag Metadata as Section Identity

Every Ghost tag has: `name`, `slug`, `description`, `feature_image`, `accent_color`, `count.posts`. Themes use these to build visual category grids, section headers, and navigation — without any custom fields or plugins.

**Tag directory page** (`tags.hbs` or a custom template):

    {{#get "tags" limit="12" include="count.posts" order="count.posts desc" as |tags|}}
        {{#if tags}}
            <div class="tags-grid">
                {{#foreach tags}}
                    <a class="tag-card" href="{{url}}" style="background-color: {{accent_color}};">
                        {{#if feature_image}}
                            <img src="{{img_url feature_image size="s"}}" alt="{{name}}">
                        {{/if}}
                        <div class="tag-card-text">
                            <h3>{{name}}</h3>
                            <span>{{plural count.posts empty="No articles" singular="1 article" plural="% articles"}}</span>
                        </div>
                    </a>
                {{/foreach}}
            </div>
        {{/if}}
    {{/get}}

- `include="count.posts"` — required to access `count.posts`; not included by default
- `order="count.posts desc"` — surface the most active sections first
- `accent_color` — set per-tag in Ghost Admin → Tags → Accent color; safe to use inline for card identity
- `feature_image` — set per-tag in Ghost Admin → Tags → Cover image; use `size="s"` (400px) for thumbnails

**Tag cloud sidebar widget:**

    {{#get "tags" limit="all" include="count.posts" order="count.posts desc" as |tags|}}
        <div class="tag-cloud">
            {{#foreach tags}}
                <a href="{{url}}" class="tag-pill">{{name}} ({{count.posts}})</a>
            {{/foreach}}
        </div>
    {{/get}}

This is the Ghost equivalent of a "Categories" sidebar widget. Fetch it inside any partial — it has no dependency on the current page context.


---


## 3. Ghost Pages as Section Metadata

Ghost pages are the best way to give a custom section (archive, portfolio, about) an editable title, description, and body — without hardcoding strings in templates. Create a page in Ghost Admin with a specific slug, then bind it to a route via `data:` in `routes.yaml`.

**routes.yaml:**

    routes:
      /archive/:
        controller: channel
        template: archive
        data: page.archive
        order: published_at desc

**archive.hbs:**

    {{!< default}}
    <main class="site-main">
        {{#page}}
            <header>
                <h1>{{title}}</h1>
                {{#if custom_excerpt}}<p>{{custom_excerpt}}</p>{{/if}}
            </header>
        {{/page}}

        {{#foreach posts}}
            {{> "loop-card"}}
        {{/foreach}}
        {{pagination}}
    </main>

The `{{#page}}` block exposes the bound Ghost page's `title`, `custom_excerpt`, `content`, and `feature_image`. The `posts` array comes from the channel controller. The original page URL (`/archive-page/`) is automatically 301-redirected to `/archive/`.

**What to store in the Ghost Page:**

- `title` → section heading
- `custom_excerpt` → section subtitle (single line, plain text)
- `content` → introductory body copy (full Ghost editor; rarely shown)
- `feature_image` → section hero image

This pattern applies to any channel or collection that needs an editable header. Use `data: tag.{slug}` instead when the section maps naturally to a tag.


---


## 4. Internal Tags as Invisible Metadata

Ghost internal tags are prefixed with `#` in the editor (e.g., `#Featured`, `#German`) and stored in the API as `hash-{name}` (e.g., `hash-featured`, `hash-german`). They are excluded from `{{tags}}` output and public tag pages by default.

Use cases:

- **Multi-language routing** — tag German posts `#German`, filter collections by `tag:hash-german`
- **Content type flags** — tag podcast episodes `#Podcast` to separate them without changing the primary tag
- **Layout metadata** — tag posts `#wide-hero` to trigger a specific layout without a custom template

Filtering by internal tag in routes.yaml:

    collections:
      /:
        permalink: /{slug}/
        filter: 'tag:-hash-de'
      /de/:
        permalink: /de/{slug}/
        filter: 'tag:hash-de'

Filtering in `{{#get}}`:

    {{#get "posts" filter="tag:hash-featured" limit="5" as |curated|}}

The quotes around the filter value are required in `routes.yaml` when the value contains a hash character.


---


## 5. Related Posts via Tag Intersection

The most common "related posts" pattern filters by shared tags while excluding the current post:

    {{#get "posts" limit="3" filter="tags:[{{post.tags}}]+id:-{{post.id}}" as |related|}}
        {{#if related}}
            <section class="related-posts">
                <h3>You might also like</h3>
                {{#foreach related}}
                    {{> "loop-card"}}
                {{/foreach}}
            </section>
        {{/if}}
    {{/get}}

- `tags:[{{post.tags}}]` — the `[...]` syntax accepts a comma-separated list; `{{post.tags}}` expands to the current post's tag slugs
- `+id:-{{post.id}}` — the `+` is AND, `:-` is "not equals"; excludes the current post
- This must be inside a `{{#post}}` block so `{{post.tags}}` and `{{post.id}}` resolve correctly

For tag-specific related posts (more precise, less surprising results):

    {{#get "posts" limit="3" filter="primary_tag:{{post.primary_tag.slug}}+id:-{{post.id}}" as |related|}}


---


## 6. Carousels: JS Layer on Top of Ghost Data

Ghost renders the carousel items server-side. A JS library handles the sliding behavior client-side. The two parts are independent.

**HBS side** — render slides into a container with a class the JS will target:

    {{#get "posts" filter="featured:true" limit="6" include="authors,tags" as |slides|}}
        <div class="carousel-container">
            {{#foreach slides}}
                <div class="carousel-slide">
                    {{#if feature_image}}
                        <img src="{{img_url feature_image size="l"}}" alt="{{title}}" loading="lazy">
                    {{/if}}
                    <div class="carousel-caption">
                        <h2>{{title}}</h2>
                        <a href="{{url}}">Read more</a>
                    </div>
                </div>
            {{/foreach}}
        </div>
    {{/get}}

**JS side** — initialize after DOM ready. [Tiny Slider](https://github.com/ganlanyuan/tiny-slider) is a lightweight option:

    import { tns } from '../lib/tiny-slider.js';

    const carousel = document.querySelector('.carousel-container');
    if (carousel) {
        tns({
            container: carousel,
            items: 1,
            slideBy: 'page',
            autoplay: true,
            controls: true,
            nav: true,
            loop: true,
        });
    }

**CSS scroll snap alternative** — no JS dependency, works in all modern browsers:

    .carousel-container {
        display: flex;
        overflow-x: scroll;
        scroll-snap-type: x mandatory;
        gap: 1rem;
    }

    .carousel-slide {
        flex: 0 0 100%;
        scroll-snap-align: start;
    }

The CSS-only approach renders an infinitely scrollable strip. Use when autoplay and prev/next controls are not required. For full carousel controls, use a library (Tiny Slider, Swiper, Embla).

**Ghost data sources for carousels:**

| Carousel type | `{{#get}}` filter |
|---|---|
| Hero / featured | `filter="featured:true"` |
| Category highlights | `filter="primary_tag:{slug}" limit="6"` |
| Recent posts | no filter, `limit="6"` |
| Curated picks | internal tag: `filter="tag:hash-picks"` |


---


## 7. Custom Homepage with No Default Post Feed

Move the post collection off the root and build a fully custom homepage:

**routes.yaml:**

    routes:
      /: home

    collections:
      /blog/:
        permalink: /blog/{slug}/
        template: index

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

**home.hbs:**

    {{!< default}}
    <main class="site-main">

        {{! Hero section }}
        <section class="hero">
            <h1>{{@custom.hero_title}}</h1>
            <p>{{@custom.hero_text}}</p>
        </section>

        {{! Featured posts carousel }}
        {{#get "posts" filter="featured:true" limit="4" include="authors,tags" as |featured|}}
            <div class="carousel-container">
                {{#foreach featured}}
                    <div class="carousel-slide">
                        <a href="{{url}}"><h2>{{title}}</h2></a>
                    </div>
                {{/foreach}}
            </div>
        {{/get}}

        {{! Latest posts grid }}
        {{#get "posts" limit="6" include="authors,tags" as |latest|}}
            <div class="post-grid">
                {{#foreach latest}}
                    {{> "loop-card"}}
                {{/foreach}}
            </div>
        {{/get}}

        {{! Category grid }}
        {{#get "tags" limit="6" include="count.posts" order="count.posts desc" as |sections|}}
            <div class="sections-grid">
                {{#foreach sections}}
                    <a href="{{url}}" class="section-card">
                        <h3>{{name}}</h3>
                        <span>{{count.posts}} posts</span>
                    </a>
                {{/foreach}}
            </div>
        {{/get}}

    </main>

`home.hbs` is a fully static template — it has no automatic `posts` array. All content must be fetched via `{{#get}}`. This gives you complete layout control.
