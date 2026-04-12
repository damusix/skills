# Routing & routes.yaml


Ghost's dynamic routing system lets you redefine where content lives, how URLs are structured, and what templates render each URL. Everything is controlled by a single YAML file — `routes.yaml` — which lives in `content/data/routes.yaml` on the server and can be downloaded/uploaded from Ghost Admin → Settings → Labs.

The default Ghost installation ships with:

    routes:

    collections:
      /:
        permalink: /{slug}/
        template: index

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

This produces: homepage lists all posts, each post lives at `/{slug}/`, tags at `/tag/{slug}/`, authors at `/author/{slug}/`. For most publications this default is sufficient and requires no editing.


## YAML Basics

YAML uses **2-space indentation** to denote nesting — tabs are not allowed. Every level of nesting requires exactly 2 spaces. The most common source of `routes.yaml` failures is incorrect whitespace. All route keys must end with a trailing slash — `/blog/` not `/blog`.


## Top-Level Sections

`routes.yaml` has exactly three top-level keys:

- `routes` — individual URL mappings to templates or controllers
- `collections` — groups of posts with shared permalink patterns
- `taxonomies` — auto-generated tag and author archive URLs

All three sections must be present even if empty. Ghost will error on a malformed or partially missing file.


## Routes Section

Routes map individual URLs to template files or controllers. They have no automatic post data associated — the template renders whatever the theme code provides or explicitly fetches via `{{#get}}`.


### Basic Static Route

The minimal form maps a URL to a template name (without `.hbs`):

    routes:
      /features/: features
      /about/team/: team

- `site.com/features/` renders `features.hbs`
- `site.com/about/team/` renders `team.hbs`

Use static routes for: landing pages with lots of custom HTML, pages that should not be editable in Ghost Admin, or custom URLs that need more than a basic slug.

If the template file does not exist in the active theme, Ghost throws an `IncorrectUsageError`: `Missing template features.hbs for route "/features/"`.


### Route with Data

The `data` property fetches a Ghost resource and makes it available in the template context. It also redirects the original resource URL to the new route (preventing duplicate content).

    routes:
      /about/team/:
        template: team
        data: page.team

This fetches the Ghost **page** with slug `team` and exposes it in the template via `{{#page}}`. The original URL `site.com/team/` issues a 301 redirect to `site.com/about/team/`.

Valid `data` values:

- `page.{slug}` → access with `{{#page}}` block helper
- `post.{slug}` → access with `{{#post}}` block helper
- `tag.{slug}` → access with `{{#tag}}` block helper
- `author.{slug}` → access with `{{#author}}` block helper

Ghost always includes `authors`, `tags`, and `tiers` relations when fetching `post` or `page` resources (set in `fetch-data.js` `defaultDataQueryOptions`). Tag and author resources fetch without extra includes by default.

The static controller (`controllers/static.js`) handles these routes. It also sets `duplicatePagesAsPosts = true`, which means page data is available under both `{{#page}}` and `{{#post}}` to ease template reuse.


### Route with content_type

Routes can serve non-HTML responses by specifying `content_type`:

    routes:
      /podcast/rss/:
        template: podcast-feed
        content_type: text/xml

The template renders whatever Handlebars outputs, but the HTTP `Content-Type` header is set to the specified MIME type. Use this to build custom RSS feeds, JSON endpoints, or any custom output format. Combine with `{{#get}}` inside the template to query posts.


### Route with controller: channel

A route becomes a **channel** by setting `controller: channel`. This turns the static route into a paginated stream of posts matching a filter:

    routes:
      /apple-news/:
        controller: channel
        filter: tag:[iphone,ipad,mac]
      /editors-column/:
        controller: channel
        filter: tag:column+primary_author:cameron
        template: editors-column
        order: published_at desc
        limit: 10

Channel routes get:

- Automatic pagination at `/apple-news/page/2/`, `/apple-news/page/3/`, etc.
- Automatic RSS feed at `/apple-news/rss/`
- Full filter syntax (same as Content API)
- Optional `order`, `limit`, `template`, and `data` properties

The channel controller (`controllers/channel.js`) is nearly identical to the collection controller: it reads `posts_per_page` from `package.json`, respects a `limit` override from `routes.yaml` (routes.yaml `limit` takes priority over theme config), paginates, and returns 404 when the requested page exceeds available pages.

Channels also accept `data` to load supplementary resource data alongside the post list:

    routes:
      /archive/:
        controller: channel
        template: archive
        data: page.archive
        order: published_at desc

This pattern works well for an archive channel that loads all posts and also fetches a page with slug `archive` for its title/description metadata.


## Collections Section

