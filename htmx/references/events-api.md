---
description: HTMX events, JavaScript API, configuration, extensions, and debugging.
globs: "*.html,*.js"
---

# HTMX Events & API


Events, JS API, configuration, extensions, debugging, and scripting integration.

## Contents

- Event Reference
- Event Naming
- JavaScript API
- Configuration
- Extensions
- Debugging
- Scripting Integration
- Third-Party Library Integration

## Event Reference

All events are fired on the relevant DOM element and bubble up. Listen with `addEventListener`, `htmx.on()`, or `hx-on:`.

### Request Lifecycle Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:confirm` | Fires on **every** trigger (not just `hx-confirm`). Call `event.preventDefault()` to halt, `event.detail.issueRequest()` to resume. Use for async custom dialogs | `elt`, `path`, `verb`, `target`, `triggeringEvent`, `question`, `issueRequest(skipConfirmation)` |
| `htmx:configRequest` | Before request. Modify parameters and headers here | `parameters`, `headers`, `elt`, `target`, `verb`, `path` |
| `htmx:beforeRequest` | Before AJAX request is made | `elt`, `target`, `requestConfig`, `xhr` |
| `htmx:beforeSend` | Just before request is sent over the network | `elt`, `target`, `requestConfig`, `xhr` |
| `htmx:afterRequest` | After request completes (success or failure) | `elt`, `target`, `xhr`, `successful`, `failed` |
| `htmx:responseError` | On non-2xx/3xx HTTP response | `xhr`, `elt`, `target` |
| `htmx:sendError` | On network failure | `xhr`, `elt`, `target` |
| `htmx:sendAbort` | When request is aborted | `elt`, `target` |
| `htmx:timeout` | When request times out | `elt`, `target`, `xhr` |
| `htmx:abort` | Trigger this on an element to abort its in-flight request | — |

### Response Processing Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:beforeOnLoad` | Before any response processing | `xhr`, `elt`, `target` |
| `htmx:afterOnLoad` | After successful response processing | `xhr`, `elt`, `target` |
| `htmx:onLoadError` | When an exception occurs during response processing | `xhr`, `elt`, `target`, `exception` |

### Swap & Settle Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:beforeSwap` | Before swap. Modify swap behavior here | `xhr`, `elt`, `target`, `shouldSwap`, `serverResponse`, `isError`, `swapOverride`, `selectOverride`, `ignoreTitle`, `requestConfig.elt` |
| `htmx:afterSwap` | After new content is swapped in | `xhr`, `elt`, `target` |
| `htmx:beforeTransition` | Before View Transition API swap. `preventDefault()` to cancel | `xhr`, `elt`, `target` |
| `htmx:afterSettle` | After DOM has settled | `xhr`, `elt`, `target` |
| `htmx:swapError` | When swap encounters an error | `xhr`, `elt`, `target` |
| `htmx:targetError` | When target selector is invalid | `target` |

### Element Lifecycle Events

| Event | Fires When |
|---|---|
| `htmx:load` | New content added to DOM. Use for initializing third-party libraries |
| `htmx:beforeProcessNode` | Before HTMX initializes attributes on a node |
| `htmx:afterProcessNode` | After HTMX has initialized a node |
| `htmx:beforeCleanupElement` | Before HTMX removes or disables an element |

### OOB Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:oobBeforeSwap` | Before OOB swap | `fragment`, `target` |
| `htmx:oobAfterSwap` | After OOB swap | `fragment`, `target` |
| `htmx:oobErrorNoTarget` | OOB element has no matching `id` in DOM | `content` |

### History Events

| Event | Fires When |
|---|---|
| `htmx:beforeHistorySave` | Before page snapshot is cached. Clean up DOM here |
| `htmx:pushedIntoHistory` | After URL is pushed into history |
| `htmx:replacedInHistory` | After URL is replaced in history |
| `htmx:historyRestore` | During back/forward navigation restoration |
| `htmx:historyCacheHit` | History cache hit (cached content found) |
| `htmx:historyCacheMiss` | History cache miss (AJAX fetch needed) |
| `htmx:historyCacheMissLoad` | Successful AJAX fetch for missed cache |
| `htmx:historyCacheMissLoadError` | Failed AJAX fetch for missed cache |
| `htmx:historyCacheError` | Error writing to cache |

