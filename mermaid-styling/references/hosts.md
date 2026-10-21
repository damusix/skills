# Markdown hosts and doc frameworks


On a hosted Markdown renderer you usually cannot add page CSS or run code around the render, so per-diagram config is the only option, and the host decides the Mermaid version and theme. Doc frameworks expose more. Check the version first: on GitHub and GitLab, a mermaid block containing just `info` prints it.

## Per-diagram config and its sanitizer


Frontmatter is the supported per-diagram form (Mermaid 10.5+); `%%{init: ...}%%` directives are deprecated but still honored in 11 and 12.

<example description="Per-diagram frontmatter config">

```
---
config:
    theme: base
    themeVariables:
        primaryColor: "#ff6b6b"
        lineColor: "#8c7e70"
        fontSize: 16px
    look: classic
---
flowchart TD
    A --> B
```

</example>

Mermaid sanitizes this config before applying it. These rules decide what survives:

<constraints>

- **`themeVariables` values must match `^[\d "#%(),.;A-Za-z]+$`.** Anything else becomes empty. A hyphen fails it, so `sans-serif`, `ui-sans-serif` and `var(--x)` are lost; quote font names without hyphens, or skip the font.
- **Any string value containing `<`, `>` or `url(data:` is deleted.** That includes `themeCSS`: one `>` child combinator drops the whole string. Write descendant selectors only (`.row-rect-odd path`, not `.row-rect-odd > path`).
- **Unbalanced braces in CSS** replace the value with an error comment.
- **The `secure` keys never apply from a diagram:** `secure`, `securityLevel`, `startOnLoad`, `maxTextSize`, `suppressErrorRendering`, `maxEdges`, plus anything a host adds to that list. Keys starting with `__` or containing `proto`/`constr`, and unknown keys, are dropped too.

</constraints>

## GitHub


Fenced ` ```mermaid ` blocks render client-side in an iframe served by GitHub's Viewscreen service, so page CSS never reaches them. GitHub documents the block syntax and the `info` version check; it does not document whether frontmatter config, `themeVariables`, `themeCSS`, or automatic light/dark switching are honored. Test on a scratch file before relying on any of them, and expect readers in both light and dark mode.

## GitLab


- Mermaid 11 (source pins 11.16.1); Mermaid 12 sits behind the `useMermaidV12` feature flag.
- Renders in a sandboxed iframe (`sandbox="allow-scripts"`); page CSS cannot reach it.
- Picks the theme from the reader's mode: `neutral` in light, `dark` in dark.
- Adds `htmlLabels` to the `secure` list, so a diagram cannot change it.
- The Mermaid 11 path registers `@mermaid-js/layout-elk` 0.2.2. Frontmatter `layout: elk` is likely honored there; GitLab does not document it, so test it.
- The v12 path defaults to `look: classic` and dagre.

## Obsidian


Renders ` ```mermaid ` blocks and supports the `internal-link` class on nodes for vault links. The plugin API exposes `loadMermaid()`, which returns the global mermaid object, so a plugin can call `initialize` or register layouts. Obsidian does not document the bundled version, frontmatter handling, or whether CSS snippets reach the rendered SVG; check in the app's developer tools.

## Docusaurus (`@docusaurus/theme-mermaid`)


<example description="Docusaurus Mermaid theme config">

```js
themeConfig: {
    mermaid: {
        theme: { light: 'base', dark: 'base' },
        options: { themeVariables: { /* ... */ }, themeCSS: '/* ... */' },
    },
}
```

</example>

- `options` goes to `mermaid.initialize`; `theme` overrides `options.theme` and follows the color mode. Docusaurus re-initializes on every render, so the config is never partially merged.
- ELK: install `@mermaid-js/layout-elk` and the theme registers it automatically. In 3.10.x the theme depends on `mermaid >=11.6.0`, so a fresh install pulls Mermaid 12 while layout-elk's optional peer is `^0.1.9` (Mermaid 11). Pin `mermaid@11` with layout-elk `0.2.x`, or drop layout-elk on Mermaid 12, which bundles ELK.
- Page CSS works here: diagrams render into the page, so the canvas, line-height and padding rules from `text-measurement.md` apply.

## MkDocs Material


- Diagrams "automatically use fonts and colors defined in mkdocs.yml", but only flowchart, sequence, class, state and ER diagrams are themed.
- Material passes its own `themeCSS` built on `--md-mermaid-*` custom properties (defined on `:root > *`). Override those properties to recolor diagrams.
- It renders each SVG into a closed shadow root, so ordinary page CSS cannot reach inside the diagram. Only the custom properties cross that boundary.
- It loads `mermaid@11` from unpkg unless `window.mermaid` already exists. To change config or add ELK, ship a custom JS file that loads Mermaid, configures it, and assigns `window.mermaid` before Material's script runs. Material calls `initialize` again afterwards, which resets config; check that your keys survive.

## VitePress


See `vitepress.md`. `vitepress-plugin-mermaid` 2.0.x supports Mermaid 10 and 11 only (peer `mermaid "10 || 11"`).
