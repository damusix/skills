# Recipes


## A bold theme: bright fills, black borders, soft shadows


Bright cycled node fills, 3px black borders, soft dark drop shadows, muted connectors, and a dotted canvas. It holds up on dense diagrams because every node reads as a separate object. Light mode puts it on a cream card; dark mode puts it on the page background.

The theme-dependent colors live in CSS custom properties, so a theme toggle only has to re-render. The node fills and their ink stay the same in both themes.

<examples>

<example description="Palette as CSS custom properties, light and dark">

```css
:root {
    --diagram-canvas: #fff6e5;
    --diagram-dot: #f4b6b6;
    --diagram-line: #000000;
    --diagram-label: #000000;
    --diagram-shadow: rgba(0, 0, 0, 0.35);
    --diagram-text: #211d18; /* the page's text color */
}

:root.dark {
    --diagram-canvas: #141210; /* the page background */
    --diagram-dot: #3a2e26;
    --diagram-line: #8c7e70;
    --diagram-label: #b8a888;
    --diagram-shadow: rgba(0, 0, 0, 0.85);
    --diagram-text: #f1ead9;
}
```

</example>

<example description="themeVariables and themeCSS built from the palette">

```js
const FILLS = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#1dd1a1']
const INK = '#000000' // labels and borders on the bright fills, both themes

const NODE_SHAPE =
    ':is(rect, polygon, path, circle):not(.state-start):not(:is(.row-rect-odd, .row-rect-even, .divider) *)'

function themeVariables({ canvas, line, label, text }) {
    return {
        fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif',
        fontSize: '15px',
        background: canvas,
        primaryColor: FILLS[0], mainBkg: FILLS[0], primaryTextColor: INK, primaryBorderColor: INK,
        nodeBorder: INK, nodeTextColor: INK, lineColor: line, textColor: text,
        clusterBkg: canvas, clusterBorder: INK, edgeLabelBackground: canvas,
        actorBkg: FILLS[1], actorBorder: INK, actorTextColor: INK, actorLineColor: line,
        signalColor: line, signalTextColor: text,
        labelBoxBkgColor: FILLS[0], labelBoxBorderColor: INK, labelTextColor: INK, loopTextColor: text,
        noteBkgColor: FILLS[2], noteBorderColor: INK, noteTextColor: INK,
        activationBkgColor: FILLS[3], activationBorderColor: INK,
        transitionColor: line, transitionLabelColor: label, stateLabelColor: INK,
        labelBackgroundColor: canvas, specialStateColor: FILLS[0],
    }
}

function themeCSS({ line, label, shadow }) {
    const cycle = FILLS.map((fill, i) =>
        `.node:nth-child(${FILLS.length}n+${i + 1}) ${NODE_SHAPE} { fill: ${fill}; }`).join('\n')
    return `
        .node ${NODE_SHAPE}, rect.actor, rect.note, .cluster rect, .labelBox {
            stroke-width: 3px;
            rx: 8px;
            ry: 8px;
            filter: drop-shadow(3px 5px 8px ${shadow});
        }
        ${cycle}
        .nodeLabel { font-weight: 600; color: ${INK}; }
        div.journey-section .label, div.task .label { color: ${INK}; }
        .state-start { stroke: ${INK} !important; stroke-width: 3px; filter: drop-shadow(2px 3px 5px ${shadow}); }
        .flowchart-link, .edgePath > path, .transition, .messageLine0, .messageLine1 { stroke-width: 2.5px; }
        .row-rect-odd > path { fill: #ffffff; }
        .row-rect-even > path { fill: #f3efe6; }
        .actor-line { stroke-width: 2px; stroke-dasharray: 6 4; }
        .loopLine { stroke: ${line}; stroke-width: 2px; }
        .edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; color: ${label}; font-weight: 600; }
    `
}
```

</example>

</examples>

Read the palette with `getComputedStyle` before each render (`readPalette` in `direct-apps.md`). Where the config is static, as in the VitePress plugin, pass the literal values for the one theme the site uses. Add the arrowhead rules from `labels-and-markers.md` to `themeCSS`, and run `chipLabels` after each render.

The canvas goes in page CSS, on the svg:

<example description="Canvas on the svg in page CSS">

```css
.diagram svg {
    padding: 12px;
    border-radius: 10px;
    background-color: var(--diagram-canvas);
    background-image: radial-gradient(var(--diagram-dot) 1px, transparent 1px);
    background-size: 18px 18px;
    overflow: visible; /* shadows paint into the padding instead of being cut at the viewBox */
}
```

</example>

Then widen the svg's inline `max-width` by the padding after render (see `text-measurement.md`).

<constraints>

### Palette rules


- **Dark-mode connectors are a muted mid-tone.** Cream or near-white lines on a dark canvas are the brightest thing in the diagram; they compete with the nodes and read as out of place. `#8c7e70` lines with `#b8a888` labels keep the nodes the most prominent shapes.
- **Shadows are dark in both themes.** Light shadows on a dark page look like glow artifacts, not depth. On dark backgrounds raise the shadow's alpha (0.85) rather than lightening it.
- **Shadows are soft.** A hard offset shadow (`4px 4px 0 #000`) reads as dense and heavy at diagram scale; a blur (`3px 5px 8px`) keeps the depth without the weight.
- **Bright fills take black labels.** Every fill above clears contrast against `#000` in both themes; white labels on yellow or cyan do not.
- **ER rows stay light in both themes** when labels are black; Mermaid's derived row fills go near-black in dark mode.
- **Keep the canvas color in one place** (a CSS custom property read with `getComputedStyle`) and pass it to `themeVariables`, the label chips and the edge-label background, so they cannot drift apart.

</constraints>

## A quieter alternative: outlined nodes


Transparent tinted fills with a 1.5px accent outline, on a dotted canvas. It reads as a technical drawing rather than a poster; on dense diagrams it can feel flat next to the bold theme.

<example description="Outlined theme with a teal accent">

```js
function outlined(accent, fill, ink, canvas, line) {
    return {
        themeVariables: {
            primaryColor: fill, mainBkg: fill, primaryBorderColor: accent, nodeBorder: accent,
            primaryTextColor: ink, lineColor: line, textColor: ink,
            clusterBkg: 'transparent', clusterBorder: accent, edgeLabelBackground: canvas,
            actorBkg: fill, actorBorder: accent, actorTextColor: ink, noteBkgColor: fill, noteBorderColor: accent,
        },
        themeCSS: `
            .node rect, .node polygon, rect.actor, rect.note { stroke-width: 1.5px; rx: 4px; ry: 4px; }
            .cluster rect { fill: ${fill}; stroke-width: 1px; rx: 6px; ry: 6px; }
            .flowchart-link, .transition, .messageLine0, .messageLine1 { stroke-width: 1.5px; }
        `,
    }
}

const teal = outlined('#2dd4bf', 'rgba(45, 212, 191, 0.10)', '#e6fffa', '#0b1014', '#e5e7eb')
```

</example>
