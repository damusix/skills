# Server Startup & Shutdown Lifecycle


## Phases

The server moves through these phases in order:

    stopped → initializing → initialized → starting → started → stopping → stopped

If any step throws, the phase becomes `invalid`. Call `stop()` to reset.


## Registration Phase (phase: `stopped`)

All configuration happens before `initialize()` or `start()`:

    const server = Hapi.server(options);   // cache clients created, listener set up

    await server.register(plugins);        // plugin register() runs immediately
    server.auth.scheme('name', scheme);    // schemes registered
    server.auth.strategy('name', 'scheme', options);
    server.route(routes);                  // routes added to router
    server.ext('onPreStart', handler);     // lifecycle extensions queued

Order between these calls is flexible — plugins typically register routes, auth, and extensions inside their `register()` function. The only hard rule: **all plugins listed in `server.dependency()` must be registered before `initialize()`**.


## `server.initialize()`

Finalizes registration and starts internal services without opening the port.

    1. Validate plugin dependencies       server.dependency() declarations checked
    2. Start all cache clients            parallel — all provisioned caches
    3. Run onPreStart extensions          sequential, topo-ordered (before/after)
    4. Start load monitor (heavy)         @hapi/heavy begins sampling
    5. Propagate to controlled servers    controlled.initialize() in parallel

Phase transitions: `stopped` → `initializing` → `initialized`

**Constraints:**
- Cannot add `onPreStart` extensions after `initialize()` completes
- Idempotent — calling again when already `initialized` is a no-op
- Cannot call while server is `started`


## `server.start()`

Opens the port and begins accepting requests. Calls `initialize()` internally if needed.

    1. Run initialize() if not done       steps 1-5 above (skipped if already initialized)
    2. Bind HTTP listener                  listener.listen(port, address)
    3. Emit 'start' event                 server.events subscribers notified
    4. Propagate to controlled servers    controlled.start() in parallel
    5. Run onPostStart extensions         sequential, topo-ordered (before/after)

Phase transitions: `initialized` → `starting` → `started`

**Constraints:**
- Idempotent — calling again when already `started` is a no-op (no events, no extensions)
- If `onPostStart` throws, phase becomes `invalid`


## `server.stop([options])`

Drains connections and tears down services. Default timeout: 5000ms.

    1. Run onPreStop extensions           sequential, topo-ordered
    2. Close listener                     stop accepting new connections
    3. Emit 'closing' event              still draining active connections
    4. Drain/force-destroy sockets        waits up to timeout ms, then destroys
    5. Stop all cache clients             parallel
    6. Emit 'stop' event                 server fully stopped
    7. Stop load monitor (heavy)
    8. Propagate to controlled servers    controlled.stop() in parallel
    9. Run onPostStop extensions          sequential, topo-ordered

Phase transitions: `started` → `stopping` → `stopped`

**Constraints:**
- `onPreStop` and `onPostStop` are NOT subject to the timeout — they can block indefinitely
- The timeout only applies to draining existing connections (step 4)
- Timeout ignored if `server.options.operations.cleanStop` is `false`


## Extension Timing Summary

| Extension       | Fires during       | Server state at that moment                       |
| --------------- | ------------------ | ------------------------------------------------- |
| `onPreStart`    | `initialize()`     | Caches started. Listener not yet open.             |
| `onPostStart`   | `start()`          | Listener open. Server accepting requests.          |
| `onPreStop`     | `stop()`           | Server still accepting requests (listener closing).|
| `onPostStop`    | `stop()`           | Listener closed. Caches stopped. Fully torn down.  |

All extensions receive `(server)` as the sole argument and run sequentially. Ordering between plugins is controlled via `{ before, after }` options on `server.ext()`.


## `initialize()` vs `start()`

| Aspect                  | `initialize()`          | `start()`                          |
| ----------------------- | ----------------------- | ---------------------------------- |
| Starts caches           | Yes                     | Only if not already initialized    |
| Fires `onPreStart`      | Yes                     | Only if not already initialized    |
| Opens port              | No                      | Yes                                |
| Fires `onPostStart`     | No                      | Yes                                |
| Emits `start` event     | No                      | Yes                                |
| Use case                | Testing, pre-flight     | Production server startup          |

Calling `initialize()` then `start()` is safe — `start()` skips the already-completed initialization.


## Complete Timeline

    ┌─ Registration ──────────────────────────────────┐
    │  new Server(options)                             │
    │  server.register(plugins)                        │
    │  server.route(routes)                            │
    │  server.auth.scheme/strategy()                   │
    │  server.ext(...)                                 │
    └──────────────────────────────────────────────────┘
                         │
                         ▼
    ┌─ initialize() ──────────────────────────────────┐
    │  Validate plugin dependencies                    │
    │  Start cache clients (parallel)                  │
    │  ► onPreStart extensions (sequential)            │
    │  Start load monitor                              │
    └──────────────────────────────────────────────────┘
                         │
                         ▼
    ┌─ start() ───────────────────────────────────────┐
    │  Bind listener to port                           │
    │  Emit 'start' event                              │
    │  ► onPostStart extensions (sequential)           │
    └──────────────────────────────────────────────────┘
                         │
                   (serving requests)
                         │
                         ▼
    ┌─ stop() ────────────────────────────────────────┐
    │  ► onPreStop extensions (sequential)             │
    │  Close listener / drain connections              │
    │  Emit 'closing' event                            │
    │  Stop cache clients (parallel)                   │
    │  Emit 'stop' event                               │
    │  Stop load monitor                               │
    │  ► onPostStop extensions (sequential)            │
    └──────────────────────────────────────────────────┘
