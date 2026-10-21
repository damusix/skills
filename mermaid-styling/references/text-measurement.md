# Text measurement: why labels clip


Mermaid sizes every node box, edge label and actor by measuring its label at render time. The box is then fixed. Anything that makes the label render differently from how it was measured (another font, another line height, another weight) leaves text overflowing or floating inside its box. The symptoms are cut-off descenders, a word wrapped onto a line the box has no room for, or labels that fit on one page load and clip on the next.

## 1. Font: set it in Mermaid's config


<example description="Font named in Mermaid's config">

```js
const font = '"Geist", ui-sans-serif, system-ui, sans-serif'

mermaid.initialize({
    theme: 'base',
    fontFamily: font,
    themeVariables: { fontSize: '15px' },
})
```

</example>

A font applied only from page CSS changes the glyphs after measurement. Mermaid measures with `fontFamily` from its config, so that has to name the page font.

## 2. Font loading: render after the font arrives


A web font with `display=swap` usually has not loaded when the first diagram renders on a cold visit. Mermaid measures in the fallback face; the real font swaps in wider and labels overflow. Reloading the page hides it, because the font is cached, which is why this bug looks intermittent.

When you call render yourself, wait for every weight the labels use:

<example description="Wait for the label font weights before rendering">

```js
async function fontsReady(stack) {
    if (!document.fonts) return
    await Promise.allSettled(['400', '600'].map((weight) => document.fonts.load(`${weight} 14px ${stack}`)))
}

await fontsReady(getComputedStyle(document.documentElement).getPropertyValue('--sans'))
await mermaid.run({ nodes })
```

</example>

`allSettled`, not `all`: when the font host is blocked (ad blocker, offline), `load` rejects and an unhandled rejection is logged on every page. Labels still fit then, because the fallback face is used both to measure and to draw.

When a plugin renders for you (VitePress), re-render once the fonts load; see `vitepress.md`.

## 3. Weight: use a weight the font stylesheet loads


Bold node labels (`.nodeLabel { font-weight: 700 }` in `themeCSS`) are measured at 700. If the font stylesheet only loads 400–600, the browser falls back to the nearest loaded weight or a synthesized bold, and widths drift. Check the font URL's `wght@` list and use one of those weights, or add the weight to the URL.

`themeCSS` rules are present while Mermaid measures, so a weight set there is measured; a weight set only in page CSS is not.

## 4. Line height: reset host prose styles inside labels


HTML labels are a `<p>` inside a `<foreignObject>`, and Mermaid's label wrapper sets `line-height: 1.5` inline. Called without a container, as vitepress-plugin-mermaid calls it, `mermaid.render` draws and measures in a temporary `<div>` appended to `<body>`, outside your content container. On the page the same `<p>` then also matches the site's prose rules: VitePress's `.vp-doc p` sets `line-height` to 1.75, enough to push every multi-line label past its box (measured: a 2-line box of 45px holding 53px of text).

<example description="Reset the host line-height inside labels">

```css
.vp-doc .ac-mermaid foreignObject p {
    line-height: inherit;
}
```

</example>

`mermaid.run` renders inside the element itself, so a host `p` rule applies at measurement and at display and this mismatch does not occur. A host rule that matches only later (a class added after render, a different container) still leaks. Scope the reset to your diagram container. Any host rule on `p` (margin, color, line-height) can leak this way; `color: inherit` is a common second reset.

## 5. Padding: widen the inline max-width


Mermaid writes `style="max-width: <natural>px"` on the svg. A canvas `padding: 12px` on that svg, under the common global `* { box-sizing: border-box }` (VitePress's preflight has it too), is taken out of that max-width, so the drawing renders at (N − 24) / N of its natural size. Measured scales were 0.71 to 0.85 on small diagrams.

Grow the cap after render:

<example description="Widen the inline max-width by the canvas padding">

```js
const CANVAS_PADDING = 12 // must match the padding in your stylesheet

export function makeRoomForPadding(svg) {
    const cap = Number.parseFloat(svg.style.maxWidth)
    if (Number.isFinite(cap)) svg.style.maxWidth = `${cap + CANVAS_PADDING * 2}px`
}
```

</example>

## Diagnosing a clipped label


Compare each `foreignObject`'s declared size with its content:

<example description="Find labels larger than their box">

```js
const clipped = [...document.querySelectorAll('svg foreignObject')].filter((fo) => {
    const content = fo.firstElementChild
    return content && (
        content.scrollWidth > Number(fo.getAttribute('width')) + 1 ||
        content.scrollHeight > Number(fo.getAttribute('height')) + 1
    )
})
```

</example>

Content height above the box height with a matching width points to line height; content width above the box width points to font or weight. Run it with the font host delayed (see `verification.md`) to catch the loading race.
