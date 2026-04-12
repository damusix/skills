# Responsive Images


## image_sizes Config


Define named size breakpoints in `package.json` under `config.image_sizes`. Ghost uses these as a server-side image proxy cache — resized copies are generated on first request per size and cached automatically. Sizes can be changed at any time; Ghost regenerates as needed.

Each size entry accepts:

- `width` — target pixel width (integer)
- `height` — target pixel height (integer, optional; omit to preserve aspect ratio)

Keep the total count at 10 or fewer to prevent media storage from growing out of control.

Example with a wider size range:

    // package.json
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

Example with a tighter size range (from Ghost docs):

    "image_sizes": {
        "xxs": { "width": 30 },
        "xs":  { "width": 100 },
        "s":   { "width": 300 },
        "m":   { "width": 600 },
        "l":   { "width": 1000 },
        "xl":  { "width": 2000 }
    }


## `{{img_url}}` Parameters


The `img_url` helper accepts three optional parameters beyond the image data property.

**`size`**

Pass a named key from `image_sizes` to get a resized URL. Without `size`, Ghost returns the original upload URL unchanged.

    {{img_url feature_image size="m"}}

**`format`**

Convert the image to a different format. Requires `size` to be set — `format` alone has no effect.

Accepted values:

- `"webp"` — supported by all modern browsers; reduces file size ~25% over JPEG/PNG with no visible quality loss
- `"avif"` — better compression than WebP but [not universally supported](https://caniuse.com/avif); does not support animation

    {{img_url feature_image size="l" format="webp"}}
    {{img_url feature_image size="l" format="avif"}}

Note: format conversion changes the encoded bytes but does not change the file extension. An AVIF-encoded image still shows a `.jpg` extension in the URL.

**`absolute`**

Forces an absolute URL even when the site is configured for relative URLs. Useful for Open Graph tags and RSS feeds.

    {{img_url feature_image size="l" absolute="true"}}


## Format Conversion and Browser Support


WebP is safe to use as the primary modern format — all current browsers support it. AVIF delivers superior compression but requires a fallback because older browsers and Safari versions below 16.4 do not support it. AVIF also does not support animated images.

Always provide an original-format fallback using the `<picture>` element so browsers that do not recognize a `<source>` skip to `<img>`.

| Format | Compression vs JPEG | Browser support | Animation |
|--------|---------------------|-----------------|-----------|
| AVIF   | ~50% smaller        | Partial (caniuse.com/avif) | No |
| WebP   | ~25% smaller        | All modern      | Yes       |
| JPEG/PNG | baseline          | Universal       | PNG only  |


## `<picture>` Element with Format Fallbacks


The browser evaluates `<source>` elements top to bottom and uses the first one it supports. The `<img>` at the bottom is the universal fallback and is always required.

    <picture>
        <!-- AVIF: best compression; remove if feature image may be animated -->
        <source
            srcset="{{img_url feature_image size="s" format="avif"}} 300w,
                    {{img_url feature_image size="m" format="avif"}} 600w,
                    {{img_url feature_image size="l" format="avif"}} 1000w,
                    {{img_url feature_image size="xl" format="avif"}} 2000w"
            sizes="(min-width: 1400px) 1400px, 92vw"
            type="image/avif"
        >
        <!-- WebP: good compression; universal modern support -->
        <source
            srcset="{{img_url feature_image size="s" format="webp"}} 300w,
                    {{img_url feature_image size="m" format="webp"}} 600w,
                    {{img_url feature_image size="l" format="webp"}} 1000w,
                    {{img_url feature_image size="xl" format="webp"}} 2000w"
            sizes="(min-width: 1400px) 1400px, 92vw"
            type="image/webp"
        >
        <!-- Original format fallback -->
        <img
            srcset="{{img_url feature_image size="s"}} 300w,
                    {{img_url feature_image size="m"}} 600w,
                    {{img_url feature_image size="l"}} 1000w,
                    {{img_url feature_image size="xl"}} 2000w"
            sizes="(min-width: 1400px) 1400px, 92vw"
            src="{{img_url feature_image size="xl"}}"
            alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
        >
    </picture>


## srcset + sizes Patterns


### Full-width hero (post feature image)

Used when the image spans the full viewport or a wide content column. The `sizes` value tells the browser what CSS width the image will render at before it downloads.

    <img
        srcset="{{img_url feature_image size="s"}} 300w,
                {{img_url feature_image size="m"}} 600w,
                {{img_url feature_image size="l"}} 1000w,
                {{img_url feature_image size="xl"}} 2000w"
        sizes="(max-width: 1000px) 400px, 700px"
        src="{{img_url feature_image size="m"}}"
        alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
        loading="lazy"
        decoding="async"
    >

### Content-width image (narrow/wide post body)

For constrained-width post layouts, use a `sizes` hint that reflects the actual rendered column width:

    <img
        srcset="{{img_url feature_image size="s"}} 400w,
                {{img_url feature_image size="m"}} 750w,
                {{img_url feature_image size="l"}} 960w,
                {{img_url feature_image size="xl"}} 1140w"
        sizes="(min-width: 1400px) 1400px, 92vw"
        src="{{img_url feature_image size="m"}}"
        alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
        loading="lazy"
        decoding="async"
    >

A reusable srcset partial (`partials/srcset.hbs`) can encode this four-stop pattern for reuse:

    {{img_url feature_image size="s"}} 400w,
    {{img_url feature_image size="m"}} 750w,
    {{img_url feature_image size="l"}} 960w,
    {{img_url feature_image size="xl"}} 1140w

Include it via `srcset="{{> srcset}}"` inside any `<img>` tag.

### Card grid (two-column feed)

When images appear in a two-column grid the rendered size is roughly half the viewport minus gutters. A common loop-card pattern uses this `sizes` descriptor:

    <img
        srcset="{{> srcset}}"
        sizes="(min-width: 1256px) calc((1130px - 60px) / 2),
               (min-width: 992px)  calc((90vw - 60px) / 2),
               (min-width: 768px)  calc((90vw - 30px) / 2),
               90vw"
        src="{{img_url feature_image size="m"}}"
        alt="{{title}}"
        loading="lazy"
    >

Break down the math: at wide viewports the grid is capped at 1130px with a 60px gap, so each cell is `(1130px - 60px) / 2 = 535px`. Below 768px the grid collapses to a single column at `90vw`.

### Sidebar thumbnails / author avatars

Small, fixed-size images need only one size stop. The `sizes` attribute can be omitted or set to the fixed pixel value when the rendered size never changes.

    {{#if profile_image}}
        <img
            src="{{img_url profile_image size="xs"}}"
            alt="{{name}}"
            loading="lazy"
        >
    {{/if}}

For slightly larger thumbnails used in related-post rows, `size="s"` (400px) is appropriate. For hero author cards, use `size="m"`.


## How Ghost's Image Proxy Works


Ghost resizes images server-side through a built-in image proxy. Key behaviors:

- Resized variants are generated on the **first request** for each image-size combination, then cached.
- Ghost automatically regenerates cached sizes when: the source image changes, `image_sizes` config changes, or a theme update is deployed.
- The proxy applies to **feature images and theme images uploaded to Ghost storage**. It does not apply to externally hosted images (except Unsplash, which has its own CDN resizing integration).
- If you use a third-party storage adapter (S3, Cloudinary, etc.), `img_url` returns the URL determined by the external source — Ghost's resizing is bypassed.
- The file extension in the returned URL is always the original extension regardless of `format` conversion. The bytes are re-encoded but the path is unchanged.


## Lazy Loading and Decode Hints


Add `loading="lazy"` to all images that are not in the initial viewport (below the fold). For above-the-fold hero images, omit `loading="lazy"` or use `loading="eager"` to avoid delaying the Largest Contentful Paint (LCP) element.

Add `decoding="async"` to tell the browser it may decode the image off the main thread, improving page responsiveness.

    <!-- Below-the-fold card image -->
    <img
        src="{{img_url feature_image size="m"}}"
        alt="{{title}}"
        loading="lazy"
        decoding="async"
    >

    <!-- Above-the-fold hero: no lazy, explicit eager -->
    <img
        src="{{img_url feature_image size="xl"}}"
        alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
        loading="eager"
        decoding="async"
    >


## Feature Image Alt Text


Ghost provides two sources for feature image alt text.

- `feature_image_alt` — a dedicated alt text field set by the editor in Ghost Admin. Use this first.
- `title` — the post title; use as fallback when `feature_image_alt` is empty.

Always provide the conditional fallback pattern:

    alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"

Never leave `alt` empty on a meaningful feature image; that hides content from screen readers and degrades SEO.


## Feature Image Caption


`feature_image_caption` holds the caption string set by the editor. It supports arbitrary HTML (links, emphasis, etc.), so render it unescaped with triple-stache:

    {{#if feature_image_caption}}
        <figcaption class="feature-caption">
            {{{feature_image_caption}}}
        </figcaption>
    {{/if}}

Wrap image and caption together in a `<figure>` element for correct semantics:

    {{#if feature_image}}
        <figure class="post-feature-image">
            <img
                srcset="{{img_url feature_image size="s"}} 300w,
                        {{img_url feature_image size="m"}} 600w,
                        {{img_url feature_image size="l"}} 1000w,
                        {{img_url feature_image size="xl"}} 2000w"
                sizes="(min-width: 1400px) 1400px, 92vw"
                src="{{img_url feature_image size="xl"}}"
                alt="{{#if feature_image_alt}}{{feature_image_alt}}{{else}}{{title}}{{/if}}"
                loading="eager"
                decoding="async"
            >
            {{#if feature_image_caption}}
                <figcaption>{{{feature_image_caption}}}</figcaption>
            {{/if}}
        </figure>
    {{/if}}


## Author and Tag Images


### Author profile image

Available as `profile_image` inside an `{{#author}}` or `{{#foreach authors}}` block. Use `size="xs"` for small avatars and `size="s"` or `size="m"` for larger author cards.

    {{#foreach authors limit="1"}}
        {{#if profile_image}}
            <img
                src="{{img_url profile_image size="xs"}}"
                alt="{{name}}"
                loading="lazy"
            >
        {{/if}}
    {{/foreach}}

For a dedicated author page header, a larger size is appropriate:

    {{#author}}
        {{#if profile_image}}
            <img
                src="{{img_url profile_image size="m"}}"
                alt="{{name}}"
                loading="eager"
            >
        {{/if}}
    {{/author}}

### Author cover image

`cover_image` is a wide banner image on the author profile, distinct from `profile_image`. Use larger sizes and a full-width `sizes` hint:

    {{#author}}
        {{#if cover_image}}
            <img
                srcset="{{img_url cover_image size="m"}} 750w,
                        {{img_url cover_image size="l"}} 960w,
                        {{img_url cover_image size="xl"}} 1140w,
                        {{img_url cover_image size="xxl"}} 1920w"
                sizes="100vw"
                src="{{img_url cover_image size="l"}}"
                alt="{{name}}"
                loading="eager"
                decoding="async"
            >
        {{/if}}
    {{/author}}

### Tag cover image

Tags expose `feature_image` (not `cover_image`) inside a `{{#tag}}` block. The same sizing patterns apply:

    {{#tag}}
        {{#if feature_image}}
            <img
                srcset="{{img_url feature_image size="m"}} 750w,
                        {{img_url feature_image size="l"}} 960w,
                        {{img_url feature_image size="xl"}} 1140w"
                sizes="(min-width: 1400px) 1400px, 92vw"
                src="{{img_url feature_image size="l"}}"
                alt="{{name}}"
                loading="lazy"
            >
        {{/if}}
    {{/tag}}


## Reusable srcset Partial Pattern


Extract the srcset string into a partial (`partials/srcset.hbs`) when the same four size stops appear across multiple templates. This keeps the width descriptors consistent and reduces edit surface area.

`partials/srcset.hbs`:

    {{img_url feature_image size="s"}} 400w,
    {{img_url feature_image size="m"}} 750w,
    {{img_url feature_image size="l"}} 960w,
    {{img_url feature_image size="xl"}} 1140w

Usage in any template:

    <img
        srcset="{{> srcset}}"
        sizes="(min-width: 1256px) 535px, 90vw"
        src="{{img_url feature_image size="m"}}"
        alt="{{title}}"
        loading="lazy"
    >

The partial runs in the current Handlebars context, so `feature_image` resolves to whichever post is active in the surrounding `{{#foreach}}` or `{{#post}}` block.


## Compatibility Notes


- Dynamic image sizes do not work for externally hosted images, except Unsplash (which integrates with Ghost's image proxy directly).
- Third-party storage adapters (S3, Cloudinary, etc.) return their own URLs; Ghost resizing is not applied.
- The `format` parameter requires the `size` parameter — specifying `format` alone has no effect.
- Ghost image resizing applies to feature images and editor-inserted images that are stored in Ghost's local storage.
- Image size variants are generated lazily on first request per combination, so a freshly deployed theme with new size names may serve the original image on the very first load before the proxy has cached a resized copy.
