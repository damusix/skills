# Labels and arrowheads


## Label chips


Lines, frame borders and sequence activation bars cross labels, and Mermaid paints some of them after the text. A sequence diagram's activation bar runs straight through a self-message label like "commit". The fix is a solid chip in the canvas color behind each label, moved above everything else in the drawing.

SVG `<text>` takes no CSS background or padding, so the chip is a `<rect>` sized from the label's bounding box. The chip and label then move into a layer appended at the end of the svg, so nothing paints over them. Each moved element keeps its position by carrying the transform of the container it left.

<example description="Chip labels and lift them above the drawing">

```js
const SVG_NS = 'http://www.w3.org/2000/svg'
const CHIP_PAD = 3

// Sequence message text and block conditions (sectionTitle is an else branch's,
// or a gantt section's), and flowchart/state edge labels.
const LABELS = 'text.messageText, text.loopText, text.sectionTitle, g.edgeLabel'

function chipFor(box, fill) {
    const chip = document.createElementNS(SVG_NS, 'rect')
    chip.setAttribute('class', 'label-chip')
    chip.setAttribute('x', String(box.x - CHIP_PAD))
    chip.setAttribute('y', String(box.y - CHIP_PAD))
    chip.setAttribute('width', String(box.width + CHIP_PAD * 2))
    chip.setAttribute('height', String(box.height + CHIP_PAD * 2))
    chip.setAttribute('rx', String(CHIP_PAD))
    chip.setAttribute('fill', fill)
    // Slightly see-through, so a line under the label still reads as passing under it.
    // Inline: mermaid's id-scoped `.edgeLabel rect { opacity: 0.5 }` beats class rules.
    chip.style.opacity = '0.9'
    return chip
}

// A <text> gets a <g> holding chip + text; a <g> label takes the chip as its first child.
function withChip(label, chip) {
    if (!(label instanceof SVGTextElement)) {
        label.prepend(chip)
        return label
    }
    const transform = label.getAttribute('transform')
    if (transform) chip.setAttribute('transform', transform)
    const pair = document.createElementNS(SVG_NS, 'g')
    label.replaceWith(pair)
    pair.append(chip, label)
    return pair
}

export function chipLabels(svg, fill) {
    const svgCTM = svg.getScreenCTM()
    const layer = document.createElementNS(SVG_NS, 'g')
    layer.setAttribute('class', 'label-chips')

    for (const label of svg.querySelectorAll(LABELS)) {
        const box = label.getBBox()
        if (box.width === 0 || box.height === 0) continue // unlabeled edges
        const parent = label.parentElement
        const parentCTM = parent instanceof SVGGraphicsElement ? parent.getScreenCTM() : null
        const chipped = withChip(label, chipFor(box, fill))
        if (!svgCTM || !parentCTM) continue

        const m = svgCTM.inverse().multiply(parentCTM)
        const wrapper = document.createElementNS(SVG_NS, 'g')
        wrapper.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`)
        wrapper.append(chipped)
        layer.append(wrapper)
    }

    if (layer.childElementCount > 0) svg.append(layer)
}
```

</example>

Run it after each render, with the canvas color as `fill`. It needs a laid-out svg (in the document, not `display: none`): `getBBox` and `getScreenCTM` return zeros or null otherwise, and the function then leaves labels in place.

<constraints>

- **Make the HTML edge-label background transparent** in `themeCSS` (`.edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; }`). Otherwise an opaque box sits under the chip and hides the see-through effect.
- **Run it once per svg.** A re-render produces a fresh svg; mark processed svgs (`data-label-chips`) when an observer could see the same svg twice.
- **Opacity 0.9, not 1.** A fully opaque chip hides what passes under the label, so the label no longer reads as sitting above a line; 0.9 keeps the word legible and the line faintly visible.

</constraints>

## Arrowheads


Mermaid's flowchart arrowhead is an 8px marker centered on the line's end, so half of it sits under the node border. With 3px borders it all but disappears. Scale the marker's path from its tip and let the marker paint outside its box:

<example description="Larger arrowheads scaled from the tip">

```css
marker:is([id$="-pointEnd"], [id$="-pointStart"]) { overflow: visible; }
marker[id$="-pointEnd"] .arrowMarkerPath { transform-origin: 10px 5px; transform: translateX(-1px) scale(1.6); }
marker[id$="-pointStart"] .arrowMarkerPath { transform-origin: 0 5px; transform: translateX(1px) scale(1.6); }
```

</example>

This goes in `themeCSS`. Scale both ends: a rule on `pointEnd` alone leaves `<-->` edges with mismatched heads. ELK pulls edge ends back from node borders more than dagre does, so check the `translateX` against your layout.
