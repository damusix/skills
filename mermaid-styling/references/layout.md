# Layout: dagre curves and ELK


dagre routes edges as diagonal polylines and draws them with a curve. ELK routes them orthogonally, as horizontal and vertical runs, with rounded corners, and usually untangles dense graphs. Which one you get by default depends on the major version.

| | Mermaid 11 | Mermaid 12 |
|-|-----------|-----------|
| Default `layout` | `dagre` | `elk` for flowchart, state, class, ER, requirement, use case, agentflow; mindmap keeps `cose-bilkent` |
| ELK | Separate package `@mermaid-js/layout-elk` 0.2.x, registered by you | Bundled (`elkjs` is a dependency); the package is only needed with `mermaid.tiny.js` |
| Opt out of ELK | (not on) | `layout: 'dagre'` |

`cose-bilkent` ships in core; `tidy-tree` needs the separate `@mermaid-js/layout-tidy-tree` package (checked on 11.17).

Mermaid 12 also changes default looks: flowchart, sequence, class, ER, state and requirement diagrams default to the `redux-color` theme with the `neo` look. Set `theme: 'base'` and `look: 'classic'` explicitly to keep the styling in this skill predictable across versions.

Most of this file is about Mermaid 11, where ELK is opt-in, heavy, and breaks some diagram types if turned on globally. Tools pinned to Mermaid 11 (vitepress-plugin-mermaid 2.x, GitLab's default path) are where it applies.

## dagre edge curves


`flowchart: { curve: '<name>' }` picks how dagre's polyline is drawn.

| Curve | Result |
|-------|--------|
| `basis` (default) | Smooth curves. Reads well on dense graphs because edges never share a straight run. |
| `step`, `stepBefore`, `stepAfter` | Right angles drawn over dagre's diagonal points. Looks orthogonal on simple graphs; on dense ones, edges share the same corridors and gain small zig-zags near nodes. |
| `linear` | Straight segments between dagre's points. |
| `rounded` | Only rounds the corners of whatever points the layout produced. With dagre those are diagonal, so you get rounded diagonals, not right angles. ELK and the swimlane layout feed it orthogonal points. Missing from the flowchart docs, present in the config schema. |
| `bumpX`, `bumpY`, `cardinal`, `catmullRom`, `monotoneX`, `monotoneY`, `natural` | Other d3 curves through dagre's points. |

State diagrams follow `flowchart.curve` as well. From 11.10 a single edge can override it: `A e1@--> B` then `e1@{ curve: linear }`.

## ELK on Mermaid 11


### Install


| mermaid | `@mermaid-js/layout-elk` |
|---------|--------------------------|
| 11.x | `0.1.9`–`0.2.x` (peer dependency `mermaid ^11`) |
| 12.x | `1.x`, only for `mermaid.tiny.js`; the full build bundles ELK |

Pin mermaid to the version the ELK package was built against (`0.2.3` bundles 11.17.0 internals). The package carries its own copy of Mermaid's internals, so mismatched versions mix two Mermaids at render time.

<example description="Register the ELK layouts with a bundler">

```js
import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'

mermaid.registerLayoutLoaders(elkLayouts)
```

</example>

Mermaid's ELK integration switches an edge's curve to `rounded` when the edge has no curve set or uses the default `basis`, which is where the rounded right angles come from. Another `flowchart.curve` value (`step`, `linear`) is kept under ELK too.

### Size


The package's render chunk contains a full second Mermaid, every diagram type's lazy chunk included. With a bundler that splits code (Vite, esbuild `--splitting`), a page fetches about 1.5 MB; bundled without splitting it is about 4.8 MB. On disk the split build is about 5 MB, which matters if you embed assets in a binary.

<constraints>

### Load order: the second Mermaid's auto-run


That bundled copy registers its own `window` `load` listener with `startOnLoad: true`, and you cannot configure it. If its module is evaluated before the page's `load` event fires (a cached page load often does this), it runs its own `mermaid.run()` over every `.mermaid` element that lacks `data-processed`:

- **A container holding an SVG that `run` did not draw** (vitepress-plugin-mermaid writes `render` output into the element, so nothing marks it processed): the copy parses the SVG's text as diagram source and replaces the diagram with "Syntax error in text". The plugin names its svgs `mermaid-<n>`, so a broken svg with a timestamp-style id (`mermaid-1792…`) came from the copy.
- **A container still holding source** (an app that has not rendered it yet): the copy renders it with its own default config, alongside your render.

Diagrams your own `mermaid.run` already drew carry `data-processed` and are skipped. `run` names every svg with the timestamp-style id too, so in a `run`-based app the id tells you nothing; check for `aria-roledescription="error"`.

Fixes, either is enough:

- Import the ELK module only after `document.readyState === 'complete'`; a listener added after `load` has fired never runs.
- Keep your diagram containers off the `.mermaid` class (vitepress-plugin-mermaid: `mermaidPlugin: { class: 'my-mermaid' }`).

### Which types ELK breaks


Measured on 11.17 with layout-elk 0.2.3:

| Diagram | Under global `layout: 'elk'` | Under global `layout: 'dagre'` |
|---------|------------------------------|--------------------------------|
| flowchart, state, class, ER, requirement | Orthogonal, rounded edges | Normal |
| mindmap | Throws (`Cannot read properties of null`) | Loses its radial layout and becomes a layered tree |
| state diagram with a note on a composite state | Throws (`nt[l] is not a function`), can leave a half-drawn SVG with no error marker | Normal |
| sequence, gantt, pie, and others | Ignore `layout` | Ignore `layout` |

So on Mermaid 11 a global `layout` key is wrong either way: set none, and turn ELK on per diagram. On Mermaid 12, leave `layout` unset and let the per-type defaults apply. The plain source gets ELK again there, so a retry has to force dagre: render `withLayout(src, 'dagre')` after a failure. Whether 12's bundled ELK still throws on a note attached to a composite state is untested here.

</constraints>

### Per-diagram ELK


Detect each diagram's type, add an init directive only for types ELK handles, and fall back to the plain source if the ELK render throws.

<examples>

<example description="Which types get ELK, and where the directive goes">

```js
// detectType ids that ELK lays out well.
const ELK_TYPES = new Set([
    'flowchart-v2', 'flowchart', 'flowchart-elk',
    'stateDiagram', 'state', 'classDiagram', 'class', 'er', 'requirement',
])

const FRONTMATTER = /^\s*---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/
const LAYOUT_KEY = /^\s+layout\s*:/m

export function usesElk(type) {
    return type !== null && ELK_TYPES.has(type)
}

// After any frontmatter (ahead of it, the frontmatter no longer parses), and not
// at all when the frontmatter already picks a layout: a directive overrides it.
export function withLayout(src, layout) {
    const frontmatter = FRONTMATTER.exec(src)?.[0] ?? ''
    if (LAYOUT_KEY.test(frontmatter)) return src
    return `${frontmatter}%%{init: {"layout": "${layout}"}}%%\n${src.slice(frontmatter.length)}`
}

export const withElk = (src) => withLayout(src, 'elk')
```

</example>

<example description="Render loop for an app that calls mermaid.run (direct-apps.md has the surrounding code)">

```js
mermaid.initialize(config) // before detectType: initialize registers the detectors

for (const node of nodes) {
    const src = node.dataset.mermaidSrc
    let type = null
    try { type = mermaid.detectType(src) } catch {}
    const elk = elkReady && usesElk(type)

    node.removeAttribute('data-processed')
    node.textContent = elk ? withElk(src) : src
    let ok = await runOne(node)
    if (!ok && elk) {
        node.removeAttribute('data-processed')
        node.textContent = src
        ok = await runOne(node)
    }
}

// One node per run: run throws once per batch, and only a per-node throw says
// which diagram failed.
async function runOne(node) {
    try {
        await mermaid.run({ nodes: [node] })
        return true
    } catch {
        return false
    }
}
```

</example>

</examples>

With a plugin that calls `mermaid.render` for you, wrap `render` instead; see `vitepress.md`.

<constraints>

- **Call `initialize` before `detectType`.** Before the first `initialize`, no detectors are registered and every call throws as an unknown diagram, so every diagram silently loses ELK on a cold page load while theme-toggle re-renders work.
- **Use `node.textContent`, not `innerHTML`, to put source back.** Source contains `<br/>` and `-->`; as HTML they become elements or comment tokens.
- **Detect the type from the original source**, not the directive-prefixed text.

</constraints>

## Diagram authoring for layout


- Long labels on parallel edges between the same two nodes stack on top of each other under dagre. Keep edge labels to a few words and move detail into the surrounding prose or `accDescr`.
- A branch reads best top-to-bottom; a long linear chain reads best left-to-right. ELK keeps labels on their own edges in both directions, so you rarely need `direction LR` just to unstack labels once ELK is on.
- Self-loops and edges returning to the same node crowd under dagre; ELK separates them.
