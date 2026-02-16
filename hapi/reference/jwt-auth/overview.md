## @hapi/jwt Authentication Scheme Reference


@hapi/jwt is a hapi plugin that implements a JWT (JSON Web Token) authentication scheme. It is registered via `server.register()` and provides a scheme called `'jwt'` that can be used with `server.auth.strategy()`.

    const Hapi = require('@hapi/hapi');
    const Jwt = require('@hapi/jwt');

    const server = Hapi.server({ port: 3000 });

    await server.register(Jwt);

    server.auth.strategy('my_jwt_strategy', 'jwt', {
        keys: 'my-secret-key',
        verify: {
            aud: 'urn:audience:test',
            iss: 'urn:issuer:test',
            sub: false
        },
        validate: (artifacts, request, h) => {

            return {
                isValid: true,
                credentials: { user: artifacts.decoded.payload.user }
            };
        }
    });

    server.auth.default('my_jwt_strategy');


### Registration


@hapi/jwt **is a plugin**. Register it before creating strategies:

    await server.register(Jwt);

Registration exposes:

- The `'jwt'` auth scheme -- used in `server.auth.strategy(name, 'jwt', options)`
- `server.auth.verifyJwt` decoration -- utility for manual token verification
- The `Jwt.token` API is available as a standalone import without registration (see [token-api](token-api.md))

See [server auth](../server/auth.md) for how schemes, strategies, and defaults work in hapi's three-layer auth model.


### Strategy Options


Pass these as the third argument to `server.auth.strategy()`. (`lib/index.js`)

