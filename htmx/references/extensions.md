---
description: Official HTMX extensions — WebSockets, SSE, Idiomorph, response targets, head support, and preload.
globs: "*.html"
---

# HTMX Extensions


Official extensions that add functionality beyond core HTMX. Each extension is enabled via `hx-ext="<name>"` and inherits to child elements.

## Contents

- Installation
- WebSockets (`ws`)
- Server-Sent Events (`sse`)
- Idiomorph / DOM Morphing (`morph`)
- Response Targets (`response-targets`)
- Head Support (`head-support`)
- Preload (`preload`)

## Installation

Extensions are separate packages loaded after the core htmx library. Enable them with `hx-ext="<name>"` on an ancestor element (typically `<body>`).

### CDN

```html
<head>
    <!-- Core htmx (always first) -->
    <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"></script>

    <!-- Then the extension(s) you need -->
    <script src="https://cdn.jsdelivr.net/npm/htmx-ext-ws@2.0.4"></script>
    <script src="https://cdn.jsdelivr.net/npm/htmx-ext-sse@2.2.4"></script>
    <script src="https://cdn.jsdelivr.net/npm/htmx-ext-response-targets@2.0.4"></script>
    <script src="https://cdn.jsdelivr.net/npm/htmx-ext-head-support@2.0.5"></script>
    <script src="https://cdn.jsdelivr.net/npm/htmx-ext-preload@2.1.2"></script>
</head>
<body hx-ext="ws, sse, preload">
```

Idiomorph uses a different package:

```html
<script src="https://unpkg.com/idiomorph@0.7.4/dist/idiomorph-ext.min.js"></script>
```

### npm

| Extension | Package | Import |
|---|---|---|
| WebSockets | `htmx-ext-ws` | `import "htmx-ext-ws"` |
| SSE | `htmx-ext-sse` | `import "htmx-ext-sse"` |
| Response Targets | `htmx-ext-response-targets` | `import "htmx-ext-response-targets"` |
| Head Support | `htmx-ext-head-support` | `import "htmx-ext-head-support"` |
| Preload | `htmx-ext-preload` | `import "htmx-ext-preload"` |
| Idiomorph | `idiomorph` | `import "idiomorph/htmx"` |

Always import `htmx.org` before any extension.

---

## WebSockets (`ws`)

Bi-directional communication with WebSocket servers directly from HTML. Extension name: `ws`.

### Attributes

| Attribute | Description |
|---|---|
| `ws-connect="<url>"` | Establish a WebSocket connection. Optional prefixes: `ws:` or `wss:`. Without a prefix, HTMX uses the page's scheme, host, and port (so cookies are sent). |
| `ws-send` | On the triggering event (natural or via `hx-trigger`), serialize the nearest enclosing form as JSON and send it to the nearest ancestor WebSocket. |

### Receiving Messages

Server messages are parsed as HTML and swapped by `id` using out-of-band swap logic (`hx-swap-oob`). The server controls the swap method per-fragment:

```html
<!-- Default: replaces element with matching id -->
<div id="chat_room">...</div>

<!-- Append to element -->
<div id="notifications" hx-swap-oob="beforeend">New message</div>

<!-- Morph via extension -->
<div id="chat_room" hx-swap-oob="morphdom">...</div>
```

### Sending Messages

Forms with `ws-send` serialize their values as JSON including a `HEADERS` field with standard HTMX request headers.

```html
<div hx-ext="ws" ws-connect="/chatroom">
    <div id="notifications"></div>
    <form id="form" ws-send>
        <input name="chat_message">
    </form>
</div>
```

### Automatic Reconnection

On abnormal close, service restart, or try-again-later, the extension reconnects using full-jitter exponential backoff. Customize via:

```js
htmx.config.wsReconnectDelay = function(retryCount) {
    return retryCount * 1000; // ms
};
```

Messages sent while disconnected are queued in memory and sent when the connection restores.

### Configuration Options

| Option | Type | Description |
|---|---|---|
| `createWebSocket` | Function | Factory returning a custom `WebSocket` instance. |
| `wsBinaryType` | String | Sets the socket's `binaryType`. Default: `"blob"`. |

### Events

| Event | Cancelable | Detail Properties |
|---|---|---|
| `htmx:wsConnecting` | No | `event.type` (`"connecting"`) |
| `htmx:wsOpen` | No | `elt`, `event`, `socketWrapper` |
| `htmx:wsClose` | No | `elt`, `event`, `socketWrapper` |
| `htmx:wsError` | No | `elt`, `error`, `socketWrapper` |
| `htmx:wsBeforeMessage` | Yes — canceling stops processing | `elt`, `message`, `socketWrapper` |
| `htmx:wsAfterMessage` | No | `elt`, `message`, `socketWrapper` |
| `htmx:wsConfigSend` | Yes — canceling prevents send | `parameters`, `unfilteredParameters`, `headers`, `errors`, `triggeringEvent`, `messageBody`, `elt`, `socketWrapper` |
| `htmx:wsBeforeSend` | Yes — canceling discards message | `elt`, `message`, `socketWrapper` |
| `htmx:wsAfterSend` | No | `elt`, `message`, `socketWrapper` |

