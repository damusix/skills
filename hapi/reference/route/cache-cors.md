## Route Cache and CORS Options


### `route.options.cache`


Default: `{ privacy: 'default', statuses: [200], otherwise: 'no-cache' }`.

Only applies to `GET` routes. Controls HTTP caching directives in the response via the `Cache-Control` header. Set to `false` to disable the default `Cache-Control: no-cache` header entirely.

| Property    | Default      | Description                                                                         |
| ----------- | ------------ | ----------------------------------------------------------------------------------- |
| `privacy`   | `'default'`  | `'default'` (no flag), `'public'`, or `'private'`.                                  |
| `expiresIn` | none         | Relative expiration in milliseconds. Cannot coexist with `expiresAt`.               |
| `expiresAt` | none         | Time of day in `'HH:MM'` (24h) when cache expires. Cannot coexist with `expiresIn`. |
| `statuses`  | `[200]`      | Array of HTTP status codes that may include caching directives.                     |
| `otherwise` | `'no-cache'` | `Cache-Control` header value when caching is disabled for the response.             |

    // Cache for 1 hour, public
    server.route({
        method: 'GET',
        path: '/data',
        options: {
            cache: {
                expiresIn: 60 * 60 * 1000,
                privacy: 'public'
            },
            handler: () => ({ cached: true })
        }
    });

    // Expire daily at midnight
    server.route({
        method: 'GET',
        path: '/daily',
        options: {
            cache: {
                expiresAt: '00:00',
                privacy: 'private'
            },
            handler: () => 'fresh each day'
        }
    });

    // Disable Cache-Control header entirely
    server.route({
        method: 'GET',
        path: '/no-header',
        options: {
            cache: false,
            handler: () => 'no cache header'
        }
    });

**Gotchas:**
- `expiresIn` and `expiresAt` are mutually exclusive.
- Cache settings are ignored for non-GET methods.
- The `otherwise` value is the raw header string sent when the response status is not in `statuses`.

---

### `route.options.compression`


Default: none.

An object where each key is a content-encoding name and each value is an object with the desired **encoder** settings. Decoder settings are configured separately in `route.options.payload.compression`.

    server.route({
        method: 'GET',
        path: '/compressed',
        options: {
            compression: {
                gzip: { level: 6 }
            },
            handler: () => 'compressed response'
        }
    });

---

### `route.options.cors`


Default: `false` (no CORS headers).

Set to `true` for CORS with all defaults, or to an object for fine control. When enabled, hapi automatically handles preflight (`OPTIONS`) requests.

| Property                   | Default                                                        | Description                                                                                                           |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `origin`                   | `['*']`                                                        | Array of allowed origin strings, `'*'` for any, or `'ignore'` to skip Origin checks entirely and set header to `'*'`. |
| `maxAge`                   | `86400` (1 day)                                                | Seconds the browser should cache the CORS preflight response.                                                         |
| `headers`                  | `['Accept', 'Authorization', 'Content-Type', 'If-None-Match']` | Allowed request headers.                                                                                              |
| `additionalHeaders`        | `[]`                                                           | Extra headers appended to the default `headers` list.                                                                 |
| `exposedHeaders`           | `['WWW-Authenticate', 'Server-Authorization']`                 | Headers the browser is allowed to access.                                                                             |
| `additionalExposedHeaders` | `[]`                                                           | Extra headers appended to the default `exposedHeaders` list.                                                          |
| `credentials`              | `false`                                                        | If `true`, sets `Access-Control-Allow-Credentials`.                                                                   |
| `preflightStatusCode`      | `200`                                                          | Status code for preflight responses: `200` or `204`.                                                                  |

    // Enable with defaults
    server.route({
        method: 'GET',
        path: '/api/data',
        options: {
            cors: true,
            handler: () => ({ result: 'ok' })
        }
    });

    // Fine-grained CORS
    server.route({
        method: 'POST',
        path: '/api/submit',
        options: {
            cors: {
                origin: ['https://example.com', 'https://*.example.com'],
                credentials: true,
                additionalHeaders: ['X-Custom-Header'],
                additionalExposedHeaders: ['X-Request-Id'],
                maxAge: 3600
            },
            handler: (request, h) => 'submitted'
        }
    });

**Key behaviors:**
- Use `additionalHeaders` / `additionalExposedHeaders` to extend the defaults without replacing them.
- Setting `origin` to `'ignore'` skips Origin header validation and always returns `Access-Control-Allow-Origin: *`.
- Wildcard origins (e.g., `'https://*.example.com'`) match subdomains.
- When `credentials` is `true`, the `origin` cannot be `['*']` -- the actual Origin header value is reflected back instead of `*`.