| Option | Type | Default | Description |
|---|---|---|---|
| `keys` | `string \| Buffer \| object \| array \| function` | -- | **Required.** Secret key(s) or key configuration for token verification. See [Keys Configuration](#keys-configuration) below. |
| `verify` | `object \| false` | -- | Token payload verification options. Set to `false` to skip all verification (signature and payload); `keys` is also not required when `verify` is `false`. (lib/plugin.js:118) See [Verify Options](#verify-options). |
| `validate` | `function` | -- | **Required.** Called after token decoding and verification to perform application-level validation. See [validate](validate.md). |
| `httpAuthScheme` | `string` | `'Bearer'` | The HTTP authentication scheme name in the `Authorization` header. |
| `unauthorizedAttributes` | `object` | -- | Attributes to include in the `WWW-Authenticate` header on 401 responses. |
| `headless` | `string` | -- | A fixed token header string (base64url-encoded) to prepend when decoding headless tokens. (lib/plugin.js:90) |
| `cookieName` | `string` | -- | When set, extracts the JWT from this cookie name instead of the Authorization header. (lib/plugin.js:73-78) |
| `headerName` | `string` | `'authorization'` | The request header to extract the token from. (lib/plugin.js:80-88) |
| `cache` | `object` | -- | JWKS key cache configuration. When `keys` uses a JWKS URI, controls the cache policy for fetched keys. (lib/plugin.js:59-71) |

**Minimal example:**

    server.auth.strategy('jwt', 'jwt', {
        keys: 'a-secret-with-minimum-32-characters',
        verify: {
            aud: false,
            iss: false,
            sub: false
        },
        validate: (artifacts, request, h) => {

            return { isValid: true, credentials: { user: artifacts.decoded.payload.user } };
        }
    });


### Keys Configuration


The `keys` option controls how the token signature is verified. It accepts multiple formats. (`lib/index.js`)

**String or Buffer (shared secret):**

    // HMAC secret -- uses HS256 by default
    keys: 'my-secret-key-at-least-32-chars-long'

**Object (detailed key configuration):**

| Option | Type | Default | Description |
|---|---|---|---|
| `key` | `string \| Buffer` | -- | The secret key or public key value. |
| `algorithms` | `string[]` | auto-detected | Allowed algorithms. When not specified, auto-detected based on key type (e.g., string/Buffer keys default to HMAC, PEM keys to RSA/EC). (lib/keys.js:146-163) |
| `kid` | `string` | -- | Key ID. When multiple keys are configured, matches against the token header `kid` field. |

    keys: {
        key: 'my-secret-key-at-least-32-chars-long',
        algorithms: ['HS256']
    }

**Array (multiple keys -- key rotation):**

    keys: [
        { key: 'current-key', algorithms: ['HS256'], kid: 'key-2024' },
        { key: 'old-key', algorithms: ['HS256'], kid: 'key-2023' }
    ]

When multiple keys are configured, @hapi/jwt tries each key until one succeeds. If keys have `kid`, the token header's `kid` is used to select the matching key directly.

**JWKS (JSON Web Key Set) URI:**

    keys: {
        uri: 'https://your-auth-server.com/.well-known/jwks.json'
    }

| Option | Type | Default | Description |
|---|---|---|---|
| `uri` | `string` | -- | JWKS endpoint URL. Keys are fetched and cached. |
| `rejectUnauthorized` | `boolean` | `true` | Whether to reject TLS connections with unverified certificates. |
| `headers` | `object` | -- | Additional headers to send with the JWKS request. |
| `algorithms` | `string[]` | -- | Restrict allowed algorithms from the JWKS keys. |

**Function (dynamic key resolution):**

    keys: async function (decoded) {

        // decoded contains the token header and payload (unverified)
        // Return a key object based on the token content
        return { key: await lookupKey(decoded.header.kid) };
    }


### Verify Options


The `verify` object controls JWT payload claim verification after signature validation. (`lib/index.js`)

| Option | Type | Default | Description |
|---|---|---|---|
| `aud` | `string \| string[] \| false` | -- | Required audience (`aud` claim). Set to `false` to skip audience verification. |
| `iss` | `string \| string[] \| false` | -- | Required issuer (`iss` claim). Set to `false` to skip issuer verification. |
| `sub` | `string \| false` | -- | Required subject (`sub` claim). Set to `false` to skip subject verification. |
| `nbf` | `boolean` | `true` | Verify the `nbf` (not before) claim. |
| `exp` | `boolean` | `true` | Verify the `exp` (expiration) claim. |
| `maxAgeSec` | `number` | `0` | Maximum allowed token age in seconds (based on `iat` claim). `0` disables. |
| `timeSkewSec` | `number` | `0` | Allowed clock skew in seconds for `nbf`, `exp`, and `maxAgeSec` checks. |

    verify: {
        aud: 'urn:audience:my-app',
        iss: 'urn:issuer:my-auth-server',
        sub: false,
        nbf: true,
        exp: true,
        maxAgeSec: 14400,       // 4 hours
        timeSkewSec: 15         // 15 second clock tolerance
    }

Set `verify: false` to skip all verification (both signature and payload claims). When `verify` is `false`, `keys` is not required. This is useful when you handle verification in the `validate` function.


### Token Extraction


@hapi/jwt extracts the JWT from one of two sources, depending on strategy configuration: (lib/plugin.js:246-257)

1. **Cookie** -- if `cookieName` is set, the token is read from the named cookie
2. **Request header** -- reads from the `headerName` header (default `'authorization'`), stripping the `httpAuthScheme` prefix (default `'Bearer'`)

These are mutually exclusive: if `cookieName` is configured, header extraction is not used. Query parameter and custom function extraction are not supported.


### How the Auth Flow Works


The full authentication flow within hapi's [lifecycle](../lifecycle/overview.md):

1. Token is extracted from the request (header or cookie)
2. Token is decoded (base64url parsing of header, payload, signature)
3. Signature is verified against the configured `keys`
4. Payload claims are verified against the `verify` options (aud, iss, sub, exp, nbf, etc.)
5. The `validate` function is called with the decoded artifacts -- see [validate](validate.md)
6. If `validate` returns `{ isValid: true }`, the `credentials` and optional `artifacts` are set on `request.auth`

If any step fails, a [Boom.unauthorized](../lifecycle/boom.md#boomunauthorized----auth-specific-usage) error is returned with appropriate `WWW-Authenticate` headers.

**After successful auth, the route handler can access:**

    request.auth.isAuthenticated   // true
    request.auth.credentials       // from validate() return
    request.auth.artifacts         // decoded token + any custom artifacts
    request.auth.strategy          // strategy name used


### Cross-References


- [server auth](../server/auth.md) -- scheme, strategy, and default auth configuration
- [route auth](../route/auth.md) -- per-route auth settings (`mode`, `strategy`, `access`)
- [validate function](validate.md) -- the validate callback in detail
- [token API](token-api.md) -- standalone token generation, decoding, and verification
- [boom errors](../lifecycle/boom.md) -- HTTP error handling, especially `Boom.unauthorized`
- [lifecycle overview](../lifecycle/overview.md) -- where auth fits in the 24-step request flow
- [TypeScript auth schemes](../typescript/auth-scheme.md) -- typing auth credentials and artifacts


### Gotchas


- **Keys must be sufficiently long.** HMAC secrets (HS256/HS384/HS512) must meet minimum length requirements. HS256 requires at least 32 characters. Short keys will throw during strategy creation.
- **`verify: false` skips all verification.** Setting `verify` to `false` skips both signature and payload claim verification. The `keys` option is also not required when `verify` is `false`. The token is only decoded, not verified. (lib/plugin.js:118)
- **JWKS keys are cached.** When using a JWKS URI, keys are fetched and cached. If the auth server rotates keys, @hapi/jwt will re-fetch the JWKS when a token's `kid` is not found in the cache.
- **`validate` is always called.** Even after signature and claim verification succeed, the `validate` function runs. You must return `{ isValid: true }` or auth fails.
- **Multiple keys try sequentially.** When an array of keys is configured without `kid`, each key is tried in order. This can impact performance with many keys -- prefer using `kid` for key selection.
- **Token extraction order matters.** The Authorization header takes precedence. If a token exists in both the header and a cookie, the header token is used.
- **`artifacts` on `request.auth` vs validate artifacts.** `request.auth.artifacts` contains the decoded token by default. If your `validate` function returns custom `artifacts`, they replace the decoded token on `request.auth.artifacts`.
- **Clock skew.** Distributed systems often have clock differences. Use `timeSkewSec` in `verify` options to allow tolerance for `exp` and `nbf` checks. A common value is 15-60 seconds.
