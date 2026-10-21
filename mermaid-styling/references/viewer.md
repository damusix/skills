# Click-to-zoom viewer


Wide diagrams are unreadable at column width. Opening the clicked diagram over the page, with zoom and pan, keeps the reader on the page. Browser fullscreen takes over the whole monitor; avoid it.

Behavior to match:

- Click a rendered diagram (or press Enter/Space on its keyboard button) to open it over a blurred backdrop, fitted to the window.
- Scroll, pinch, or `+`/`-` zoom around the cursor or center; drag pans; double-click or `0` refits.
- Esc, the close button, or a click on empty space closes. A click that ended a drag, or landed on the drawing, does not.

## Copy the svg with its id renamed


<example description="Copy the clicked svg for the viewer">

```js
function openDiagram(svg) {
    const viewBox = svg.viewBox?.baseVal
    const width = viewBox?.width || svg.getBoundingClientRect().width
    const height = viewBox?.height || svg.getBoundingClientRect().height
    // Mermaid scopes the diagram's styles and marker url(#…) refs by svg id and
    // cleans up by it on re-render, so a copy that kept the id would be restyled
    // or removed along with the original.
    const markup = svg.id ? svg.outerHTML.split(svg.id).join(`${svg.id}-viewer`) : svg.outerHTML
    show({ markup, width, height })
}
```

</example>

`show` stands for your overlay: it opens the dialog, puts `markup` into the stage element, sets the copy's svg to `width` × `height` pixels with `max-width: none`, and calls `attachViewer` (below) with that size.

`cloneNode` keeps the id; rewriting every occurrence in the serialized markup is what keeps the copy independent. Size the copy from the `viewBox` (its natural size), not from the inline-capped on-page size. Give the copy's svg the same canvas background as the inline diagram, or edge-label chips (filled with the canvas color) show as boxes on the backdrop.

## Open from one delegated listener


<example description="One document-level click listener">

```js
document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const block = event.target.closest('.content pre.mermaid[data-processed="true"]')
    // Links and click-bound nodes keep their own behavior (securityLevel "loose").
    if (!block || event.target.closest('a, .clickable')) return
    const svg = block.querySelector('svg')
    if (svg) openDiagram(svg)
})
```

</example>

One document-level listener covers every page and survives re-renders, which replace the diagram's contents. It also serves the keyboard button (`addOpenButton` in `direct-apps.md`): the button sits inside the block, so its click bubbles here.

## Pan and zoom


<example description="Pan, zoom and close handling for the viewer">

```js
export function attachViewer(viewport, stage, size, close, view) {
    const apply = () => {
        stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`
    }
    const fit = () => {
        view.scale = Math.min((innerWidth * 0.92) / size.width, (innerHeight * 0.92) / size.height)
        view.tx = (innerWidth - size.width * view.scale) / 2
        view.ty = (innerHeight - size.height * view.scale) / 2
        view.placed = true
        apply()
    }
    const zoomAt = (x, y, factor) => {
        const next = Math.min(40, Math.max(0.1, view.scale * factor))
        const k = next / view.scale
        view.tx = x - (x - view.tx) * k
        view.ty = y - (y - view.ty) * k
        view.scale = next
        apply()
    }

    const pointers = new Map()
    let dragDistance = 0
    let pressedOnDrawing = false // pointer capture retargets the click, so read it at press time

    const onWheel = (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002)) }
    const onKey = (e) => {
        if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.2)
        else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2)
        else if (e.key === '0') fit()
        else return
        e.preventDefault()
    }
    const onDown = (e) => {
        if (e.target instanceof Element && e.target.closest('button')) return
        viewport.setPointerCapture(e.pointerId)
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.size === 1) {
            dragDistance = 0
            pressedOnDrawing = e.target instanceof Element && e.target.closest('svg') !== null
        }
    }
    const onMove = (e) => {
        const prev = pointers.get(e.pointerId)
        if (!prev) return
        const cur = { x: e.clientX, y: e.clientY }
        if (pointers.size === 1) {
            view.tx += cur.x - prev.x
            view.ty += cur.y - prev.y
            dragDistance += Math.hypot(cur.x - prev.x, cur.y - prev.y)
            apply()
        } else if (pointers.size === 2) {
            const anchor = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1]
            if (anchor) {
                const before = Math.hypot(prev.x - anchor.x, prev.y - anchor.y)
                const after = Math.hypot(cur.x - anchor.x, cur.y - anchor.y)
                if (before > 0) zoomAt((cur.x + anchor.x) / 2, (cur.y + anchor.y) / 2, after / before)
            }
            dragDistance = Infinity
        }
        pointers.set(e.pointerId, cur)
    }
    const onUp = (e) => pointers.delete(e.pointerId)
    const onClick = (e) => {
        if (dragDistance > 5 || pressedOnDrawing) return
        if (e.target instanceof Element && e.target.closest('button')) return
        close()
    }

    const listeners = [
        ['wheel', onWheel, { passive: false }], ['keydown', onKey], ['pointerdown', onDown],
        ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['dblclick', fit], ['click', onClick],
    ]
    for (const [type, fn, opts] of listeners) viewport.addEventListener(type, fn, opts)
    window.addEventListener('resize', fit)
    if (view.placed) apply()
    else fit()

    return () => {
        for (const [type, fn] of listeners) viewport.removeEventListener(type, fn)
        window.removeEventListener('resize', fit)
    }
}
```

</example>

The `wheel` listener must be non-passive to call `preventDefault`; ctrl+wheel arrives the same way, which is what makes a trackpad pinch zoom.

<constraints>

- **Keep the view state outside the attach call**, one object per opened diagram (`{ scale, tx, ty, placed }`). Dialog components re-attach when their subtree re-renders (a connection indicator flipping is enough); a fresh state would snap a zoomed view back to fit each time.
- **Record where the press started** (`pressedOnDrawing`). With pointer capture the click event targets the viewport, so checking the click's target cannot tell a click on the drawing from one beside it.
- **Give keyboard users a real button per diagram** instead of `role="button"` on the diagram container, which would make the diagram's own links and accessible title presentational. Show it only on `:focus-visible`, and name each one apart, `Open "<accTitle>" in viewer` or else `Open diagram N in viewer`, so a screen reader's button list can tell them apart (`addOpenButton` and its CSS in `direct-apps.md`).
- **Put focus inside the viewer when it opens** (the viewport, not the close button, so no focus ring flashes on a mouse open) and return it to the opener on close.
- **Stack it above every other modal**; a diagram can sit inside other overlays.

</constraints>

In a React app with a dialog primitive (Ark UI, Radix), use the dialog for the backdrop, focus trap, Esc and scroll lock, and attach the pan/zoom through a callback ref: the dialog mounts its content after the open state commits, so an effect keyed on the diagram can run before the viewport exists.
