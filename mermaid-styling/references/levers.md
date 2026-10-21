# Styling options: themeVariables, themeCSS, page CSS


Three places can style a Mermaid diagram, and each reaches a different part of it. Most styling bugs come from putting a rule where it cannot reach, or where something else outranks it.

## themeVariables


Colors and font values Mermaid reads while it draws. Set `theme: 'base'`: the docs call it "the only theme that can be modified". The other themes do apply your overrides, but they recompute their derived shades in between, so the result is harder to predict. Where a tool forces another theme (vitepress-plugin-mermaid forces `dark`), your variables still apply on top of it.

Mermaid 12 gives several diagram types new defaults (`redux-color` theme, `neo` look). Set `theme` and `look: 'classic'` explicitly so a version bump does not restyle your diagrams.

Each `mermaid.initialize()` call replaces the config with the defaults plus what you pass; it does not merge with an earlier call. Pass the whole config every time.

Mermaid keeps a separate variable family per diagram type, and any family you leave unset falls back on its own. The indexed families (`pie1`–`pie12`, `git0`–`git7`, `cScale0`–`cScale11`) derive from `primaryColor`, so leaving them unset paints every slice and branch the same tone. Name each family you use.

| Family | Variables worth setting |
|--------|-------------------------|
| General | `background`, `fontFamily`, `fontSize`, `primaryColor`, `primaryTextColor`, `primaryBorderColor`, `mainBkg`, `nodeBorder`, `nodeTextColor`, `lineColor`, `textColor`, `titleColor`, `clusterBkg`, `clusterBorder`, `edgeLabelBackground`, `secondaryColor`, `tertiaryColor` |
| Sequence | `actorBkg`, `actorBorder`, `actorTextColor`, `actorLineColor`, `signalColor`, `signalTextColor`, `labelBoxBkgColor`, `labelBoxBorderColor`, `labelTextColor`, `loopTextColor`, `noteBkgColor`, `noteBorderColor`, `noteTextColor`, `activationBkgColor`, `activationBorderColor`, `sequenceNumberColor` |
| State | `transitionColor`, `transitionLabelColor`, `stateLabelColor`, `labelBackgroundColor`, `specialStateColor` (start/end dots) |
| Gantt | `sectionBkgColor`, `altSectionBkgColor`, `sectionBkgColor2`, `gridColor`, `taskBkgColor`, `taskBorderColor`, `taskTextColor`, `taskTextOutsideColor`, `activeTaskBkgColor`, `doneTaskBkgColor`, `critBkgColor`, `todayLineColor` |
| Pie / quadrant | `pie1`–`pie12`, `pieTitleTextColor`, `pieSectionTextColor`, `pieStrokeColor`, `quadrant1Fill`–`quadrant4Fill`, `quadrantPointFill` |
| Git | `git0`–`git7`, `gitBranchLabel0`–`gitBranchLabel7`, `commitLabelColor`, `tagLabelColor` |
| Mindmap and others | `cScale0`–`cScale11`, `cScaleLabel0`–`cScaleLabel11` |
| xychart, radar | Nested objects: `xyChart: { backgroundColor, plotColorPalette, ... }`, `radar: { axisColor, graticuleColor, ... }` |

Variable values must be literal colors. Mermaid computes derived shades from them, so `var(--brand)` does not work; read the custom property with `getComputedStyle` and pass the resolved value.

<constraints>

- **ER attribute rows ignore `attributeBackgroundColorOdd/Even`** in the unified renderer (11.5+; checked on 11.15–11.17). Their fills derive from `background` by lightness, which in dark mode can put black text on near-black rows. Set them in `themeCSS` (`.row-rect-odd > path`, `.row-rect-even > path`).
- **`.loopLine` (alt/opt/loop frame borders) takes its stroke from `labelBoxBorderColor`.** If that is black for the frame tab, dark-mode frames go invisible; give `.loopLine` its own stroke in `themeCSS`.
- **`fontFamily` set at the top level is copied into `themeVariables`**; setting both is redundant.

