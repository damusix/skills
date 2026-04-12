# Template Hierarchy & Contexts

Defines every Ghost rendering context, the exact template lookup chain Ghost runs for each one, and the complete data objects available inside each template — synthesized from Ghost's `templates.js`, `context.js`, `fetch-data.js`, the official context docs, and real theme examples.

## How Contexts Work

Ghost sets `res.locals.context` (an array) before rendering. The context array drives both template selection and helper output. Multiple contexts can be active at once: the home page always carries `['home', 'index']`; paginated pages carry `['paged', 'index']`; a post in a custom collection carries `['post']`.

You test context inside templates with `{{#is}}`:

    {{#is "post"}}
        <span class="reading-time">{{reading_time}}</span>
    {{/is}}

    {{#is "home"}}
        <h1>Welcome to {{@site.title}}</h1>
    {{/is}}

    {{#is "post, page"}}
        {{!-- true in either single-entry context --}}
        {{> "comments"}}
    {{/is}}

Context array composition (from `context.js`):

- `paged` is pushed first when `page > 1`
- `home` is pushed when the URL is exactly `/`
- The router's own `routerOptions.context` value is concatenated next
- `page`, `post`, or `tag` is pushed last, driven by the actual data returned

---

## Global `@site` Object

Available in every context, no block expression needed.

- `@site.title` — site name
- `@site.description` — site tagline
- `@site.url` — canonical site URL
- `@site.logo` — site logo image URL
- `@site.cover_image` — site cover image URL
- `@site.icon` — site favicon URL
- `@site.twitter` — Twitter username
- `@site.facebook` — Facebook page name
- `@site.navigation` — array of nav items `[{label, url}]`
- `@site.secondary_navigation` — secondary nav array
- `@site.locale` — language/locale string (e.g. `en`)
- `@site.timezone` — IANA timezone string
- `@site.codeinjection_head` — custom head code injection
- `@site.codeinjection_foot` — custom footer code injection
- `@custom.*` — theme design settings (e.g. `@custom.hero_title`, `@custom.default_post_template`)

---

## Index / Collection Context

### Description

The `index` context is the main post list. It is always active on the collection root (`/`) and on all paginated pages (`/page/:num/`). Custom collections defined in `routes.yaml` produce their own named context (e.g. `podcast`) but share the same template lookup logic.

The `home` sub-context is only active on the root page (`/`). When `home` is active, `index` is also always active.

### Routes

- `/` — home page (contexts: `['home', 'index']`)
- `/page/2/` — page 2 and beyond (contexts: `['paged', 'index']`)
- `/podcast/` — custom collection root (contexts: `['podcast']`)

### Template Lookup Chain

Ghost's `getEntriesTemplateHierarchy` builds the candidate list from most-specific to least-specific, then walks it and picks the first template that exists in the theme.

For the default `index` collection:

    home.hbs          ← only checked on page 1 (frontPageTemplate)
    index.hbs         ← required fallback

For a custom named collection (e.g. `podcast` defined in `routes.yaml`):

    podcast-:slug.hbs ← slug-specific (when slugTemplate + slugParam present)
    podcast.hbs       ← collection name template
    index.hbs         ← final fallback

If `routes.yaml` specifies `templates:` for a collection, those names are prepended to the candidate list before the collection-name template.

### Data Available

The `index` context provides a `posts` array and a `pagination` object. There is no wrapping block expression — `posts` and `pagination` are top-level.

**posts** — array of post objects, paginated per `posts_per_page` in `package.json`. Each item has the full post shape (see Post Context below). Default includes: `authors`, `tags`, `tiers` (set in `fetch-data.js` `defaultQueryOptions`).

**pagination** — object:

- `page` — current page number (integer)
- `prev` — previous page number or `null`
- `next` — next page number or `null`
- `pages` — total number of pages
- `total` — total number of posts
- `limit` — posts per page

### Full Example

    {{!-- index.hbs --}}
    {{!< default}}

    <header class="site-header">
        <h1>{{@site.title}}</h1>
        <p>{{@site.description}}</p>
    </header>

    <main>
        {{#foreach posts}}
            <article class="{{post_class}}">
                <header>
                    {{#if feature_image}}
                        <a href="{{url}}">
                            <img src="{{img_url feature_image size="m"}}"
                                 alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}">
                        </a>
                    {{/if}}
                    <h2><a href="{{url}}">{{title}}</a></h2>
                </header>

                <section class="post-excerpt">
                    <p>{{excerpt words="30"}}</p>
                </section>

                <footer class="post-meta">
                    <time datetime="{{date format='YYYY-MM-DD'}}">
                        {{date format="DD MMMM YYYY"}}
                    </time>
                    {{#if primary_author}}
                        by
                        <a href="{{primary_author.url}}">{{primary_author.name}}</a>
                    {{/if}}
                    {{tags prefix=" in " separator=", "}}
                </footer>
            </article>
        {{/foreach}}
    </main>

    {{pagination}}

---

## Post Context

### Description

The `post` context is active on any individual blog post page. The post object is the most complex model in Ghost and carries special calculated attributes.

### Routes

Configurable in Ghost Admin (Settings → General). Default: `/:slug/`. Can be customised per-collection in `routes.yaml`.

### Template Lookup Chain

From `getEntryTemplateHierarchy` in `templates.js`:

    post-:slug.hbs    ← slug-specific (e.g. post-my-announcement.hbs)
    custom-*.hbs      ← whichever custom template was selected in post settings
    post.hbs          ← required fallback

Ghost checks this list from top to bottom, picks the first file that exists in the active theme.

### Data Available

Access via `{{#post}}...{{/post}}` block expression.

**Post object attributes:**

- `id` — Object ID of the post
- `comment_id` — legacy incremental ID (pre-1.0) or Object ID
- `title` — post title
- `slug` — URL-safe slug (also useful as a CSS class name)
- `excerpt` — auto-generated or custom excerpt
- `content` — fully rendered HTML body
- `url` — canonical URL (always use `{{url}}` helper, not raw `{{post.url}}`)
- `feature_image` — cover image URL
- `feature_image_alt` — cover image alt text
- `feature_image_caption` — cover image caption (may contain basic HTML)
- `featured` — boolean, `true` if post is featured
- `page` — boolean, `false` for posts (use `{{#is "page"}}` to branch)
- `visibility` — `"public"`, `"members"`, or `"paid"`
- `meta_title` — custom SEO title
- `meta_description` — custom SEO description
- `published_at` — ISO 8601 publish datetime
- `updated_at` — ISO 8601 last-updated datetime
- `created_at` — ISO 8601 creation datetime
- `reading_time` — estimated reading time in minutes (integer)
- `primary_author` — first author object (see Author shape below)
- `authors` — array of all author objects
- `tags` — array of all tag objects
- `primary_tag` — first tag object (path expression, not a helper)
- `custom_template` — name of the selected custom template (if any)
- `tiers` — array of membership tiers with access to this post

**primary_author shape** (also applies to each item in `authors`):

- `id`, `name`, `slug`, `bio`, `location`, `website`
- `twitter`, `facebook`
- `profile_image`, `cover_image`
- `url`

**primary_tag shape** (also applies to each item in `tags`):

- `id`, `name`, `slug`, `description`
- `feature_image`, `accent_color`
- `meta_title`, `meta_description`
- `url`, `visibility`
- `count.posts` — post count (only available when explicitly requested)

### Full Example

    {{!-- post.hbs --}}
    {{!< default}}

    {{#post}}
    <article class="{{post_class}}">

        {{#if feature_image}}
            <figure class="post-feature-image">
                <img
                    srcset="{{img_url feature_image size="s" format="webp"}} 300w,
                            {{img_url feature_image size="m" format="webp"}} 600w,
                            {{img_url feature_image size="l" format="webp"}} 1000w,
                            {{img_url feature_image size="xl" format="webp"}} 2000w"
                    sizes="(min-width: 1200px) 1200px, 100vw"
                    src="{{img_url feature_image size="l"}}"
                    alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
                >
                {{#if feature_image_caption}}
                    <figcaption>{{feature_image_caption}}</figcaption>
                {{/if}}
            </figure>
        {{/if}}

        <header class="post-header">
            {{#primary_tag}}
                <a class="post-tag" href="{{url}}">{{name}}</a>
            {{/primary_tag}}
            <h1 class="post-title">{{title}}</h1>
            <div class="post-meta">
                {{#primary_author}}
                    <a href="{{url}}">
                        {{#if profile_image}}
                            <img class="author-avatar"
                                 src="{{img_url profile_image size="xxs"}}"
                                 alt="{{name}}">
                        {{/if}}
                        {{name}}
                    </a>
                {{/primary_author}}
                <time datetime="{{date format='YYYY-MM-DD'}}">
                    {{date format="DD MMMM YYYY"}}
                </time>
                {{reading_time minute="1 min read" minutes="% min read"}}
            </div>
        </header>

        <section class="post-content">
            {{content}}
        </section>

        <footer class="post-footer">
            {{tags prefix="Filed under: " separator=", "}}
        </footer>

    </article>
    {{/post}}

---

## Page Context

### Description

The `page` context is active on static pages. A page is a special type of post — `page: true` — but uses the same data object shape. The key differences are template lookup order and the fact that page URLs are always `/:slug/` (not configurable).

### Routes

Always `/:slug/`. Cannot be customised via `routes.yaml` (unlike post permalinks).

### Template Lookup Chain

From `getEntryTemplateHierarchy` with `context === 'page'`:

    page-:slug.hbs    ← slug-specific (e.g. page-about.hbs)
    custom-*.hbs      ← whichever custom template was selected in page settings
    page.hbs          ← optional page-level fallback
    post.hbs          ← required ultimate fallback

### Page vs Post: Key Differences

| Aspect | post | page |
|---|---|---|
| `page` attribute | `false` | `true` |
| URL configurability | Configurable via permalink settings | Always `/:slug/` |
| Template fallback | `post.hbs` | `page.hbs` → `post.hbs` |
| Slug template prefix | `post-:slug.hbs` | `page-:slug.hbs` |
| `{{#is}}` check | `{{#is "post"}}` | `{{#is "page"}}` |
| Typical usage | Blog posts, articles | About, Contact, landing pages |

Both contexts use `{{#post}}...{{/post}}` as the block expression. Both carry identical attribute sets. The `page` attribute on the object is the programmatic way to distinguish them, but `{{#is "page"}}` in templates is the idiomatic approach.

### Data Available

Identical to post object. The block expression is still `{{#post}}...{{/post}}`, not `{{#page}}`. The `page` attribute will be `true`.

### Full Example

    {{!-- page.hbs --}}
    {{!< default}}

    {{#post}}
    <article class="{{post_class}}">

        <header class="page-header">
            <h1 class="page-title">{{title}}</h1>
            {{#if excerpt}}
                <p class="page-excerpt">{{excerpt}}</p>
            {{/if}}
        </header>

        {{#if feature_image}}
            <figure class="page-cover">
                <img src="{{img_url feature_image size="l"}}"
                     alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}">
            </figure>
        {{/if}}

        <section class="page-content">
            {{content}}
        </section>

    </article>
    {{/post}}

    {{!-- page-about.hbs: slug-specific override --}}
    {{!-- same structure but can add custom sections --}}

---

## Tag Context

### Description

The `tag` context is active on tag archive pages. It provides the tag object, a paginated list of posts with that tag, and a pagination object.

### Routes

- `/tag/:slug/` — tag page
- `/tag/:slug/page/:num/` — paginated tag pages

### Template Lookup Chain

    tag-:slug.hbs     ← slug-specific (e.g. tag-photo.hbs)
    tag.hbs           ← tag-level template
    index.hbs         ← final fallback

### Data Available

Three top-level objects: `tag`, `posts`, `pagination`.

**tag** — access via `{{#tag}}...{{/tag}}`:

- `id` — incremental ID
- `name` — display name
- `slug` — URL-safe slug
- `description` — tag description text
- `feature_image` — cover image URL
- `meta_title` — custom SEO title
- `meta_description` — custom SEO description
- `url` — canonical tag page URL
- `accent_color` — hex color string (e.g. `#ff0000`)
- `visibility` — `"public"` or `"internal"` (internal tags start with `#`)
- `count.posts` — available only when `include="count.posts"` is set via `{{get}}`

**posts** — same paginated array as index context (full post shape).

**pagination** — same object shape as index context.

### Full Example

    {{!-- tag.hbs --}}
    {{!< default}}

    {{#tag}}
        <header class="tag-header">
            {{#if feature_image}}
                <div class="tag-cover"
                     style="background-image: url({{img_url feature_image size="l"}})">
                </div>
            {{/if}}
            <div class="tag-header-content">
                {{#if accent_color}}
                    <span class="tag-accent" style="background: {{accent_color}}"></span>
                {{/if}}
                <h1 class="tag-title">{{name}}</h1>
                {{#if description}}
                    <p class="tag-description">{{description}}</p>
                {{/if}}
                <p class="tag-count">
                    {{plural ../pagination.total
                        empty="No posts"
                        singular="% post"
                        plural="% posts"}}
                </p>
            </div>
        </header>
    {{/tag}}

    <main>
        {{#foreach posts}}
            <article class="{{post_class}}">
                <h2><a href="{{url}}">{{title}}</a></h2>
                <time datetime="{{date format='YYYY-MM-DD'}}">
                    {{date format="DD MMMM YYYY"}}
                </time>
                <p>{{excerpt words="25"}}</p>
            </article>
        {{/foreach}}
    </main>

    {{pagination}}

---

## Author Context

### Description

The `author` context is active on author archive pages. It provides the author object, a paginated list of that author's posts, and a pagination object.

### Routes

- `/author/:slug/` — author page
- `/author/:slug/page/:num/` — paginated author pages

### Template Lookup Chain

    author-:slug.hbs  ← slug-specific (e.g. author-john.hbs)
    author.hbs        ← author-level template
    index.hbs         ← final fallback

### Data Available

Three top-level objects: `author`, `posts`, `pagination`.

**author** — access via `{{#author}}...{{/author}}`:

- `id` — incremental ID
- `name` — display name
- `slug` — URL-safe slug
- `bio` — biography text
- `location` — location string
- `website` — personal website URL
- `twitter` — Twitter username (without `@`)
- `facebook` — Facebook username
- `profile_image` — avatar image URL
- `cover_image` — cover/banner image URL
- `url` — canonical author page URL
- `count.posts` — available only when `include="count.posts"` is requested

**posts** — same paginated array as index context (full post shape).

**pagination** — same object shape as index context.

### Full Example

    {{!-- author.hbs --}}
    {{!< default}}

    {{#author}}
        <header class="author-header">
            {{#if cover_image}}
                <div class="author-cover"
                     style="background-image: url({{img_url cover_image size="l"}})">
                </div>
            {{/if}}
            <div class="author-profile">
                {{#if profile_image}}
                    <img class="author-avatar"
                         src="{{img_url profile_image size="s"}}"
                         alt="{{name}}">
                {{/if}}
                <h1 class="author-name">{{name}}</h1>
                {{#if bio}}
                    <p class="author-bio">{{bio}}</p>
                {{/if}}
                {{#if location}}
                    <p class="author-location">{{location}}</p>
                {{/if}}
                <div class="author-links">
                    {{#if website}}
                        <a href="{{website}}">Website</a>
                    {{/if}}
                    {{#if twitter}}
                        <a href="https://twitter.com/{{twitter}}">@{{twitter}}</a>
                    {{/if}}
                </div>
                <p class="author-stats">
                    {{plural ../pagination.total
                        empty="No posts yet"
                        singular="% post"
                        plural="% posts"}}
                </p>
            </div>
        </header>
    {{/author}}

    <main>
        {{> "loop"}}
    </main>

    {{pagination}}

---

## Custom Templates (`custom-*.hbs`)

### How They Surface in Ghost Admin

Any `.hbs` file in the theme root whose name begins with `custom-` is automatically discovered by Ghost and shown in the **Template** dropdown in the post/page settings panel in Ghost Admin. The human-readable label is generated from the filename: `custom-full-feature-image.hbs` → "Full Feature Image".

Rules:

- The file must be in the theme root (not a subdirectory).
- The prefix must be exactly `custom-` (lowercase).
- The rest of the filename becomes the label: hyphens become spaces, each word is title-cased.
- Custom templates work for both posts and pages.
- When selected, the template name is stored as `post.custom_template`.

### Template Lookup Position

Custom templates sit between the slug-specific template and the type fallback:

    post-:slug.hbs    ← highest priority
    custom-*.hbs      ← selected custom template (from post.custom_template)
    post.hbs          ← fallback for posts
    page.hbs          ← fallback for pages (page context only)

Ghost's `getEntryTemplateHierarchy` inserts `postObject.custom_template` (the stored template name) at position 2 in the list when it is set. If the theme no longer contains that file, Ghost continues walking the list.

### Structure of a Custom Template

All custom templates must declare their parent layout with `{{!< default}}` at the top. They receive the same context data as the base `post.hbs` or `page.hbs`.

A common pattern is four variants driven by feature image presentation:

    {{!-- custom-full-feature-image.hbs --}}
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

    {{!-- custom-no-feature-image.hbs --}}
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

    {{!-- custom-wide-feature-image.hbs --}}
    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{> "content" width="wide"}}
        {{/post}}

        {{#is "post"}}
            {{#post}}
                {{> "comments"}}
            {{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>

One approach is for `post.hbs` to read `@custom.default_post_template` to apply a site-wide default layout when no per-post custom template has been chosen:

    {{!-- post.hbs --}}
    {{!< default}}

    <main class="site-main">
        {{#post}}
            {{#match @custom.default_post_template "Full feature image"}}
                {{> "content" width="full"}}
            {{else match @custom.default_post_template "Narrow feature image"}}
                {{> "content" width="narrow"}}
            {{else match @custom.default_post_template "Wide feature image"}}
                {{> "content" width="wide"}}
            {{else}}
                {{> "content" no_image=true}}
            {{/match}}
        {{/post}}

        {{#is "post"}}
            {{#post}}{{> "comments"}}{{/post}}
            {{> "related-posts"}}
        {{/is}}
    </main>

---

## foreach Loop Variables

The `{{#foreach}}` helper (not Handlebars' native `{{#each}}`) is the correct way to iterate posts in Ghost. It exposes frame data variables prefixed with `@`:

| Variable | Type | Description |
|---|---|---|
| `@index` | integer | 0-based position in the current iteration window |
| `@number` | integer | 1-based position (`@index + 1`) |
| `@first` | boolean | `true` on the first iteration (respects `from` parameter) |
| `@last` | boolean | `true` on the last iteration (respects `to`/`limit`) |
| `@even` | boolean | `true` when `@index` is odd (0-based even = visually odd row) |
| `@odd` | boolean | `true` when `@index` is even (0-based odd = visually even row) |
| `@rowStart` | boolean | `true` when position is the start of a column row |
| `@rowEnd` | boolean | `true` when position is the end of a column row |
| `@key` | any | The iteration key (array index or object key) |

**Note on `@even`/`@odd`:** The source sets `frame.even = index % 2 === 1`, meaning `@even` is `true` for the second item (0-indexed position 1). This is counterintuitive. In practice use `@number` with modulo arithmetic for reliable alternating layouts.

### Hash Parameters

- `limit` — maximum number of items to render
- `from` — 1-based start index (default: 1)
- `to` — 1-based end index (default: length)
- `columns` — integer, enables `@rowStart`/`@rowEnd` tracking
- `visibility` — filter by post visibility; defaults to `"all"` for post arrays

### Full foreach Example

    {{#foreach posts}}
        <article class="post-card
            {{#if @first}} post-card--featured{{/if}}
            {{#if @even}} post-card--even{{else}} post-card--odd{{/if}}">

            {{!-- @number for 1-based display --}}
            <span class="post-number">{{@number}}</span>

            <h2><a href="{{url}}">{{title}}</a></h2>
            <p>{{excerpt words="20"}}</p>

            {{#if @last}}
                <p class="end-of-list">That's all the posts.</p>
            {{/if}}
        </article>
    {{else}}
        <p>No posts found.</p>
    {{/foreach}}

Slicing a subset — show items 2 through 4:

    {{#foreach posts from="2" to="4"}}
        <li>{{title}}</li>
    {{/foreach}}

Grid with column tracking — 3-column layout with row boundaries:

    {{#foreach posts columns="3"}}
        {{#if @rowStart}}<div class="grid-row">{{/if}}
            <div class="grid-cell">
                <h3><a href="{{url}}">{{title}}</a></h3>
            </div>
        {{#if @rowEnd}}</div>{{/if}}
    {{/foreach}}

Looping the first post separately, then the rest:

    {{#foreach posts limit="1"}}
        <div class="hero-post">
            <h1><a href="{{url}}">{{title}}</a></h1>
            {{excerpt words="50"}}
        </div>
    {{/foreach}}

    {{#foreach posts from="2"}}
        <article>
            <h2><a href="{{url}}">{{title}}</a></h2>
        </article>
    {{/foreach}}

---

## Pagination Object Shape

The same pagination object is available in all list contexts (index, tag, author, custom collections). It lives at the top level of the template — no block expression needed.

- `pagination.page` — current page number (integer, 1-based)
- `pagination.prev` — previous page number or `null` on page 1
- `pagination.next` — next page number or `null` on last page
- `pagination.pages` — total number of pages
- `pagination.total` — total number of matching posts
- `pagination.limit` — posts per page (from `package.json` `posts_per_page`)

The `{{pagination}}` helper renders the built-in pagination UI. To build custom pagination:

    {{#if pagination.prev}}
        <a href="{{page_url pagination.prev}}">Newer posts</a>
    {{/if}}

    <span>Page {{pagination.page}} of {{pagination.pages}}</span>

    {{#if pagination.next}}
        <a href="{{page_url pagination.next}}">Older posts</a>
    {{/if}}

Referencing `pagination.total` from inside a block expression context (e.g. inside `{{#tag}}`):

    {{plural ../pagination.total
        empty="No posts"
        singular="% post"
        plural="% posts"}}

The `../` traverses out of the `tag` scope to reach the top-level `pagination` object.

---

## Collection Context vs Index Context

### Index Context

`index` is the built-in default collection. It has no configurable name; the context array always contains `'index'` (or `'home'` + `'index'` on page 1). It uses `index.hbs` / `home.hbs`.

### Collection Context

A collection is a named group of posts defined in `routes.yaml`. The context array contains the collection's route name (e.g. `'podcast'` for a collection mounted at `/podcast/`). Each collection:

- Has its own root URL and permalink pattern
- Carries its own router name as the sole context value (from `collection-router.js`: `this.context = [this.routerName]`)
- Can specify custom `templates:` in `routes.yaml` that are prepended to the candidate list
- Supports `filter:`, `order:`, `limit:`, and `data:` keys to control what posts appear

From `routes.yaml`:

    collections:
      /podcast/:
        permalink: /podcast/{slug}/
        filter: tag:podcast
        template: podcast
        data:
          tag: tag.podcast

This produces the lookup chain:

    podcast.hbs
    index.hbs

If `templates: [podcast-featured]` were added:

    podcast-featured.hbs
    podcast.hbs
    index.hbs

### Slug Templates in Collections

When `slugTemplate: true` is set on the router and a `:slug` param is in the URL, Ghost also prepends `name-:slug.hbs` (e.g. `author-john.hbs`). This is how taxonomy routers (tag, author) work — they set `slugTemplate: true` so each individual taxonomy page can have a custom template.

### Entry Context Inside a Collection

When navigating to an individual post permalink within a collection, the router switches to `type: 'entry'` and resets `context` to `['post']`. This means the post uses `post.hbs` / `post-:slug.hbs` / `custom-*.hbs`, not any collection-specific template.

---

## Complete Template Reference Table

| Context | URL Pattern | Template Chain (first match wins) | Block Expression |
|---|---|---|---|
| home | `/` | `home.hbs` → `index.hbs` | none (top-level `posts`, `pagination`) |
| index (paged) | `/page/:num/` | `index.hbs` | none |
| post | `/:slug/` | `post-:slug.hbs` → `custom-*.hbs` → `post.hbs` | `{{#post}}` |
| page | `/:slug/` | `page-:slug.hbs` → `custom-*.hbs` → `page.hbs` → `post.hbs` | `{{#post}}` |
| tag | `/tag/:slug/` | `tag-:slug.hbs` → `tag.hbs` → `index.hbs` | `{{#tag}}` |
| author | `/author/:slug/` | `author-:slug.hbs` → `author.hbs` → `index.hbs` | `{{#author}}` |
| collection | `/:name/` | `[custom templates]` → `:name.hbs` → `index.hbs` | none |
| error-404 | `/*` (not found) | `error-404.hbs` → `error-4xx.hbs` → `error.hbs` | none |
| error-500 | `/*` (server error) | `error-500.hbs` → `error-5xx.hbs` → `error.hbs` | none |