**`detail.socketWrapper`** is exposed on all events. Members:
- `send(message, fromElt)` — safe send; queues if socket is not open.
- `sendImmediately(message, fromElt)` — attempts send regardless of state.
- `queue` — array of queued messages.

**`wsConfigSend` `detail.messageBody`** — set to any WebSocket-supported type to override default JSON serialization (e.g., XML, MessagePack).

---

## Server-Sent Events (`sse`)

Uni-directional real-time updates over standard HTTP using the EventSource API. Extension name: `sse`.

### Attributes

| Attribute | Description |
|---|---|
| `sse-connect="<url>"` | Open an SSE connection to the URL. Query parameters are supported for server-side customization. |
| `sse-swap="<event-name>"` | Swap the data of the named SSE event into this element. Comma-separated for multiple events. |
| `hx-trigger="sse:<event-name>"` | Trigger an HTMX request when the named SSE event fires (used on child elements). |
| `sse-close="<event-name>"` | Close the EventSource when this event name is received. |

### Receiving Events

```html
<!-- Single named event -->
<div hx-ext="sse" sse-connect="/events" sse-swap="EventName"></div>

<!-- Unnamed events use the name "message" -->
<div hx-ext="sse" sse-connect="/events" sse-swap="message"></div>

<!-- Multiple events, same element -->
<div hx-ext="sse" sse-connect="/events" sse-swap="event1,event2"></div>

<!-- Multiple events, child elements -->
<div hx-ext="sse" sse-connect="/events">
    <div sse-swap="event1"></div>
    <div sse-swap="event2"></div>
</div>
```

The event name in `sse-swap` must exactly match the server's `event:` field. Unnamed server messages use `message`.

### Triggering Requests from SSE

```html
<div hx-ext="sse" sse-connect="/event_stream">
    <div hx-get="/chatroom" hx-trigger="sse:chatter">
        ...
    </div>
</div>
```

### Automatic Reconnection

Browsers reconnect SSE automatically. The extension adds exponential-backoff reconnection on top for reliability.

### Events

| Event | Cancelable | Detail Properties |
|---|---|---|
| `htmx:sseOpen` | No | `elt` (element with `sse-connect`), `source` (EventSource) |
| `htmx:sseError` | No | `error`, `source` |
| `htmx:sseBeforeMessage` | Yes — `preventDefault()` stops swap | `elt` (swap target) |
| `htmx:sseMessage` | No | `elt` (swap target) |
| `htmx:sseClose` | No | `elt` (swap target) |

**`htmx:sseClose` `detail.type`** values: `"nodeMissing"` (parent removed), `"nodeReplaced"` (parent swapped), `"message"` (closed by `sse-close`).

---

## Idiomorph / DOM Morphing (`morph`)

Uses the Idiomorph algorithm to morph existing DOM nodes into new HTML instead of replacing them. Preserves element state (focus, scroll position, CSS transitions) during swaps. Extension name: `morph`.

### Swap Strategies

| `hx-swap` Value | Behavior |
|---|---|
| `morph` | Morph the target element and its children (equivalent to `morph:outerHTML`). |
| `morph:outerHTML` | Morph the target element and its children. |
| `morph:innerHTML` | Morph only the children of the target; the target element itself is untouched. |

### Usage

```html
<body hx-ext="morph">
    <button hx-get="/example" hx-swap="morph">
        Morph My Outer HTML
    </button>

    <button hx-get="/example" hx-swap="morph:innerHTML">
        Morph My Inner HTML
    </button>
</body>
```

---

## Response Targets (`response-targets`)

Route responses to different target elements based on HTTP status code. Extension name: `response-targets`.

### Attributes

`hx-target-[CODE]` where `[CODE]` is a numeric HTTP status code, optionally ending with a wildcard. Also supports `hx-target-error` for all 4xx and 5xx codes.

Values accept the same selectors as `hx-target`: CSS selectors, `this`, `closest <sel>`, `find <sel>`, `next <sel>`, `previous <sel>`.

These attributes are **inherited** and can be placed on parent elements.

### Wildcard Resolution

When an exact code attribute is not found, the last digit is replaced with `*` and lookup continues:

`404` → `hx-target-404` → `hx-target-40*` → `hx-target-4*` → `hx-target-*`

Use `x` instead of `*` if your tooling doesn't support asterisks in attributes (e.g., `hx-target-4xx`).

### Usage

```html
<div hx-ext="response-targets">
    <div id="response-div"></div>
    <button hx-post="/register"
        hx-target="#response-div"
        hx-target-5*="#serious-errors"
        hx-target-404="#not-found">
        Register!
    </button>
    <div id="serious-errors"></div>
    <div id="not-found"></div>
</div>
```