### Validation Events

| Event | Fires When |
|---|---|
| `htmx:validation:validate` | Before `checkValidity()` is called |
| `htmx:validation:failed` | When validation fails |
| `htmx:validation:halted` | When request is blocked due to validation |

### XHR Progress Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:xhr:loadstart` | AJAX request starts | — |
| `htmx:xhr:progress` | During upload/download progress | `loaded`, `total` |
| `htmx:xhr:loadend` | AJAX request ends | — |
| `htmx:xhr:abort` | AJAX request aborted | — |

### URL & Security Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:validateUrl` | Before request, to validate the destination URL. `preventDefault()` to block | `elt`, `url` (URL object), `sameHost` |

### Prompt & Trigger Events

| Event | Fires When | Key `event.detail` Properties |
|---|---|---|
| `htmx:prompt` | After user responds to `hx-prompt` dialog | `elt`, `target`, `prompt` (user response) |
| `htmx:trigger` | Whenever an AJAX request occurs (for client-side scripting) | `elt` |

### SSE Events

| Event | Fires When |
|---|---|
| `htmx:sseOpen` | SSE connection established |
| `htmx:sseError` | SSE connection error |
| `htmx:sseBeforeMessage` | Before SSE message is swapped (cancellable with `preventDefault()`) |
| `htmx:sseMessage` | After SSE message has been swapped in |
| `htmx:sseClose` | SSE connection closed. `detail.type`: `nodeMissing`, `nodeReplaced`, or `message` |
| `htmx:noSSESourceError` | Element references SSE event but no parent SSE source exists |

### WebSocket Events

| Event | Fires When |
|---|---|
| `htmx:wsConnecting` | WebSocket connection is being established |
| `htmx:wsOpen` | WebSocket connection established |
| `htmx:wsClose` | WebSocket connection closed |
| `htmx:wsError` | WebSocket connection error |
| `htmx:wsBeforeMessage` | Before WebSocket message is processed (cancellable) |
| `htmx:wsAfterMessage` | After WebSocket message has been processed |
| `htmx:wsConfigSend` | Before preparing to send over WebSocket (cancellable) |
| `htmx:wsBeforeSend` | Just before sending over WebSocket (cancellable) |
| `htmx:wsAfterSend` | After message sent over WebSocket |

## Event Naming

HTMX events support both **camelCase** and **kebab-case**:

```javascript
// Both work
document.addEventListener('htmx:afterSwap', handler);
document.addEventListener('htmx:after-swap', handler);
```

In `hx-on:` attributes, use **kebab-case** (HTML attributes are case-insensitive):

```html
<!-- Correct -->
<div hx-on:htmx:after-swap="handler()">

<!-- Will NOT work (HTML lowercases attributes) -->
<div hx-on:htmx:afterSwap="handler()">
```

## JavaScript API

### Element Selection

```javascript
// Find single element
htmx.find('#my-element');
htmx.find(parentElt, '.child');

// Find all matching elements
htmx.findAll('.items');
htmx.findAll(parentElt, '.items');

// Find closest ancestor
htmx.closest(elt, 'form');
```

### AJAX Requests

Returns a **Promise** that resolves when the request completes.

```javascript
// Basic AJAX request
htmx.ajax('GET', '/api/data', '#target');

// With options
htmx.ajax('POST', '/api/data', {
    target: '#target',
    swap: 'innerHTML',
    values: { key: 'value' },
    headers: { 'X-Custom': 'header' },
    source: '#source-element',
    select: '#content',
    selectOOB: '#sidebar',
    push: true,
    replace: false
}).then(() => {
    console.log('Request complete');
});
```

### DOM Manipulation

