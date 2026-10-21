# Apps that call mermaid directly


When your own code calls `mermaid.run` or `mermaid.render` (a React/Vue/Svelte app, server-rendered pages with a client script, a docs browser), you control the order of everything that the plugins get wrong: the font wait, ELK registration, per-diagram layout, theme re-renders and post-render work.

## Source in, SVG out, source kept


Render from a stashed copy of each diagram's source, never from the element's current contents: after the first render the element holds an SVG, and a theme toggle has to put the source back before rendering again.

<examples>

<example description="Stash the source before the first render">

```js
for (const node of nodes) {
    if (!node.dataset.mermaidSrc) node.dataset.mermaidSrc = node.textContent ?? ''
}
```

</example>

<example description="Restore the source before a re-render">

```js
node.removeAttribute('data-processed') // run() skips nodes that carry it
node.textContent = node.dataset.mermaidSrc
```

</example>

</examples>

Until the svg replaces it, the element shows its raw source. `run` sets `data-processed` before it renders, so a `:not([data-processed])` rule stops hiding the source while the render is still in progress. Hide it on the block:

```css
pre.mermaid { color: transparent; }
```

Mermaid 11.17 paints every label's color itself, so nothing inside the diagram reads the block's color. Journey labels take `textColor`, which the bold theme sets to the page ink for titles, legends and sequence messages; on journey's bright fills that is unreadable, so `recipes.md` names it back in `themeCSS`.

## One render function for mount and re-render


<example description="Render loop with per-diagram ELK, retry and post-render work">

```js
// The palette lives in CSS custom properties that the theme toggle swaps
// (recipes.md), so every render reads the current values.
function readPalette() {
    const style = getComputedStyle(document.documentElement)
    const read = (name) => style.getPropertyValue(name).trim()
    return {
        canvas: read('--diagram-canvas'),
        line: read('--diagram-line'),
        label: read('--diagram-label'),
        shadow: read('--diagram-shadow'),
        text: read('--diagram-text'),
    }
}

async function render(mermaid, nodes) {
    const elkReady = await registerElkLayouts(mermaid) // see "Loading ELK" below
    const palette = readPalette()
    mermaid.initialize(config(palette)) // before detectType

    for (const [i, node] of nodes.entries()) {
        const src = node.dataset.mermaidSrc ?? ''
        let type = null
        try { type = mermaid.detectType(src) } catch {}
        const elk = elkReady && usesElk(type)

        setSource(node, elk ? withElk(src) : src)
        let ok = await runOne(mermaid, node)
        if (!ok && elk) {
            setSource(node, src)
            ok = await runOne(mermaid, node)
        }
        if (ok) finish(node, palette.canvas, i + 1) // malformed source keeps mermaid's own error output
    }
}

function config(palette) {
    return {
        startOnLoad: false,
        securityLevel: 'loose', // only for trusted content: allows click handlers and links in diagrams
        theme: 'base',
        flowchart: { padding: 16, diagramPadding: 20 },
        sequence: { diagramMarginX: 20, diagramMarginY: 20 },
        themeVariables: themeVariables(palette), // recipes.md
        themeCSS: themeCSS(palette),             // recipes.md
    }
}

function setSource(node, text) {
    node.removeAttribute('data-processed')
    node.textContent = text
}

// One node per run: run throws once per batch, and only a per-node throw says
// which diagram failed.
async function runOne(mermaid, node) {
    try {
        await mermaid.run({ nodes: [node] })
        return true
    } catch {
        return false
    }
}

function finish(node, canvas, position) {
    const svg = node.querySelector('svg')
    if (!svg) return
    makeRoomForPadding(svg) // text-measurement.md
    chipLabels(svg, canvas) // labels-and-markers.md
    addOpenButton(node, svg, position)
}

// Keyboard path to the viewer (viewer.md). Named for its diagram so a list of
// the page's buttons tells them apart.
function addOpenButton(node, svg, position) {
    if (node.querySelector('.mermaid-open')) return
    const title = svg.querySelector(':scope > title')?.textContent?.trim()
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mermaid-open'
    button.textContent = title ? `Open "${title}" in viewer` : `Open diagram ${position} in viewer`
    node.appendChild(button)
}
```