</constraints>

## themeCSS


A CSS string Mermaid injects into each diagram's own `<style>`, with every rule prefixed by `#<svg-id>`. That id prefix gives every rule id-level specificity, so it beats any class rule in your page stylesheet without `!important`. It also means `themeCSS` is the one place that can override Mermaid's own id-scoped defaults, for example `#id .edgeLabel rect { opacity: 0.5 }`.

It cannot style the `<svg>` element itself for anything beyond `font-family`, `font-size` and `fill`: a block holding only those three keeps `&` as `#id`, and any other declaration turns it into `#id #id`, a descendant selector that matches nothing. Put the svg's background, padding, radius and overflow in page CSS.

Because it is a plain string, build it with a function so theme colors can be interpolated, and rebuild it on every theme change.

## Page CSS


Reaches the svg element and its container, and anything inside the svg that has no id-scoped rule. Use it for the canvas (`background`, `padding`, `border-radius`, `overflow: visible` for shadows), the cursor, and resets for host styles that leak into labels (see `text-measurement.md`).

Mermaid does set some fills as presentation attributes (the ER rows, for one); any CSS rule outranks a presentation attribute, so those can be overridden from page CSS too.

## Labels: HTML or SVG text


`htmlLabels` (default `true`) renders node and edge labels as HTML inside a `<foreignObject>`; `false` renders SVG `<text>`. Class diagrams default to `false`. The line-height and font traps in `text-measurement.md` apply to HTML labels; the chip technique in `labels-and-markers.md` covers the `<text>` labels sequence diagrams always use. `flowchart.htmlLabels` is deprecated since 11.12.3 in favor of the top-level key.

## Look


`look` is `classic` (default in 11), `handDrawn`, or `neo`. In 11 it applies to flowchart and state diagrams; 12 extends it to class, ER, requirement, use case and agentflow and makes `neo` the default for several types. Under `neo` with `theme: 'base'`, node strokes use a gradient unless you set `nodeBorder`. The recipes in this skill assume `classic`.

## Class map


Classes seen on rendered SVGs in mermaid 11.15–11.17. Inspect a live render when targeting a type not listed here.

| Element | Selector |
|---------|----------|
| Node outline | `.node rect`, `.node polygon` (rhombus), `.node path` (shapes drawn as paths: cylinder, stadium, class and ER boxes), `.node circle` |
| Node label | `.nodeLabel` (HTML span), wrapped in `<foreignObject>` and often a `<p>` |
| Subgraph | `.cluster rect`, `.cluster-label` |
| Flowchart edge | `.flowchart-link`, `path.edge-pattern-dotted` for dotted edges |
| Class / ER / requirement edge | `.edgePath > path` |
| Edge label | `g.edgeLabel` holding a `foreignObject` and `.labelBkg` div |
| Arrowheads | `marker[id$="-pointEnd"]`, `marker[id$="-pointStart"]`, path `.arrowMarkerPath` |
| State | `.transition` (edges), `.state-start` (start dot), `g.statediagram-state` |
| Sequence | `rect.actor` (`.actor-top`, `.actor-bottom`), `.actor-line`, `.messageLine0` / `.messageLine1`, `text.messageText`, `.loopLine`, `text.loopText` (block condition), `text.sectionTitle` (an else branch's condition), `.labelBox` / `.labelText` (the alt/opt tab), `rect.note`, `.activation0` |
| ER rows | `g.row-rect-odd > path`, `g.row-rect-even > path` |
| Class member dividers | `.divider` |
| Mindmap | `g.mindmap-node` |
| Error diagram | `svg[aria-roledescription="error"]` |

A selector that reaches every node outline without touching the start dot, ER rows or class dividers:

<example description="Selector for every node outline">

```js
const NODE_SHAPE =
    ':is(rect, polygon, path, circle):not(.state-start):not(:is(.row-rect-odd, .row-rect-even, .divider) *)'
```

</example>

User `style` and `classDef` declarations still win over a fill cycle built on this selector.
