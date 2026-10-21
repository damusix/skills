# Verification


Unit tests cannot see clipped labels, a font race, or a diagram replaced by "Syntax error". Render every diagram in a real browser and measure. Playwright with Chromium is enough.

<workflow>

1. Build the site or app the way users get it (production build, not a dev server with hot reload).
2. Collect every page that contains a diagram.
3. For each page, open a **fresh browser context**, with the font host delayed by 3–4 seconds.
4. Wait until every diagram has rendered and the post-render work has run, then measure.
5. Load the same pages again in **one shared context** to cover cached loads.
6. Screenshot each diagram, light and dark, and look at them; numbers miss visual regressions.

</workflow>

## Checks per diagram


<example description="Per-diagram checks run in the page">

```js
const report = await page.$$eval('.content pre.mermaid', (blocks) => blocks.map((block) => {
    const svg = block.querySelector('svg')
    if (!svg) return { error: 'no svg' }
    const overflow = [...svg.querySelectorAll('foreignObject')].filter((fo) => {
        const c = fo.firstElementChild
        return c && (c.scrollWidth > Number(fo.getAttribute('width')) + 1 ||
                     c.scrollHeight > Number(fo.getAttribute('height')) + 1)
    }).length
    const viewBox = svg.viewBox.baseVal
    const drawn = svg.getBoundingClientRect().width - 24 // minus the canvas padding
    return {
        type: svg.getAttribute('aria-roledescription'), // 'error' for mermaid's error diagram
        overflow,                                       // labels wider or taller than their box
        scale: viewBox.width ? drawn / viewBox.width : 0, // 1.0 = natural size
    }
}))
```

</example>

| Check | Expect | A miss means |
|-------|--------|--------------|
| `type` | the diagram's type, never `error` or `null` | parse failure, the ELK auto-run, or a half-drawn ELK failure (`null`) |
| `overflow` | 0 | font, weight or line-height mismatch (`text-measurement.md`) |
| `scale` | 1.0, except full-width types like gantt | padding taken out of the inline max-width |
| Edge path `d` | no `C` commands on ELK types | ELK silently not applied |
| Mindmap node rows | as many distinct rows as nodes | a `layout` key turned it into a layered tree |

To tell right-angle edges from curves, read the first edge path: dagre's `basis` writes cubic `C` segments, ELK's rounded routing does not.

## Delaying the font


<example description="Fresh Playwright context with the font host delayed">

```js
const ctx = await browser.newContext()
await ctx.route('**/fonts.gstatic.com/**', async (route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.continue()
})
```

</example>

Proving the check works: remove the font fix, run it, and confirm it reports overflow. In one run, 39 labels across 10 diagrams overflowed with the fix removed and 0 with it in place.

## Re-renders and flicker


Record every svg inserted into a diagram block to confirm each diagram renders once per load:

<example description="Record each svg insertion">

```js
await ctx.addInitScript(() => {
    window.__renders = []
    new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
            if (n.nodeName === 'svg' && n.parentElement?.matches('pre.mermaid')) {
                window.__renders.push(performance.now())
            }
        }
    }).observe(document, { childList: true, subtree: true })
})
```

</example>

<constraints>

### Probe mistakes that waste time


- **`waitUntil: 'networkidle'` never resolves** on pages with live reload, server-sent events or analytics beacons. Use `'load'` and wait for the diagrams.
- **`[].every(...)` is `true`.** Waiting for "every block has an svg" passes before any block exists; also require a count above zero, or wait for the last post-render marker (for example every block's keyboard button).
- **One context for all pages loads only the first page cold.** Font-race and load-order bugs (the ELK auto-run) show up only on cold or cached loads specifically; test both.
- **Calling `mermaid.render` by hand after the page has rendered** succeeds even when the page's own first render failed: by then fonts are loaded, detectors registered and ELK chunks cached. Reproduce the page's own sequence instead.

</constraints>