</example>

The button needs no handler of its own. It sits inside the diagram block, so Enter or Space on it fires a click that bubbles to the viewer's delegated listener, which opens the diagram (`viewer.md`). Mermaid writes the diagram's `accTitle` as the svg's first `<title>`.

Keep the button out of sight until keyboard focus reaches it. Its focused state sets its own color and background, so it reads whatever the block's color is:

<example description="Keyboard button shown only on focus-visible">

```css
pre.mermaid { position: relative; }

.mermaid-open {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}

.mermaid-open:focus-visible {
    width: auto;
    height: auto;
    clip-path: none;
    padding: 4px 10px;
    border: 1px solid currentColor;
    border-radius: 7px;
    background: var(--diagram-canvas);
    color: var(--diagram-text);
}
```

</example>

Mount waits for the font first (`text-measurement.md`), then calls `render`. A theme toggle calls `render` again on every mounted node, which rebuilds `themeVariables` and `themeCSS` from the now-current custom properties. Leave `layout` out of `config()`; ELK is turned on per diagram (`layout.md`).

Scope each mount to its own container's nodes. A page swap must not re-render diagrams belonging to a page that is no longer mounted.

## Loading ELK


This section applies to Mermaid 11. Mermaid 12's full build bundles ELK and already applies it per diagram type, so skip the module and render each source as written. A retry of the plain source gets ELK again on 12; retry a failed diagram with `withLayout(src, 'dagre')` instead (`layout.md`).

<example description="Register the ELK layouts after window load, by URL">

```js
const ELK_PATH = '/vendor/mermaid-layout-elk/mermaid-layout-elk.js'
let pending = null

function afterWindowLoad() {
    if (document.readyState === 'complete') return Promise.resolve()
    return new Promise((resolve) => window.addEventListener('load', () => resolve(), { once: true }))
}

export function registerElkLayouts(mermaid, importModule = (url) => import(url)) {
    pending ??= (async () => {
        // The module's own mermaid copy auto-runs on window "load"; loaded after
        // that event, its listener never fires.
        await afterWindowLoad()
        // Built at runtime so the bundler leaves the import to the browser.
        const url = new URL(ELK_PATH, window.location.origin).href
        try {
            const mod = await importModule(url)
            if (!Array.isArray(mod?.default)) return false
            mermaid.registerLayoutLoaders(mod.default)
            return true
        } catch {
            return false // render without ELK
        }
    })()
    return pending
}
```

</example>

The `importModule` parameter exists so tests can supply the module without a global module mock.

### Bundle it or serve it


If your bundler supports code splitting, `import('@mermaid-js/layout-elk')` and let it split the chunk. If the app loads Mermaid as a plain `<script>` (UMD `mermaid.min.js` on `window.mermaid`), serve ELK as an ES module built with splitting and import it by URL, as above:

<example description="Build ELK as split ES-module chunks">

```sh
npx esbuild@0.28.1 entry.js --bundle --format=esm --splitting --minify \
    --outdir=dist/vendor/mermaid-layout-elk --entry-names=mermaid-layout-elk '--chunk-names=chunk-[hash]'
```

</example>

where `entry.js` is `export { default } from '@mermaid-js/layout-elk'`. Quote the `--chunk-names` value: zsh expands the brackets otherwise. Prefer generating these files in your build from pinned packages over committing them; the lockfile then records the versions.

## Testing against a fake mermaid


Unit tests can stand in a fake `window.mermaid` that records what each `run` saw. Make it behave like the real one where order matters, or the tests pass while the app breaks:

- `detectType` throws until `initialize` has been called.
- `run` sets `data-processed`, replaces each node's text with an svg, and throws after the batch when any node failed.
- A failing ELK render leaves an svg without `aria-roledescription="error"`, so the code under test must rely on the throw.