```javascript
// Class manipulation (all accept optional delay in ms)
htmx.addClass(elt, 'active');
htmx.addClass(elt, 'active', 1000);  // add after 1s delay
htmx.removeClass(elt, 'active');
htmx.removeClass(elt, 'active', 500);  // remove after 500ms
htmx.toggleClass(elt, 'active');

// Take class from siblings (only this element gets it)
htmx.takeClass(elt, 'selected');

// Remove element from DOM (optional delay in ms)
htmx.remove(elt);
htmx.remove(elt, 2000);  // remove after 2s

// Swap content programmatically
htmx.swap(targetElt, '<p>New content</p>', {
    swapStyle: 'innerHTML',
    swapDelay: 0,
    settleDelay: 20,
    transition: false,
    ignoreTitle: false,
    head: 'merge',  // or 'append'
    scroll: 'top',
    focusScroll: false
}, {
    select: '#content',
    selectOOB: '#sidebar',
    afterSwapCallback: function() {},
    afterSettleCallback: function() {}
});
```

### Event Management

```javascript
// Listen for events
var listener = htmx.on('#my-element', 'htmx:afterSwap', function(event) {
    console.log('Swapped!', event.detail);
});

// Listen on document
htmx.on('htmx:afterSwap', function(event) {
    console.log('Any swap:', event.detail);
});

// Remove listener
htmx.off('#my-element', 'htmx:afterSwap', listener);

// Trigger events
htmx.trigger(elt, 'myCustomEvent', { key: 'value' });

// Trigger abort on an element's in-flight request
htmx.trigger(elt, 'htmx:abort');
```

### Content Initialization

```javascript
// Process dynamically-added HTML for HTMX attributes
var newContent = document.createElement('div');
newContent.innerHTML = '<button hx-get="/api">Load</button>';
document.body.appendChild(newContent);
htmx.process(newContent); // Now HTMX recognizes the button

// Initialize third-party libraries on new content
htmx.onLoad(function(content) {
    // Runs every time HTMX swaps new content into the DOM
    var tooltips = content.querySelectorAll('[data-tooltip]');
    tooltips.forEach(initTooltip);
});
```

### Utilities

```javascript
// Get form values from an element ('get' or 'post' mode)
var values = htmx.values(formElement);
var values = htmx.values(formElement, 'get');

// Parse interval string to milliseconds
htmx.parseInterval('500ms'); // 500
htmx.parseInterval('2s');    // 2000
// Caution: '3m' uses parseFloat, won't parse as minutes
```

### Factory Properties

```javascript
// Customize SSE EventSource creation
htmx.createEventSource = function(url) {
    return new EventSource(url, { withCredentials: true });
};

// Customize WebSocket creation
htmx.createWebSocket = function(url) {
    return new WebSocket(url, ['wss']);
};
```

### Extension Management

```javascript
// Define a custom extension
htmx.defineExtension('my-ext', {
    onEvent: function(name, event) {
        if (name === 'htmx:beforeRequest') {
            // Modify request
        }
    },
    transformResponse: function(text, xhr, elt) {
        return text; // Transform response HTML
    },
    isInlineSwap: function(swapStyle) {
        return false;
    },
    handleSwap: function(swapStyle, target, fragment, settleInfo) {
        return false; // Return true if handled
    },
    encodeParameters: function(xhr, parameters, elt) {
        return null; // Return encoded body or null
    }
});

// Remove extension
htmx.removeExtension('my-ext');
```

## Configuration

Configure via JavaScript or `<meta>` tag.

### JavaScript

```javascript
htmx.config.defaultSwapStyle = 'outerHTML';
htmx.config.historyCacheSize = 20;
```

### Meta Tag

```html
<meta name="htmx-config" content='{
    "defaultSwapStyle": "outerHTML",
    "historyCacheSize": 20
}' />
```

### All Configuration Options

