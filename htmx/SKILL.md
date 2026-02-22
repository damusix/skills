---
name: htmx
description: "Use when tasks involve hx-* attributes, HTMX AJAX requests, swap strategies, server-sent events, WebSockets, or hypermedia-driven UIs."
---

# HTMX


Use this skill for HTMX implementation and integration. Read only the reference file(s) needed for the task.

## Quick Start

1. Identify the domain of the task (attributes, requests, swapping, events, patterns).
2. Open the matching file from `references/`.
3. Implement using HTML-first, hypermedia-driven patterns.
4. Validate that server responses return HTML fragments, not JSON.

## Critical Rules

1. **HTML responses** - HTMX expects HTML responses from the server, not JSON
2. **Attribute inheritance** - Most attributes inherit to children. **Not inherited:** `hx-trigger`, `hx-on*`, `hx-swap-oob`, `hx-preserve`, `hx-history-elt`, `hx-validate`. Use `hx-disinherit` or `unset` to stop inheritance
3. **Default swap is innerHTML** - Always confirm the intended swap method
4. **Form values auto-included** - Non-GET requests automatically include the closest enclosing form's values
5. **Progressive enhancement** - Use `hx-boost="true"` — pages must work without JS
6. **Escape user content** - Escape all user-supplied content server-side to prevent XSS
7. **CSS lifecycle classes** - HTMX adds/removes CSS classes during requests — use for transitions and indicators
8. **data-prefix supported** - All `hx-*` attributes can also be written as `data-hx-*` for HTML validation compliance

## Reference Map

- All `hx-*` attributes, values, and modifiers: `references/attributes.md`
- Triggers, headers, parameters, CSRF, caching, CORS: `references/requests.md`
- Swap methods, targets, OOB swaps, morphing, view transitions: `references/swapping.md`
- Events, JS API, configuration, extensions, debugging: `references/events-api.md`
- Common UI patterns and examples: `references/patterns.md`
- Official extensions (WS, SSE, Idiomorph, response-targets, head-support, preload): `references/extensions.md`
- Gotchas, pitfalls, and practical guidance: `references/gotchas.md`
- Cross-file index and routing: `references/REFERENCE.md`

## Task Routing

- Adding HTMX behavior to elements -> `references/attributes.md`
- Configuring how/when requests fire -> `references/requests.md`
- Controlling where/how responses render -> `references/swapping.md`
- Handling events, JS interop, or config -> `references/events-api.md`
- Building common UI patterns (search, infinite scroll, modals, etc.) -> `references/patterns.md`
- Using WebSockets, SSE, morphing, preloading, response targeting, or head merging -> `references/extensions.md`
- Avoiding common pitfalls, accessibility, error handling, architecture decisions -> `references/gotchas.md`
- Cross-cutting concerns or architecture -> `references/REFERENCE.md` then domain-specific files
