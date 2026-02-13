## Route Security Headers (`route.options.security`)


Default: `false` (security headers disabled).

Set to `true` to enable all defaults, or to an object for fine control.

    // Enable all security headers with defaults
    server.route({
        method: 'GET',
        path: '/secure',
        options: {
            security: true,
            handler: () => 'ok'
        }
    });

### All security options


| Option     | Default (when `security: true`)  | Description                                  |
| ---------- | -------------------------------- | -------------------------------------------- |
| `hsts`     | `true` (max-age=15768000)        | Controls `Strict-Transport-Security` header. |
| `xframe`   | `true` (`DENY`)                  | Controls `X-Frame-Options` header.           |
| `xss`      | `'disabled'` (header set to `0`) | Controls `X-XSS-Protection` header.          |
| `noOpen`   | `true` (`noopen`)                | Controls `X-Download-Options` header (IE).   |
| `noSniff`  | `true` (`nosniff`)               | Controls `X-Content-Type-Options` header.    |
| `referrer` | `false` (no header)              | Controls `Referrer-Policy` header.           |

### `hsts` (Strict-Transport-Security)


| Value                                                          | Header output                                  |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `true`                                                         | `max-age=15768000`                             |
| `15768000` (number)                                            | `max-age=15768000`                             |
| `{ maxAge: 31536000, includeSubDomains: true, preload: true }` | `max-age=31536000; includeSubDomains; preload` |
| `false`                                                        | Header omitted                                 |

    security: {
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }

### `xframe` (X-Frame-Options)


| Value                                                   | Header output                    |
| ------------------------------------------------------- | -------------------------------- |
| `true`                                                  | `DENY`                           |
| `'deny'`                                                | `DENY`                           |
| `'sameorigin'`                                          | `SAMEORIGIN`                     |
| `{ rule: 'allow-from', source: 'https://example.com' }` | `ALLOW-FROM https://example.com` |
| `{ rule: 'allow-from' }` (no source)                    | Falls back to `SAMEORIGIN`       |

    security: {
        xframe: { rule: 'allow-from', source: 'https://trusted.com' }
    }

### `xss` (X-XSS-Protection)


| Value        | Header output                |
| ------------ | ---------------------------- |
| `'disabled'` | `0` (default -- recommended) |
| `'enabled'`  | `1; mode=block`              |
| `false`      | Header omitted               |

The `'disabled'` default is intentional. Enabling XSS filtering can create security vulnerabilities in older browsers and unpatched IE8.

### `noOpen` (X-Download-Options)


Boolean. When `true` (default), sets `X-Download-Options: noopen` to prevent IE from executing downloads in the site's context.

### `noSniff` (X-Content-Type-Options)


Boolean. When `true` (default), sets `X-Content-Type-Options: nosniff` to prevent browsers from MIME-sniffing the content type.

### `referrer` (Referrer-Policy)


| Value                               | Meaning                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `false`                             | No `Referrer-Policy` header (default).                  |
| `''`                                | Policy defined elsewhere (e.g., meta tag).              |
| `'no-referrer'`                     | Never send referrer.                                    |
| `'no-referrer-when-downgrade'`      | No referrer on HTTPS-to-HTTP navigation.                |
| `'same-origin'`                     | Only send referrer for same-origin requests.            |
| `'origin'`                          | Send origin only (no path).                             |
| `'strict-origin'`                   | Like `'origin'` but omit on HTTPS-to-HTTP.              |
| `'origin-when-cross-origin'`        | Full URL for same-origin, origin only for cross-origin. |
| `'strict-origin-when-cross-origin'` | Like above but omit on HTTPS-to-HTTP.                   |
| `'unsafe-url'`                      | Always send full URL.                                   |

### Full custom example


    server.route({
        method: 'GET',
        path: '/dashboard',
        options: {
            security: {
                hsts: {
                    maxAge: 31536000,
                    includeSubDomains: true,
                    preload: true
                },
                xframe: 'sameorigin',
                xss: 'disabled',
                noOpen: true,
                noSniff: true,
                referrer: 'strict-origin-when-cross-origin'
            },
            handler: () => 'secure page'
        }
    });

### Server-level defaults


Security can be set as a route default for all routes:

    const server = Hapi.server({
        port: 3000,
        routes: {
            security: {
                hsts: true,
                xframe: true,
                noSniff: true,
                referrer: 'no-referrer'
            }
        }
    });

### Gotchas


- `security: true` enables all options with their defaults -- `xss` defaults to `'disabled'` (sends `X-XSS-Protection: 0`), which is the safe choice.
- The `xframe` `allow-from` directive is deprecated in modern browsers. Consider using CSP `frame-ancestors` instead.
- When `xframe` is set to `{ rule: 'allow-from' }` without a `source`, it automatically falls back to `'sameorigin'`.