| Option | Default | Description |
|---|---|---|
| `historyEnabled` | `true` | Enable history snapshot and navigation |
| `historyCacheSize` | `10` | Max pages in history cache. `0` to disable |
| `refreshOnHistoryMiss` | `false` | Full page reload on cache miss instead of AJAX |
| `defaultSwapStyle` | `innerHTML` | Default `hx-swap` strategy |
| `defaultSwapDelay` | `0` | Default swap delay in ms |
| `defaultSettleDelay` | `20` | Default settle delay in ms |
| `includeIndicatorStyles` | `true` | Inject default indicator CSS |
| `indicatorClass` | `htmx-indicator` | Class for request indicators |
| `requestClass` | `htmx-request` | Class applied during requests |
| `addedClass` | `htmx-added` | Class for newly swapped content |
| `settlingClass` | `htmx-settling` | Class during settle phase |
| `swappingClass` | `htmx-swapping` | Class during swap phase |
| `allowEval` | `true` | Allow eval-dependent features (`hx-on:`, trigger filters, `hx-vals` with `js:`) |
| `allowScriptTags` | `true` | Process `<script>` tags in responses |
| `inlineScriptNonce` | `''` | Nonce for inline scripts |
| `inlineStyleNonce` | `''` | Nonce for inline styles |
| `attributesToSettle` | `["class","style","width","height"]` | Attributes settled during settle phase |
| `useTemplateFragments` | `false` | Use `<template>` for HTML parsing (helps with table/SVG content) |
| `wsReconnectDelay` | `full-jitter` | WebSocket reconnect delay strategy |
| `wsBinaryType` | `blob` | WebSocket binary data type |
| `disableSelector` | `[hx-disable], [data-hx-disable]` | CSS selector for disabled elements |
| `withCredentials` | `false` | Send credentials with cross-origin requests |
| `timeout` | `0` | Request timeout in ms. `0` = no timeout |
| `scrollBehavior` | `instant` | Scroll behavior: `instant`, `smooth`, `auto` |
| `defaultFocusScroll` | `false` | Scroll focused element into view after swap |
| `getCacheBusterParam` | `false` | Add cache-buster query param to GET requests |
| `globalViewTransitions` | `false` | Enable View Transitions API globally |
| `methodsThatUseUrlParams` | `["get","delete"]` | Methods that encode params in URL |
| `selfRequestsOnly` | `true` | Only allow same-origin requests |
| `ignoreTitle` | `false` | Don't update `document.title` from responses |
| `disableInheritance` | `false` | Disable attribute inheritance globally |
| `scrollIntoViewOnBoost` | `true` | Scroll to top on boosted navigation |
| `triggerSpecsCache` | `null` | Cache object for parsed trigger specs |
| `allowNestedOobSwaps` | `true` | Process OOB swaps in nested content |
| `responseHandling` | See docs | Array of status code handling rules |
| `historyRestoreAsHxRequest` | `true` | Send HX-Request header on history restore |
| `reportValidityOfForms` | `false` | Report validation errors via browser UI |

## Extensions

### Installing Extensions

```html
<!-- Via CDN -->
<script src="https://unpkg.com/htmx-ext-preload@2.1.0/preload.js"></script>

<!-- Enable on element or parent -->
<body hx-ext="preload">
    ...
</body>
```

### Core Extensions

| Extension | Purpose | Package |
|---|---|---|
| `head-support` | Merge `<head>` elements from responses | `htmx-ext-head-support` |
| `htmx-1-compat` | HTMX 1.x compatibility layer | `htmx-ext-htmx-1-compat` |
| `idiomorph` | DOM morphing swap strategy | `idiomorph` |
| `preload` | Preload content on hover/focus | `htmx-ext-preload` |
| `response-targets` | Target different elements by HTTP status code | `htmx-ext-response-targets` |
| `sse` | Server-Sent Events support | `htmx-ext-sse` |
| `ws` | WebSocket support | `htmx-ext-ws` |

### SSE Extension

```html
<div hx-ext="sse" sse-connect="/events">
    <!-- Swap content when 'message' event is received -->
    <div sse-swap="message">Waiting for messages...</div>

    <!-- Trigger HTMX request on SSE event -->
    <div hx-get="/update" hx-trigger="sse:notification">Notifications</div>
</div>
```