Collections define where posts **live** — their permanent URL structure. A post can only belong to one collection. Collections also generate the paginated index page at the collection's root URL.

Collections have two jobs:

1. Serve a paginated index of their posts at the collection root
2. Define the permalink pattern that determines each post's URL


### Required Properties

Every collection must specify `permalink`. `template` is optional (defaults to `index.hbs`).

    collections:
      /:
        permalink: /{slug}/
        template: index


### Permalink Variables

Permalink patterns support these dynamic variables:

- `{id}` — unique internal post ID (e.g. `5982d807bcf38100194efd67`)
- `{slug}` — post slug (e.g. `my-great-post`)
- `{year}` — four-digit publication year (e.g. `2024`)
- `{month}` — two-digit publication month (e.g. `04`)
- `{day}` — two-digit publication day (e.g. `29`)
- `{primary_tag}` — slug of the first tag on the post (e.g. `news`)
- `{primary_author}` — slug of the first author (e.g. `cameron`)

Examples:

    permalink: /{slug}/
    permalink: /blog/{slug}/
    permalink: /{year}/{month}/{day}/{slug}/
    permalink: /{primary_tag}/{slug}/


### Collection Filters

The `filter` property restricts which posts belong to a collection. It uses the full Ghost Content API filter syntax.

Basic operators:

- `:` — equals: `primary_tag:blog`
- `:-` — not equals: `primary_tag:-podcast`
- `+` — AND: `tag:news+featured:true`
- `,` — OR: `tag:[iphone,ipad,mac]`
- `[...]` — in list: `tag:[news,features]`
- `>`, `<`, `>=`, `<=` — comparison for numeric/date fields

Filter examples:

    filter: primary_tag:blog
    filter: primary_tag:podcast
    filter: 'tag:hash-de'
    filter: 'tag:-hash-de'
    filter: featured:true
    filter: primary_author:cameron+tag:news

**Critical rule:** collection filters must be mutually exclusive. If a post matches the filter for two collections, both collections will try to claim it as their own — leading to broken pagination and rendering. Always invert filters to ensure posts can only belong to one collection. Using `primary_tag` is the safest approach because each post has exactly one primary tag.

The collection controller (`controllers/collection.js`) enforces ownership: at render time, posts that `routerManager.owns()` does not attribute to the current collection are silently removed from the result set (this breaks pagination, which is why mutually exclusive filters matter at the data layer).


### Multiple Collections

    collections:
      /blog/:
        permalink: /blog/{slug}/
        template: blog
        filter: primary_tag:blog
      /podcast/:
        permalink: /podcast/{slug}/
        template: podcast
        filter: primary_tag:podcast

- Blog posts live at `site.com/blog/my-story/` and list at `site.com/blog/`
- Podcast episodes live at `site.com/podcast/my-episode/` and list at `site.com/podcast/`


### Collection with Data

Collections accept a `data` property to load resource data into the collection index template. This is how you give a collection index page a proper title, description, and meta tags:

    collections:
      /portfolio/:
        permalink: /work/{slug}/
        template: work
        filter: primary_tag:work
        data: tag.work

The `work.hbs` template can use `{{#tag}}{{name}}{{/tag}}` to access the tag's name, description, and feature image. The original taxonomy URL `site.com/tag/work/` is automatically redirected to `site.com/portfolio/`.


### Collection Properties Reference

| Property | Required | Description |
| --- | --- | --- |
| `permalink` | Yes | URL pattern for posts in this collection |
| `template` | No | Template file (default: `index`) |
| `filter` | No | Content API filter string |
| `order` | No | Sort order (default: `published_at desc`) |
| `limit` | No | Posts per page (overrides `posts_per_page` from `package.json`) |
| `data` | No | Resource to fetch for the index template |
| `rss` | No | Set to `false` to disable auto-generated RSS feed |

The `order` property accepts any post field plus direction:

- `published_at desc` — newest first (default)
- `published_at asc` — oldest first
- `featured desc, published_at desc` — featured posts first, then chronological


### Pagination in Collections

Pagination is registered automatically at `{collection-root}/page/:page/` — e.g. `/blog/page/2/`. The page param middleware validates the param is a positive integer.

The limit per page is resolved in this priority order:

1. `limit` property in `routes.yaml` collection config (strongest)
2. `posts_per_page` in theme `package.json`
3. Ghost's internal default (15)

When `routes.yaml` sets `limit`, the collection controller also updates `@config.posts_per_page` in the template context so `{{#if @config.posts_per_page}}` remains accurate.

Requesting a page number beyond the available pages returns a 404.


## Taxonomies Section