```html
<!-- Catch all errors with hx-target-error -->
<button hx-post="/register"
    hx-target="#response-div"
    hx-target-error="#any-errors">
    Register!
</button>
```

### Configuration

| Config Flag | Default | Description |
|---|---|---|
| `htmx.config.responseTargetPrefersRetargetHeader` | `true` | When `true`, the `HX-Retarget` response header takes priority over `hx-target-*` attributes. |
| `htmx.config.responseTargetPrefersExisting` | `false` | When `true`, targets set by other extensions or built-in logic take priority over `hx-target-*`. |
| `htmx.config.responseTargetUnsetsError` | `true` | When `true`, `isError` is set to `false` for error responses matched by `hx-target-*`. |
| `htmx.config.responseTargetSetsError` | `false` | When `true`, `isError` is set to `true` for non-error responses matched by `hx-target-*` (does not affect 200). |

### Notes

- Cannot handle HTTP 200 responses (those use the standard `hx-target`).
- `hx-ext` should be on a parent element containing both `hx-target-*` and `hx-target` attributes.

---

## Head Support (`head-support`)

Merges `<head>` tag content from HTMX responses into the document head. Extension name: `head-support`.

### Merge Behavior

**Boosted requests** (default merge):
1. Elements that exist in both current and new head are kept.
2. Elements only in the new head are appended.
3. Elements only in the current head are removed.

**Non-boosted requests**: all new head content is appended (no removal).

### Controlling Merge Mode

Set `hx-head` on the response's `<head>` element:

| `hx-head` Value | Behavior |
|---|---|
| `merge` | Use the merge algorithm (match, add, remove). |
| `append` | Only append new elements; never remove existing ones. |

### Per-Element Control

| Attribute | Effect |
|---|---|
| `hx-head="re-eval"` | Re-add (remove then append) this element on every response, even if it already exists. Useful for re-executing scripts. |
| `hx-preserve="true"` | Never remove this element from the head. |

### Usage

```html
<body hx-ext="head-support">
    ...
</body>
```

Responses containing a `<head>` tag (even without a root `<html>`) will be processed.

### Events

| Event | Cancelable | Detail Properties |
|---|---|---|
| `htmx:beforeHeadMerge` | No | — |
| `htmx:afterHeadMerge` | No | `added`, `kept`, `removed` (arrays of head elements) |
| `htmx:addingHeadElement` | Yes — `preventDefault()` skips the add | `headElement` |
| `htmx:removingHeadElement` | Yes — `preventDefault()` skips the removal | `headElement` |

---

## Preload (`preload`)

Pre-fetches HTML fragments into the browser cache before user interaction, making subsequent navigation appear instant. Extension name: `preload`.

### Attributes

| Attribute | Values | Description |
|---|---|---|
| `preload` | `mousedown` (default), `mouseover`, `<custom-event>`, `always`, `always mouseover`, etc. | Trigger for when preloading starts. Place on individual elements or a parent to preload all descendant links. |
| `preload-images` | `"true"` | Also preload images found in the preloaded HTML fragment. |

### Usage

```html
<body hx-ext="preload">
    <!-- Preload on mousedown (default) -->
    <a href="/page" preload>Next Page</a>

    <!-- Preload on hover (100ms delay) -->
    <a href="/page" preload="mouseover">Next Page</a>

    <!-- Preload immediately when element is processed -->
    <button hx-get="/data" preload="preload:init" hx-target="#content">Load</button>

    <!-- Inherit preload to all child links -->
    <ul preload>
        <li><a href="/page1">Page 1</a></li>
        <li><a href="/page2">Page 2</a></li>
    </ul>

    <!-- Always re-preload (not just once) -->
    <a href="/live-data" preload="always mouseover">Live Data</a>

    <!-- Also preload images in the fetched HTML -->
    <a href="/gallery" preload="mouseover" preload-images="true">Gallery</a>
</body>
```

### Preloading Forms

GET forms (`hx-get` or `method="get"`) can be preloaded. Supported form elements:

- `<input type="radio">` — preloads as if selected
- `<input type="checkbox">` — preloads as if toggled
- `<select>` — preloads each unselected option
- `<input type="submit">` — preloads as if submitted

### Request Header

All preload requests include `HX-Preloaded: true`.

### Limitations

- Only `GET` requests can be preloaded (links with `href` and elements with `hx-get`).
- `mouseover` trigger has a built-in 100ms delay; if the mouse leaves before timeout, no request fires.
- Responses are only cached if server response headers allow it (e.g., `Cache-Control: private, max-age=60`). `Cache-Control: no-cache` prevents caching.
- Touch devices get an `ontouchstart` handler (fires immediately, no delay) alongside `mouseover`/`mousedown`.