### WebSocket Extension

```html
<div hx-ext="ws" ws-connect="/ws">
    <!-- Send form data over WebSocket -->
    <form ws-send>
        <input name="message" />
        <button type="submit">Send</button>
    </form>

    <!-- Content area updated by WebSocket messages -->
    <div id="messages"></div>
</div>
```

### response-targets Extension

Target different elements based on HTTP response status:

```html
<div hx-ext="response-targets">
    <form hx-post="/submit"
          hx-target="#success"
          hx-target-422="#form-errors"
          hx-target-5*="#server-error">
        ...
    </form>
    <div id="success"></div>
    <div id="form-errors"></div>
    <div id="server-error"></div>
</div>
```

### Disabling Extensions

```html
<div hx-ext="preload">
    <!-- Preload enabled here -->
    <div hx-ext="ignore:preload">
        <!-- Preload disabled here -->
    </div>
</div>
```

## Debugging

### Log All Events

```javascript
htmx.logAll();

// Disable all logging
htmx.logNone();
```

### Custom Logger

```javascript
htmx.logger = function(elt, event, data) {
    if (event === 'htmx:responseError') {
        console.error('HTMX Error:', data);
    }
};
```

### Browser Console Monitoring

```javascript
// Monitor all events on a specific element
monitorEvents(document.getElementById('my-element'));
```

### Demo/Mock Server

Load `https://demo.htmx.org` in a `<script>` tag to mock server responses using `<template>` tags:

```html
<script src="https://demo.htmx.org"></script>

<template url="/api/greeting" delay="500">
    <p>Hello, World!</p>
</template>

<button hx-get="/api/greeting" hx-target="#output">
    Get Greeting
</button>
<div id="output"></div>
```

## Scripting Integration

### hx-on: Inline Scripts

```html
<!-- React to DOM events -->
<button hx-on:click="console.log('clicked')">Click</button>

<!-- React to HTMX events (kebab-case required) -->
<form hx-post="/submit"
      hx-on:htmx:before-request="showSpinner()"
      hx-on:htmx:after-request="hideSpinner()">
    ...
</form>

<!-- Access event detail -->
<div hx-get="/data"
     hx-on:htmx:config-request="event.detail.parameters.timestamp = Date.now()">
    Load
</div>
```

### Recommended Scripting Approaches

| Approach | Use Case |
|---|---|
| Vanilla JS | Simple DOM manipulation, event handling |
| Alpine.js | Lightweight client-side reactivity alongside HTMX |
| hyperscript | HTMX-team scripting language, `_` attribute |
| jQuery | Legacy compatibility |

### Alpine.js + HTMX Example

```html
<div x-data="{ count: 0 }" hx-get="/data" hx-trigger="click">
    <span x-text="count"></span>
    <button @click="count++">Local increment</button>
</div>
```

## Third-Party Library Integration

### Initialize on New Content

```javascript
htmx.onLoad(function(content) {
    // Initialize any library that needs DOM elements
    var charts = content.querySelectorAll('.chart');
    charts.forEach(function(el) {
        new Chart(el, JSON.parse(el.dataset.config));
    });
});
```

### Clean Up Before Removal

```javascript
document.addEventListener('htmx:beforeCleanupElement', function(event) {
    var chart = Chart.getChart(event.target);
    if (chart) {
        chart.destroy();
    }
});
```

### Process Dynamically-Added HTMX

When adding HTML to the DOM outside of HTMX (e.g., via a third-party library):

```javascript
var container = document.getElementById('dynamic');
container.innerHTML = '<button hx-get="/api/data">Load</button>';
htmx.process(container);
```

### Event-Driven Integration

Libraries that fire DOM events can trigger HTMX requests:

```html
<!-- Third-party fires 'map:click' on this element -->
<div id="map"
     hx-get="/location"
     hx-trigger="map:click"
     hx-target="#location-info">
</div>
<div id="location-info"></div>
```