Taxonomies are automatic archives generated for tags and authors. Unlike collections, taxonomy URLs do not affect post URLs, and posts can appear in multiple taxonomies simultaneously.

Default:

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

Each taxonomy archive automatically gets its own RSS feed at `/{taxonomy}/{slug}/rss/`.


### Customising Taxonomy URLs

You can change the URL prefix but cannot create new taxonomy types:

    taxonomies:
      tag: /topic/{slug}/
      author: /host/{slug}/

Ghost only supports `tag` and `author` taxonomy keys.


### Removing Taxonomies

Leave the section empty to disable taxonomy archives entirely:

    taxonomies:

If you remove taxonomies, update all theme templates to avoid linking to tag or author archive URLs — they will 404. Helpers like `{{tags}}` and `{{authors}}` default to generating taxonomy links, so you will need to pass `visibility="all"` or custom link overrides.


## Collections vs Channels

Both filter posts and return paginated lists. The key difference is **URL ownership**:

Use a **collection** when:

- You want posts to live permanently at a URL determined by the collection (e.g. `/blog/my-post/`)
- You are separating incompatible content types (blog vs podcast, English vs German)
- You need the collection index URL to be the post's canonical home

Use a **channel** when:

- You want a filtered view without changing where posts "live"
- Posts belong to multiple views simultaneously (e.g. featured AND tagged)
- You want to combine or intersect existing content into a hub page
- You need to change the filter later without breaking post URLs

Channels are "permanent search results" — a computed view over existing content. Collections are the site's information architecture.


## Template Resolution for Routes

When Ghost renders a route, it selects a template using this lookup order for **collections and channels**:

1. Custom templates listed in `template:` array (tried in order)
2. The template name specified in `template:` string
3. `index.hbs` as the fallback

For **static routes**, no fallback exists — if the named template file is missing, Ghost throws an error. Always ensure the template file exists in the theme before deploying a custom route.

For **collection index** at the root `/` URL, Ghost additionally checks for `home.hbs` first (the `frontPageTemplate: 'home'` in `_prepareEntriesContext`). This means the root collection index renders `home.hbs` if it exists, otherwise falls back to `index.hbs`.

The `template` property can be a string or array:

    collections:
      /:
        permalink: /{slug}/
        template:
          - home
          - index

Ghost tries `home.hbs` first, then `index.hbs`.

### Context Set by Route Type

The `context` array on `res.routerOptions` determines which body class and template context helpers activate:

- Collection index: context is `[collectionName]` (e.g. `['index']`, `['blog']`)
- Collection entry (a post): context switches to `['post']`
- Channel: context is `[routerName]` (derived from the route path)
- Static route: context is `[routerName]`

This context array maps directly to the `{{body_class}}` helper output and determines which `{{#is}}` conditions are truthy in templates.


## Redirects

Redirects are managed in a separate file: `content/data/redirects.yaml`. This file is also downloadable/uploadable from Ghost Admin.

`redirects.yaml` structure:

    301:
      /old-url/: /new-url/
      /another-old/: /another-new/

    302:
      /temporary-redirect/: /somewhere-else/

- **301** — permanent redirect (search engines transfer link equity)
- **302** — temporary redirect (search engines keep the original URL indexed)

When not to use `redirects.yaml`:

- www / HTTPS redirects — handle at DNS/CDN level
- Trailing slash normalisation — Ghost handles this automatically
- Structural URL changes — prefer `routes.yaml` permalink changes (but use `redirects.yaml` for posts that have already been indexed at old URLs)

Note: when `data:` is assigned to a route or collection, Ghost automatically issues a redirect from the resource's original URL to the new route. You do not need a manual entry in `redirects.yaml` for those.


## Common Layouts

### Custom Homepage + Blog at /blog/

Move all posts off the root and put a static landing page there:

    routes:
      /: home

    collections:
      /blog/:
        permalink: /blog/{slug}/
        template: index

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

`home.hbs` is a fully static template (no automatic data). Use `{{#get "posts" limit="3"}}` inside it to fetch recent posts manually.


### Magazine Layout (Multiple Collections)

Split content into distinct editorial channels:

    routes:

    collections:
      /features/:
        permalink: /features/{slug}/
        template: features-index
        filter: primary_tag:features
        data: tag.features
      /news/:
        permalink: /news/{slug}/
        template: news-index
        filter: primary_tag:news
        data: tag.news
      /opinion/:
        permalink: /opinion/{slug}/
        template: opinion-index
        filter: primary_tag:opinion
        data: tag.opinion

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

Each collection gets its own index template, its own permalink pattern, and loads the corresponding tag's metadata (title, description, feature image) for SEO.


