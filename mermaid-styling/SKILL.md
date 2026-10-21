---
name: mermaid-styling
description: "Styles and fixes Mermaid diagrams in VitePress, apps, and Markdown hosts. Use for themeVariables/themeCSS, dark mode, ELK orthogonal edges, clipped or overlapping labels, 'Syntax error' renders, or click-to-zoom."
---

# Mermaid Styling


Mermaid draws each diagram into an SVG at render time, sizing every box by measuring its label text in the configured font. Styling that ignores this shows up as clipped labels, overlapping text, or diagrams that look right on one page load and broken on the next. This skill covers the styling options, the layout engines, the text-measurement traps, and a complete theme. The rendering behavior was verified on Mermaid 11.15–11.17; Mermaid 12 (September 2026) bundles ELK and changes defaults, and the references call out where that matters.

## Three ways to style a diagram


| Option | Where it lives | Reaches | Use it for |
|--------|----------------|---------|------------|
| `themeVariables` | `mermaid.initialize`, plugin config, or per-diagram frontmatter | Colors and the font Mermaid measures with | Palette, font family and size |
| `themeCSS` | `mermaid.initialize`, plugin config, or frontmatter (filtered) | Everything inside the SVG, scoped under the svg's id | Borders, shadows, radius, fill cycling, weights |
| Page CSS | Your site stylesheet | The `<svg>` element and its container, plus anything without an id-scoped rule | Canvas background, padding, cursor, layout of the block |

Use `theme: 'base'` and `look: 'classic'` as the starting point. On a Markdown host with no stylesheet access, per-diagram frontmatter is the only option, and Mermaid's sanitizer strips more than you expect from it; see `references/hosts.md`.

<constraints>

1. **Set the font in Mermaid's config, never only in page CSS.** Mermaid measures labels in the configured font when it renders; a different font at display time makes text wider or narrower than its box, so labels clip or float.
2. **Render after the web font has loaded.** Measured in the fallback face, boxes are sized wrong once the real font swaps in. Await `document.fonts.load(...)` before rendering, or re-render when it resolves.
3. **Keep host prose styles out of labels.** HTML labels sit in a `<foreignObject>` as `<p>`. When the renderer measures off-page (vitepress-plugin-mermaid), a site rule like `.vp-doc p { line-height: 1.75 }` applies at display but not at measurement and overflows every multi-line label. Reset it: `foreignObject p { line-height: inherit; }`.
4. **Style the diagram's insides with `themeCSS`, the `<svg>` itself with page CSS.** Mermaid scopes `themeCSS` under `#<svg-id>`, so it outranks page CSS without `!important`, but `&` turns into `#id #id` for anything beyond `font-family`, `font-size` and `fill`, and misses the svg root.
5. **Grow the svg's inline `max-width` by any padding you add.** Mermaid caps the svg at its natural width inline; under `box-sizing: border-box` the padding comes out of that cap and every diagram shrinks.
6. **On Mermaid 11, turn ELK on per diagram, for the types that support it.** A global `layout: 'elk'` breaks mindmaps (they throw) and some state diagrams (a note on a composite state throws), and a global `layout: 'dagre'` turns mindmaps into a layered tree. Mermaid 12 bundles ELK and picks it per type by default. See `references/layout.md`.
7. **Load `@mermaid-js/layout-elk` after the window `load` event, or keep diagrams off the `.mermaid` class.** The package bundles a second Mermaid copy whose load-time auto-run renders every `.mermaid` element lacking `data-processed`: an SVG a plugin wrote there becomes "Syntax error", and unrendered source gets a second render with default config.
8. **Call `mermaid.initialize` before `mermaid.detectType`.** Initialize registers the diagram detectors; before it, every type comes back unknown.
9. **Render one diagram per `mermaid.run` call when you need to know which failed.** `run` throws once for the batch, and a failed ELK render can leave a half-drawn SVG with no error marker.
10. **Keep connector lines quieter than the boxes in dark mode.** Near-white lines become the brightest thing in the diagram and look out of place; a muted mid-tone reads as structure. Shadows stay dark in both themes.
11. **Put labels that lines cross on chips.** SVG `<text>` takes no CSS background; draw a canvas-colored `<rect>` behind it and lift both above the drawing, or activation bars and lines paint through the words.
12. **Verify with a fresh browser per page and the font delayed.** A sweep that reuses one browser context loads only its first page cold and misses font-race clipping.

</constraints>

<workflow>

1. Identify the environment: VitePress (`references/vitepress.md`), an app calling `mermaid.run`/`render` itself (`references/direct-apps.md`), or a Markdown host (`references/hosts.md`).
2. Pick or adapt a look from `references/recipes.md`; build `themeVariables` and `themeCSS` from it.
3. Set the font in config, gate rendering on the font load, and reset host line-height on labels (`references/text-measurement.md`).
4. Put the canvas (background, padding, radius, `overflow: visible`) on the svg in page CSS, and widen its inline `max-width` after render.
5. Decide on ELK. If yes, follow `references/layout.md` exactly: per-diagram directive, load order, retry.
6. Add label chips and arrowhead sizing (`references/labels-and-markers.md`) and, if wanted, the click-to-zoom viewer (`references/viewer.md`).
7. Verify every diagram on every page with the checks in `references/verification.md` before calling it done.

</workflow>

## Reference Map


- What each option can reach, the variables per diagram family, and the CSS class map: `references/levers.md`
- Font, line-height, weight and padding traps that clip labels: `references/text-measurement.md`
- dagre curves, ELK setup, which types ELK breaks, per-diagram enable and retry: `references/layout.md`
- Label chips over lines and activation bars, arrowhead sizing: `references/labels-and-markers.md`
- A complete bold theme (light and dark) and palette rules: `references/recipes.md`
- VitePress with vitepress-plugin-mermaid: `references/vitepress.md`
- Apps that call mermaid directly (theme toggles, re-renders, vendoring): `references/direct-apps.md`
- GitHub, GitLab, Obsidian, Docusaurus, MkDocs Material: `references/hosts.md`
- Click-to-zoom viewer over the page instead of fullscreen: `references/viewer.md`
- Headless checks for clipping, errors, scale and re-renders: `references/verification.md`
