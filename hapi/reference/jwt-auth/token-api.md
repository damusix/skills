## @hapi/jwt Token Utility API Reference


The `Jwt.token` namespace provides standalone utilities for generating, decoding, and verifying JWTs **without** requiring a hapi server. These are pure functions you can use anywhere -- in scripts, microservices, testing, or alongside the hapi auth scheme.

    const Jwt = require('@hapi/jwt');

    // Generate
    const token = Jwt.token.generate(
        { user: 'john', scope: ['admin'] },
        'a-secret-key-with-at-least-32-chars!!'
    );

    // Decode
    const decoded = Jwt.token.decode(token);

    // Verify
    Jwt.token.verify(decoded, 'a-secret-key-with-at-least-32-chars!!');


### Jwt.token.generate(payload, secret, [options])


Creates a signed JWT string. (`lib/token.js`)

    const token = Jwt.token.generate(payload, secret, options);

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `payload` | `object` | The JWT payload. Can contain any claims (registered or custom). |
| `secret` | `string \| Buffer \| object` | The signing secret or key. See [Secret Formats](#secret-formats). |
| `options` | `object` | Optional. Additional token options. |

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | `object` | `{ alg: 'HS256', typ: 'JWT' }` | Custom JWT header fields. Merged with defaults. Use to set `kid`, override `alg`, or add custom header claims. |
| `now` | `number` | `Date.now()` | Override the current timestamp (in milliseconds). Used for calculating `iat`. |
| `ttlSec` | `number` | `0` | Token time-to-live in seconds. When set, automatically adds `exp` claim based on `iat + ttlSec`. `0` means no expiration is added. |
| `iat` | `boolean` | `true` | Whether to include `iat` (issued at) claim automatically. Set to `false` to omit. Only auto-generated when `payload.iat` is `undefined`. (lib/token.js:30-35) |
| `typ` | `string` | `'JWT'` | The `typ` header field value. Set to override the default `'JWT'` type. (lib/token.js:44-46) |
| `headless` | `string` | -- | When set, omits the header from the generated token string. The value is used during decoding to reconstruct the header. (lib/token.js:52-55) |

**Secret Formats:**

| Format | Description |
|---|---|
| `string` | HMAC shared secret. Must meet minimum length for the algorithm (32 chars for HS256). |
| `Buffer` | Binary key data. |
| `{ key, algorithm }` | Object with explicit key and algorithm. `algorithm` overrides the header `alg`. |

**Examples:**

    // Simple HMAC token
    const token = Jwt.token.generate(
        { sub: 'user-123', scope: ['read'] },
        'a-secret-key-with-at-least-32-chars!!'
    );

    // With expiration and custom header
    const token = Jwt.token.generate(
        {
            sub: 'user-123',
            aud: 'urn:audience:my-app',
            iss: 'urn:issuer:my-auth'
        },
        { key: 'a-secret-key-with-at-least-32-chars!!', algorithm: 'HS256' },
        {
            ttlSec: 3600,                           // 1 hour
            header: { kid: 'key-2024-01' }
        }
    );

    // RSA signing
    const token = Jwt.token.generate(
        { sub: 'user-123' },
        { key: privateKeyPem, algorithm: 'RS256' }
    );

    // Without iat claim
    const token = Jwt.token.generate(
        { sub: 'user-123', customClaim: 'value' },
        'a-secret-key-with-at-least-32-chars!!',
        { iat: false }
    );


### Jwt.token.decode(token)


Decodes a JWT string into its parts **without** verifying the signature. (`lib/token.js`)

    const decoded = Jwt.token.decode(token);

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `token` | `string` | A JWT string (three base64url-encoded segments separated by dots). |

**Returns:**

    {
        token: 'the.original.jwt-string',
        decoded: {
            header: { alg: 'HS256', typ: 'JWT' },
            payload: { sub: 'user-123', iat: 1609459200, exp: 1609462800 },
            signature: 'base64url-encoded-signature'
        }
    }

| Property | Description |
|---|---|
| `token` | The original JWT string. |
| `decoded.header` | Parsed JWT header (algorithm, type, kid, etc.). |
| `decoded.payload` | Parsed JWT payload (all claims). |
| `decoded.signature` | The raw base64url signature string. |

**Throws** a [Boom](../lifecycle/boom.md) error if the token string is malformed (wrong number of segments, invalid base64url, invalid JSON).

    // Inspect token contents for debugging
    const { decoded } = Jwt.token.decode(token);
    console.log(decoded.header.alg);        // 'HS256'
    console.log(decoded.payload.sub);        // 'user-123'
    console.log(decoded.payload.exp);        // 1609462800


### Jwt.token.verify(decoded, secret, [options])


Verifies a decoded token's signature **and** payload claims. This is the full verification pipeline. (`lib/token.js`)

    Jwt.token.verify(decoded, secret, options);

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `decoded` | `object` | The object returned by `Jwt.token.decode()`. |
| `secret` | `string \| Buffer \| object` | The verification key. Same formats as `generate()`. |
| `options` | `object` | Verification options for payload claims. |

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `aud` | `string \| string[] \| false` | -- | Expected audience. `false` to skip. |
| `iss` | `string \| string[] \| false` | -- | Expected issuer. `false` to skip. |
| `sub` | `string \| false` | -- | Expected subject. `false` to skip. |
| `nbf` | `boolean` | `true` | Verify not-before claim. |
| `exp` | `boolean` | `true` | Verify expiration claim. |
| `maxAgeSec` | `number` | `0` | Maximum token age in seconds. |
| `timeSkewSec` | `number` | `0` | Allowed clock skew in seconds. |
| `now` | `number` | `Date.now()` | Override current time (milliseconds) for time-based checks. |
| `jti` | `string` | -- | Expected JWT ID (`jti` claim). (lib/token.js:156) |
| `nonce` | `string` | -- | Expected nonce claim. (lib/token.js:157) |

**Throws** a [Boom.unauthorized](../lifecycle/boom.md) error if verification fails (bad signature, expired, wrong audience, etc.).

    const decoded = Jwt.token.decode(token);

    try {
        Jwt.token.verify(decoded, 'a-secret-key-with-at-least-32-chars!!', {
            aud: 'urn:audience:my-app',
            iss: 'urn:issuer:my-auth',
            sub: false,
            maxAgeSec: 14400,
            timeSkewSec: 15
        });
    }
    catch (err) {
        // err is a Boom.unauthorized error
        console.log(err.message);      // e.g., 'Token expired'
    }


### Jwt.token.verifySignature(decoded, secret)


Verifies **only** the token signature, without checking any payload claims. (`lib/token.js`)

    Jwt.token.verifySignature(decoded, secret);

| Parameter | Type | Description |
|---|---|---|
| `decoded` | `object` | The object returned by `Jwt.token.decode()`. |
| `secret` | `string \| Buffer \| object` | The verification key. |

**Throws** a [Boom.unauthorized](../lifecycle/boom.md) error if the signature does not match.

    const decoded = Jwt.token.decode(token);
    Jwt.token.verifySignature(decoded, 'a-secret-key-with-at-least-32-chars!!');
    // No error = signature is valid


### Jwt.token.verifyPayload(decoded, [options])


Verifies the payload claims (aud, iss, sub, jti, nonce) and time-based claims (exp, nbf, maxAgeSec) without checking the signature. (`lib/token.js:138-171`)

    Jwt.token.verifyPayload(decoded, options);

| Parameter | Type | Description |
|---|---|---|
| `decoded` | `object` | The object returned by `Jwt.token.decode()`. |
| `options` | `object` | Claim verification options: `aud`, `iss`, `sub`, `jti`, `nonce`, `exp`, `nbf`, `maxAgeSec`, `timeSkewSec`, `now`. |

**Throws** if required claims do not match or time-based claims fail.

    const decoded = Jwt.token.decode(token);
    Jwt.token.verifyPayload(decoded, {
        aud: 'urn:audience:my-app',
        iss: 'urn:issuer:my-auth',
        sub: false,
        exp: true,
        nbf: true
    });


### Jwt.token.verifyTime(decoded, [options])


Verifies **only** the time-based claims (`exp`, `nbf`, `maxAgeSec`) without checking signature or identity claims. (`lib/token.js`)

    Jwt.token.verifyTime(decoded, options);

| Parameter | Type | Description |
|---|---|---|
| `decoded` | `object` | The object returned by `Jwt.token.decode()`. |
| `options` | `object` | Time verification options. |

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `nbf` | `boolean` | `true` | Verify not-before claim. |
| `exp` | `boolean` | `true` | Verify expiration claim. |
| `maxAgeSec` | `number` | `0` | Maximum token age in seconds based on `iat`. |
| `timeSkewSec` | `number` | `0` | Clock skew tolerance in seconds. |
| `now` | `number` | `Date.now()` | Override current time (milliseconds). |

**Throws** if any time check fails.

    const decoded = Jwt.token.decode(token);
    Jwt.token.verifyTime(decoded, {
        exp: true,
        nbf: true,
        timeSkewSec: 30
    });


### Composing Verification Steps


The granular verify functions let you compose custom verification pipelines:

    const decoded = Jwt.token.decode(token);

    // Step 1: Check signature only
    Jwt.token.verifySignature(decoded, secret);

    // Step 2: Check payload claims
    Jwt.token.verifyPayload(decoded, { aud: 'my-app', iss: false, sub: false });

    // Step 3: Custom time check with overridden "now"
    Jwt.token.verifyTime(decoded, { exp: true, now: someTimestamp });

This is equivalent to calling `Jwt.token.verify()` but gives you control over the order and error handling of each step.


### Common Patterns


**Generate and verify in tests:**

    const Jwt = require('@hapi/jwt');

    const secret = 'test-secret-with-at-least-32-chars!!';

    // Generate a token for test requests
    const token = Jwt.token.generate(
        { sub: 'test-user', scope: ['admin'] },
        secret,
        { ttlSec: 60 }
    );

    // Inject with the token
    const res = await server.inject({
        method: 'GET',
        url: '/protected',
        headers: {
            authorization: `Bearer ${token}`
        }
    });

**Decode without verification (debugging/logging):**

    // Safe to use on untrusted tokens -- no verification happens
    const { decoded } = Jwt.token.decode(untrustedToken);
    console.log('Token issuer:', decoded.payload.iss);
    console.log('Token expires:', new Date(decoded.payload.exp * 1000));

**Token refresh pattern:**

    const oldDecoded = Jwt.token.decode(oldToken);

    // Verify old token is structurally valid (may be expired)
    Jwt.token.verifySignature(oldDecoded, secret);

    // Issue new token with fresh expiration
    const newToken = Jwt.token.generate(
        {
            sub: oldDecoded.decoded.payload.sub,
            scope: oldDecoded.decoded.payload.scope
        },
        secret,
        { ttlSec: 3600 }
    );


### Cross-References


- [overview](overview.md) -- registering @hapi/jwt and configuring strategies
- [validate](validate.md) -- the validate callback receives the same `artifacts` structure as `decode()` output
- [server auth](../server/auth.md) -- hapi's auth system architecture
- [boom errors](../lifecycle/boom.md) -- all token verify/decode errors are Boom.unauthorized
- [network / server.inject](../server/network.md) -- testing protected routes with generated tokens


### Gotchas


- **`decode()` does NOT verify.** Decoding only parses the base64url segments. Never trust decoded payload data without calling `verify()` or `verifySignature()`.
- **`generate()` with `ttlSec` only adds `exp` when missing.** If your payload already has an `exp` claim, `ttlSec` is ignored. `exp` is only auto-generated when `payload.exp === undefined`. (lib/token.js:37-42)
- **`generate()` adds `iat` only when missing.** Set `iat: false` in options to suppress entirely. If your payload already contains `iat`, the existing value is preserved. Auto-generation only occurs when `payload.iat === undefined`. (lib/token.js:30-35)
- **Secret minimum lengths.** HS256 requires 32-character secrets, HS384 requires 48, HS512 requires 64. `generate()` and `verify()` will throw if the key is too short.
- **`verify()` throws, it does not return a boolean.** All verify functions throw Boom errors on failure. Wrap in try/catch if you need boolean-style checking.
- **`now` option is in milliseconds.** The `now` override in verify options uses milliseconds (like `Date.now()`), but JWT `exp`/`nbf`/`iat` claims use seconds. The library handles the conversion internally.
- **RSA/EC keys need the `algorithm` field.** When using asymmetric keys, pass `{ key: pemString, algorithm: 'RS256' }` as the secret. A bare PEM string defaults to HMAC and will fail.