### Podcast Section

    routes:

    collections:
      /:
        permalink: /{slug}/
        template: index
        filter: primary_tag:-podcast
      /podcast/:
        permalink: /podcast/{slug}/
        template: podcast
        filter: primary_tag:podcast
        data: tag.podcast

    taxonomies:
      tag: /topic/{slug}/
      author: /host/{slug}/

The main collection excludes podcast posts. The podcast collection uses inverted filter. Taxonomy prefixes are renamed to suit audio publishing conventions. Podcast episodes have their own RSS feed at `/podcast/rss/`.

Add a custom podcast RSS template:

    routes:
      /podcast/rss/:
        template: podcast-rss
        content_type: text/xml

Note: place this route before the collection in `routes.yaml` — routes are matched in declaration order.


### Portfolio Site

    routes:
      /: home

    collections:
      /work/:
        permalink: /work/{slug}/
        template: work
        filter: primary_tag:work
        data: tag.work
      /writing/:
        permalink: /writing/{slug}/
        template: index
        filter: primary_tag:writing

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/


### Documentation Site

    routes:
      /docs/: docs-index

    collections:
      /docs/guides/:
        permalink: /docs/guides/{slug}/
        template: doc
        filter: primary_tag:guide
      /docs/reference/:
        permalink: /docs/reference/{slug}/
        template: doc
        filter: primary_tag:reference

    taxonomies:

Taxonomy archives are disabled entirely — documentation sites rarely need author/tag archives. The `/docs/` landing page is a static route rendering a custom `docs-index.hbs` template.


### Multi-language Site

    collections:
      /:
        permalink: /{slug}/
        template: index
        filter: 'tag:-hash-de'
      /de/:
        permalink: /de/{slug}/
        template: index-de
        filter: 'tag:hash-de'

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

Ghost internal (private) tags are prefixed with `#` in the editor but stored as `hash-{name}` in the API. They are not shown in public tag lists but can be used in filters. The main collection explicitly excludes German posts to avoid overlap.


### Archive Channel

    routes:
      /archive/:
        controller: channel
        template: archive
        data: page.archive
        order: published_at desc

    collections:
      /:
        permalink: /{slug}/
        template: index

    taxonomies:
      tag: /tag/{slug}/
      author: /author/{slug}/

The archive channel shows all posts in reverse chronological order with full pagination. The `data: page.archive` loads a Ghost page with slug `archive` to provide the title and description for the archive index.


## Template Context and Data Access

The `data` property fundamentally changes what is available in the template context.

**Without `data`:** the template has access to `@site`, `@config`, `@labs`, navigation, and any data fetched explicitly with `{{#get}}`. No automatic post/page/tag/author object is injected.

**With `data: page.team`:** the page resource is fetched and injected. Inside the template:

    {{#page}}
      <h1>{{title}}</h1>
      {{content}}
    {{/page}}

**With `data: tag.work` on a collection:** the tag resource is fetched and available in the collection index template alongside the `posts` array:

    {{#tag}}
      <h1>{{name}}</h1>
      <p>{{description}}</p>
    {{/tag}}

    {{#foreach posts}}
      {{> "loop-card"}}
    {{/foreach}}

The original URL of the data resource (e.g. `site.com/tag/work/`) is automatically 301 redirected to the collection URL (e.g. `site.com/portfolio/`). This prevents duplicate content indexing.

For `post` and `page` resources, Ghost always fetches with `include: authors,tags,tiers` so all relations are available in the template without extra API calls.


## Limitations and Gotchas

**Slug conflicts** — dynamic routing is unaware of Ghost's content slugs. If you create a route `/about/` and a Ghost page with slug `about`, one will shadow the other. Ghost routes take precedence over content slugs in the URL resolution order. Manage this by choosing non-conflicting slugs.

**Collections must be unique** — overlapping collection filters break pagination silently. The collection controller filters out posts it doesn't "own" at render time, so a page of 10 posts might only render 8 if 2 matched a different collection. Always use `primary_tag` filters and invert them.

**Trailing slashes are required** — all route keys must end with `/`. Ghost enforces trailing slashes globally and routes without them will not match.

**Channels vs collections RSS** — both automatically generate RSS feeds. The feed URL is `{route}/rss/`. Disable with `rss: false` if unwanted.

**routes.yaml requires a Ghost restart** — unlike theme file changes, modifications to `routes.yaml` on the server require Ghost to restart. Uploading via Admin does trigger a reload automatically.

**YAML indentation** — 2 spaces only, no tabs. Any indentation error causes the entire `routes.yaml` to fail to parse and Ghost falls back to defaults.
