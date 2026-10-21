# VitePress with vitepress-plugin-mermaid


`vitepress-plugin-mermaid` turns fenced ` ```mermaid ` blocks into a `<Mermaid>` Vue component that calls `mermaid.initialize` and then `mermaid.render` on mount. Its config goes under a `mermaid` key in `.vitepress/config.mts`, wrapped by `withMermaid`. Version 2.0.x supports Mermaid 10 and 11 only (peer `mermaid "10 || 11"`), so the Mermaid 11 parts of `layout.md` apply.

<example description="Mermaid section of the VitePress config">

```ts
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
    mermaid: {
        fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif',
        flowchart: { padding: 16, diagramPadding: 20 },
        sequence: { diagramMarginX: 20, diagramMarginY: 20 },
        themeVariables: { /* ... */ },
        themeCSS: `/* ... */`,
    },
    mermaidPlugin: { class: 'ac-mermaid' },
}))
```

</example>

## Plugin behavior that shapes the config


<constraints>

- **It forces `theme: 'dark'` whenever `<html>` has the `dark` class** (`Mermaid.vue`: `if (hasDarkClass) mermaidConfig.theme = "dark"`), overriding any `theme` you set, including a page's `mermaidTheme` frontmatter (which only sets the light theme). `themeVariables` and `themeCSS` still apply on top, so style through those. Your variables override the dark theme's derived colors, not the base theme's.
- **It re-renders every diagram on any attribute change on `<html>`** (a `MutationObserver` meant for the dark toggle). That is also the hook for re-rendering after a web font loads: set an attribute when the font is ready. It fires for anything else that touches `<html>` too, including a viewer's scroll lock (`document.documentElement.style.overflow = 'hidden'`); the re-render cleans up by svg id, so the viewer's copy must carry a renamed id (`viewer.md`) or it is removed while open.
- **Its container class defaults to `mermaid`.** Change it with `mermaidPlugin: { class }` when anything else on the page runs `mermaid.run()` over `.mermaid` elements; the ELK package does (see `layout.md`). Update any CSS and scripts that target `.mermaid`.
- **It renders with one global config.** Per-diagram choices (ELK for some types only) have to be made by wrapping `mermaid.render`.

</constraints>

`appearance: 'force-dark'` in the site config pins VitePress to dark; then only the dark palette needs work.

## Theme entry: fonts, ELK, post-render work


<examples>

<example description="Theme entry: fonts, ELK registration, post-render work">

```ts
// .vitepress/theme/index.ts
import DefaultTheme from 'vitepress/theme'
import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'
import { setupMermaidZoom } from './mermaid-zoom'
import { routeMermaidLayouts, setupMermaidAdjustments } from './mermaid-render'

export default {
    extends: DefaultTheme,
    enhanceApp() {
        if (import.meta.env.SSR) return
        setupMermaidZoom()
        setupMermaidAdjustments()
        mermaid.registerLayoutLoaders(elkLayouts)
        routeMermaidLayouts(mermaid)
        // Diagrams rendered before the web font loaded are sized for the fallback
        // face; the plugin re-renders on any <html> attribute change.
        Promise.allSettled(['400', '600', '700'].map((w) => document.fonts.load(`${w} 15px Geist`)))
            .then(() => document.documentElement.setAttribute('data-fonts', 'ready'))
    },
}
```

</example>

Importing `mermaid` here resolves to the same module the plugin uses (Vite dedupes it), so `registerLayoutLoaders` and the `render` wrapper reach the plugin's instance. Confirm with `npm ls mermaid`: one deduped version.

<example description="Per-diagram ELK through a render wrapper, and post-render adjustments">

```ts
// .vitepress/theme/mermaid-render.ts
import type { Mermaid } from 'mermaid'
import { usesElk, withElk } from './mermaid-layout'          // from layout.md
import { chipLabels, makeRoomForPadding } from './mermaid-svg' // from labels-and-markers.md, text-measurement.md

// The plugin passes one config for every diagram, so ELK is switched on per
// diagram here, and dropped if it fails.
export function routeMermaidLayouts(mermaid: Mermaid) {
    const render = mermaid.render.bind(mermaid)
    mermaid.render = async (id: string, text: string, container?: Element) => {
        let type: string | null = null
        try {
            type = mermaid.detectType(text)
        } catch {
            type = null
        }
        if (!usesElk(type)) return render(id, text, container)
        try {
            return await render(id, withElk(text), container)
        } catch {
            return render(id, text, container)
        }
    }
}

// The plugin renders and re-renders on its own schedule, so each new svg is
// adjusted as it appears.
export function setupMermaidAdjustments() {
    const pending = '.ac-mermaid svg:not([data-label-chips])'
    const adjustNew = () => {
        const fill = getComputedStyle(document.documentElement).getPropertyValue('--vp-c-bg').trim()
        for (const svg of document.querySelectorAll<SVGSVGElement>(pending)) {
            svg.setAttribute('data-label-chips', '')
            makeRoomForPadding(svg)
            chipLabels(svg, fill)
        }
    }
    new MutationObserver(adjustNew).observe(document.body, { childList: true, subtree: true })
    adjustNew()
}
```

</example>

</examples>

`detectType` is safe inside the wrapper: the plugin has already called `mermaid.initialize` by the time it calls `render`. A failed `render` throws without leaving output in your container, so the retry starts clean.

## Theme CSS


<example description="Diagram canvas and label reset in the VitePress theme stylesheet">

```css
.vp-doc .ac-mermaid {
    cursor: zoom-in;
}

.vp-doc .ac-mermaid svg {
    padding: 12px;
    border-radius: 10px;
    background-color: var(--vp-c-bg);
    background-image: radial-gradient(#3a2e26 1px, transparent 1px);
    background-size: 18px 18px;
    overflow: visible;
}

/* Mermaid measures labels at its own line-height, outside .vp-doc. */
.vp-doc .ac-mermaid foreignObject p {
    line-height: inherit;
}
```

</example>

VitePress's base styles set `box-sizing: border-box` on everything, so the svg padding shrinks diagrams unless `makeRoomForPadding` widens the inline `max-width` (`text-measurement.md`).
