# Koenig Card CSS (`.kg-` Classes)

Ghost's rich text editor (Koenig) wraps every content block in a `<figure>` or `<div>` with `.kg-card` plus a card-type class. Ghost injects `cards.min.css` and `cards.min.js` automatically via `{{ghost_head}}` — themes must **not** duplicate those base styles, only override or extend them.


## Card Assets Config

Ghost injects all card assets by default. To opt out of specific cards (and write your own styles):

    // package.json
    "card_assets": {
        "exclude": ["bookmark", "gallery"]
    }

To disable all card assets (rare — you'd own all `.kg-` styles):

    "card_assets": false


## Width Modifier Classes

Applied alongside card-type classes to control breakout layout. All three depend on a CSS grid or negative-margin technique on the parent container.

| Class | Effect |
|---|---|
| _(none)_ | Normal / content width |
| `.kg-width-wide` | Wider than text column (e.g. 85 vw) |
| `.kg-width-full` | Full viewport width |

CSS grid implementation (used in Zurich theme):

    .kg-canvas {
        display: grid;
        grid-template-columns:
            [full-start] minmax(4vw, auto)
            [wide-start] minmax(auto, 240px)
            [main-start] min(640px, calc(100% - 8vw))
            [main-end] minmax(auto, 240px)
            [wide-end] minmax(4vw, auto)
            [full-end];
    }

    .kg-canvas > * { grid-column: main-start / main-end; }
    .kg-width-wide  { grid-column: wide-start / wide-end; }
    .kg-width-full  { grid-column: full-start / full-end; }

Negative-margin fallback (no grid):

    .kg-width-wide {
        position: relative;
        width: 85vw;
        min-width: 100%;
        margin: auto calc(50% - 50vw);
        transform: translateX(calc(50vw - 50%));
    }

    .kg-width-full {
        position: relative;
        width: 100vw;
        left: 50%;
        right: 50%;
        margin-left: -50vw;
        margin-right: -50vw;
    }


## Image Card

    <figure class="kg-card kg-image-card [kg-width-wide|kg-width-full] [kg-card-hascaption]">
        <img class="kg-image" src="..." width="..." height="..." loading="lazy" srcset="..." sizes="...">
        <figcaption>Caption text</figcaption>
    </figure>

Key classes:

- `.kg-image-card` — outer `<figure>`
- `.kg-image` — the `<img>` element
- `.kg-card-hascaption` — present when a caption exists

Always set `height: auto` alongside any `max-width` to prevent stretched images.


## Gallery Card

Requires theme CSS **and** the Ghost-provided gallery JS (or your own). GScan validates that `.kg-gallery-container`, `.kg-gallery-row`, and `.kg-gallery-image` are styled.

    <figure class="kg-card kg-gallery-card kg-width-wide">
        <div class="kg-gallery-container">
            <div class="kg-gallery-row">
                <div class="kg-gallery-image">
                    <img src="..." width="..." height="..." loading="lazy" srcset="..." sizes="...">
                </div>
                <!-- more .kg-gallery-image divs -->
            </div>
        </div>
    </figure>

Minimal required CSS (expand as needed):

    .kg-gallery-container { display: flex; flex-direction: column; }
    .kg-gallery-row       { display: flex; flex-direction: row; justify-content: center; }
    .kg-gallery-image     { flex: 1; margin: 4px; }
    .kg-gallery-image img { display: block; width: 100%; height: 100%; object-fit: cover; }


## Embed Card

    <figure class="kg-card kg-embed-card">
        <iframe ...></iframe>
    </figure>

For responsive video, wrap the iframe:

    .fluid-width-video-wrapper {
        position: relative;
        overflow: hidden;
        padding-top: 56.25%;
    }
    .fluid-width-video-wrapper iframe,
    .fluid-width-video-wrapper object,
    .fluid-width-video-wrapper embed {
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
    }


## Bookmark Card

    <figure class="kg-card kg-bookmark-card">
        <a href="..." class="kg-bookmark-container">
            <div class="kg-bookmark-content">
                <div class="kg-bookmark-title">...</div>
                <div class="kg-bookmark-description">...</div>
                <div class="kg-bookmark-metadata">
                    <img class="kg-bookmark-icon" src="...">
                    <span class="kg-bookmark-author">...</span>
                    <span class="kg-bookmark-publisher">...</span>
                </div>
            </div>
            <div class="kg-bookmark-thumbnail">
                <img src="...">
            </div>
        </a>
    </figure>


## Button Card

    <div class="kg-card kg-button-card kg-align-left|kg-align-center">
        <a href="..." class="kg-btn kg-btn-accent">Button text</a>
    </div>

- `.kg-btn-accent` — uses the site's accent color (set via Ghost Admin → Design → Accent Color)


## Callout Card

    <div class="kg-card kg-callout-card kg-callout-card-<color>">
        <div class="kg-callout-emoji">💡</div>
        <div class="kg-callout-text">...</div>
    </div>

Color modifier classes: `kg-callout-card-grey`, `kg-callout-card-white`, `kg-callout-card-blue`, `kg-callout-card-green`, `kg-callout-card-yellow`, `kg-callout-card-red`, `kg-callout-card-pink`, `kg-callout-card-purple`, `kg-callout-card-accent`.


## Toggle Card

    <div class="kg-card kg-toggle-card" data-kg-toggle-state="close">
        <div class="kg-toggle-heading">
            <h4 class="kg-toggle-heading-text">Question text</h4>
            <button class="kg-toggle-card-icon">
                <svg ...>...</svg>
            </button>
        </div>
        <div class="kg-toggle-content">Answer text</div>
    </div>

Requires Ghost-provided toggle JS (or a custom `data-kg-toggle-state` toggle handler).


## Blockquote Alt

    <blockquote>Standard blockquote</blockquote>

    <blockquote class="kg-blockquote-alt">Large pull-quote style</blockquote>

`.kg-blockquote-alt` is the second style, toggled by clicking the blockquote toolbar button again.


## Audio Card

    <div class="kg-card kg-audio-card">
        <img class="kg-audio-thumbnail" src="...">
        <div class="kg-audio-thumbnail placeholder kg-audio-hide"><!-- SVG icon --></div>
        <div class="kg-audio-player-container">
            <audio src="..." preload="metadata"></audio>
            <div class="kg-audio-title">...</div>
            <div class="kg-audio-player">
                <button class="kg-audio-play-icon">...</button>
                <button class="kg-audio-pause-icon kg-audio-hide">...</button>
                <span class="kg-audio-current-time">0:00</span>
                <div class="kg-audio-time">/<span class="kg-audio-duration">...</span></div>
                <input type="range" class="kg-audio-seek-slider">
                <button class="kg-audio-playback-rate">1×</button>
                <button class="kg-audio-unmute-icon">...</button>
                <button class="kg-audio-mute-icon kg-audio-hide">...</button>
                <input type="range" class="kg-audio-volume-slider">
            </div>
        </div>
    </div>

`.kg-audio-hide` toggles visibility — the JS flips this class between play/pause and mute/unmute buttons.


## Video Card

    <figure class="kg-card kg-video-card">
        <div class="kg-video-container">
            <video src="..." poster="..." playsinline preload="metadata"></video>
            <div class="kg-video-overlay">
                <button class="kg-video-large-play-icon">...</button>
            </div>
            <div class="kg-video-player-container">
                <div class="kg-video-player">
                    <button class="kg-video-play-icon">...</button>
                    <button class="kg-video-pause-icon kg-video-hide">...</button>
                    <span class="kg-video-current-time">0:00</span>
                    <div class="kg-video-time">/<span class="kg-video-duration"></span></div>
                    <input type="range" class="kg-video-seek-slider">
                    <button class="kg-video-playback-rate">1×</button>
                    <button class="kg-video-unmute-icon">...</button>
                    <button class="kg-video-mute-icon kg-video-hide">...</button>
                    <input type="range" class="kg-video-volume-slider">
                </div>
            </div>
        </div>
    </figure>


## File Card

    <div class="kg-card kg-file-card [kg-file-card-small|kg-file-card-medium]">
        <a class="kg-file-card-container" href="..." title="Download">
            <div class="kg-file-card-contents">
                <div class="kg-file-card-title">...</div>
                <div class="kg-file-card-caption">...</div>
                <div class="kg-file-card-metadata">
                    <div class="kg-file-card-filename">...</div>
                    <div class="kg-file-card-filesize">...</div>
                </div>
            </div>
            <div class="kg-file-card-icon"><!-- SVG download icon --></div>
        </a>
    </div>

Size modifiers: `kg-file-card-small`, `kg-file-card-medium` (no modifier = large).


## Product Card

    <div class="kg-card kg-product-card">
        <div class="kg-product-card-container">
            <img class="kg-product-card-image" src="...">
            <div class="kg-product-card-title-container">
                <h4 class="kg-product-card-title">...</h4>
            </div>
            <div class="kg-product-card-rating">
                <span class="kg-product-card-rating-star kg-product-card-rating-active"><!-- star svg --></span>
            </div>
            <div class="kg-product-card-description">...</div>
            <a href="..." class="kg-product-card-button kg-product-card-btn-accent">Buy now</a>
        </div>
    </div>


## Header Card (v1)

    <div class="kg-card kg-header-card kg-width-full kg-size-<size> kg-style-<style>"
         data-kg-background-image="...">
        <h2 class="kg-header-card-header">Heading</h2>
        <h3 class="kg-header-card-subheader">Subheading</h3>
        <a href="..." class="kg-header-card-button">Button text</a>
    </div>

Size modifiers: `kg-size-small`, `kg-size-medium` (default), `kg-size-large`.

Style modifiers: `kg-style-dark`, `kg-style-light`, `kg-style-accent`, `kg-style-image`.


## Header Card (v2)

    <div class="kg-card kg-header-card kg-v2 kg-width-full kg-size-<size> kg-style-<style>">
        <div class="kg-header-card-image">...</div>
        <div class="kg-header-card-content">
            <div class="kg-header-card-text">
                <h2 class="kg-header-card-heading">...</h2>
                <h3 class="kg-header-card-subheading">...</h3>
            </div>
            <a href="..." class="kg-header-card-button">...</a>
        </div>
    </div>

`.kg-v2` distinguishes v2 from v1 when styling.


## NFT Card

    <figure class="kg-card kg-embed-card kg-nft-card">
        <a class="kg-nft-card" href="...">
            <img class="kg-nft-image" src="...">
            <div class="kg-nft-metadata">
                <div class="kg-nft-header">
                    <h4 class="kg-nft-title">...</h4>
                </div>
                <div class="kg-nft-creator">
                    Created by <span class="kg-nft-creator-name">...</span>
                </div>
            </div>
        </a>
    </figure>


## Signup Card

    <div class="kg-card kg-signup-card kg-width-[regular|wide|full] [kg-layout-split]"
         data-lexical-signup-form="">
        <div class="kg-signup-card-content">
            <picture><img class="kg-signup-card-image" src="" alt=""></picture>
            <div class="kg-signup-card-text">
                <h2 class="kg-signup-card-heading">...</h2>
                <h3 class="kg-signup-card-subheading">...</h3>
                <form class="kg-signup-card-form" data-members-form="signup">
                    <div class="kg-signup-card-fields">
                        <input class="kg-signup-card-input" type="email" data-members-email>
                        <button class="kg-signup-card-button kg-style-accent" type="submit">
                            <span class="kg-signup-card-button-default">Subscribe</span>
                            <span class="kg-signup-card-button-loading"><!-- spinner --></span>
                        </button>
                    </div>
                    <div class="kg-signup-card-success">...</div>
                    <div class="kg-signup-card-error" data-members-error></div>
                </form>
                <p class="kg-signup-card-disclaimer">...</p>
            </div>
        </div>
    </div>

- `.kg-layout-split` — present when image is adjacent to text (split layout)
- `.kg-content-wide` — added on full-width and split-layout cards; use it to constrain inner content width

Width modifiers: `kg-width-regular`, `kg-width-wide`, `kg-width-full`.


## Call-to-Action Card (CTA)

Newer card. Background color and layout are controlled by modifier classes.

    <div class="kg-card kg-cta-card kg-cta-bg-<color> [kg-cta-centered] [kg-cta-immersive] [kg-cta-minimal] [kg-cta-has-img]">
        <div class="kg-cta-sponsor-label-wrapper">
            <span class="kg-cta-sponsor-label">Sponsored</span>
        </div>
        <div class="kg-cta-content">
            <div class="kg-cta-content-inner">
                <div class="kg-cta-image-container"><!-- image --></div>
                <div class="kg-cta-text">...</div>
                <a href="..." class="kg-cta-button kg-cta-link-accent">...</a>
            </div>
        </div>
    </div>

Background color modifiers: `kg-cta-bg-grey`, `kg-cta-bg-white`, `kg-cta-bg-blue`, `kg-cta-bg-green`, `kg-cta-bg-yellow`, `kg-cta-bg-red`, `kg-cta-bg-pink`, `kg-cta-bg-purple`, `kg-cta-bg-none`.

Layout modifiers: `kg-cta-centered`, `kg-cta-immersive`, `kg-cta-minimal`, `kg-cta-no-dividers`.


## Collection Card

Displays a curated list of posts inside a post/page. Rendered by Ghost server-side.

    <div class="kg-card kg-collection-card">
        <h2 class="kg-collection-card-title">Collection title</h2>
        <div class="kg-collection-card-grid">
            <a class="kg-collection-card-post-wrapper" href="...">
                <div class="kg-collection-card-post">
                    <div class="kg-collection-card-img">
                        <img src="..." alt="...">
                    </div>
                    <div class="kg-collection-card-content">
                        <h2 class="kg-collection-card-post-title">...</h2>
                        <p class="kg-collection-card-post-excerpt">...</p>
                        <div class="kg-collection-card-post-meta">...</div>
                    </div>
                </div>
            </a>
        </div>
        <div class="kg-collection-card-list"><!-- list layout variant --></div>
    </div>


## Transistor Card

Podcast embed via Transistor.fm.

    <figure class="kg-card kg-transistor-card">
        <div class="kg-transistor-content">
            <div class="kg-transistor-icon"><!-- Transistor logo svg --></div>
            <div class="kg-transistor-placeholder"><!-- optional thumbnail --></div>
            <div class="kg-transistor-title">...</div>
            <div class="kg-transistor-description">...</div>
        </div>
    </figure>


## Grid Layout Utilities

Used internally by Ghost for multi-column card layouts.

| Class | Purpose |
|---|---|
| `.kg-grid` | `display: grid; column-gap: 24px; row-gap: 24px` |
| `.kg-grid-2col` | 2-column grid |
| `.kg-grid-3col` | 3-column grid |
| `.kg-grid-4col` | 4-column grid (3 at ≤1024px, 2 at ≤767px) |
| `.kg-gallery-grid` | Grid with featured-image area placements |


## Overriding Built-in Card Styles

Target card classes in your own CSS. Ghost's `cards.min.css` is loaded first, so your theme CSS wins in cascade order. Example: theme-specific border radius for cards:

    .kg-card.kg-file-card a.kg-file-card-container,
    .kg-toggle-card,
    .kg-bookmark-card .kg-bookmark-container,
    .kg-product-card-container {
        border-radius: var(--corner-radius-small);
    }

Example: make audio/video controls respect the theme text color:

    .kg-audio-player-container button,
    .kg-video-card button {
        color: var(--primary-text-color);
    }


## Post Content Vertical Rhythm with Card Spacing

The canonical pattern from Ghost's reference theme. Spacing uses `max(vmin, px)` so gaps scale with viewport size but have a hard floor:

    /* Default gap between all sibling elements */
    .gh-content > * + * {
        margin-top: max(3.2vmin, 24px);
        margin-bottom: 0;
    }

    /* Headings: large top gap to open sections; smaller gap after */
    .gh-content > [id]:not(:first-child) { margin-top: 2em; }
    .gh-content > [id] + *              { margin-top: 1.5rem !important; }

    /* Larger gap before/after block-level breaks */
    .gh-content > blockquote,
    .gh-content > hr {
        position: relative;
        margin-top: max(4.8vmin, 32px);
    }
    .gh-content > blockquote + *,
    .gh-content > hr + * { margin-top: max(4.8vmin, 32px) !important; }

    /* Transition between prose and cards */
    .gh-content .kg-card + :not(.kg-card),
    .gh-content :not(.kg-card):not([id]) + .kg-card { margin-top: 6vmin; }

    /* Consecutive full-width cards butt flush against each other — no gap */
    .gh-content > .kg-width-full + .kg-width-full:not(
        .kg-width-full.kg-card-hascaption + .kg-width-full
    ) {
        margin-top: 0;
    }

    /* Opening/closing padding when content is the only child */
    .gh-content:only-child > :first-child:not(.kg-width-full) { margin-top: max(12vmin, 64px); }
    .gh-content > :last-child:not(.kg-width-full)             { margin-bottom: max(12vmin, 64px); }

The `kg-card-hascaption` exception on the consecutive full-width rule preserves the gap when a captioned full-width card is followed by another full-width card — the caption belongs visually to the first card, not the gap.


## Prose Link Styling

Ghost's reference theme styles content links with the accent color, underline, and `word-break` to handle long URLs:

    .gh-content a {
        color: var(--ghost-accent-color);
        text-decoration: underline;
        word-break: break-word;
    }

To avoid styling links inside `.kg-` cards (bookmark containers, gallery items, etc.), scope the rule to direct descendants or use `:not([class*="kg-"])`:

    .gh-content a:not([class*="kg-"]) {
        color: var(--ghost-accent-color);
        text-decoration: underline;
        word-break: break-word;
    }

The `[class*="kg-"]` attribute selector catches any element whose class contains `kg-`, covering all card link variants without enumerating them.

Blockquote left-accent bar using the accent color:

    .gh-content > blockquote:not([class]) {
        font-style: italic;
        padding: 0;
        position: relative;
    }

    .gh-content > blockquote:not([class])::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: min(-4vmin, -20px);
        width: 0.3rem;
        background: var(--ghost-accent-color);
    }
