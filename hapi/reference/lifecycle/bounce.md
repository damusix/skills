## @hapi/bounce Error Filtering Reference


Bounce is a selective error rethrow utility -- **not a plugin**. It filters caught errors by type, letting you handle application errors while rethrowing system errors (or vice versa). This prevents accidentally swallowing `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`, and `URIError` when you only intended to catch operational errors.

    const Bounce = require('@hapi/bounce');

    try {
        await riskyOperation();
    }
    catch (err) {
        Bounce.ignore(err, 'boom');    // rethrows system errors, ignores Boom errors
    }

Bounce does **not** use `server.register()`. It is a standalone utility imported directly.


### Methods


**`Bounce.rethrow(err, types, [options])`** -- rethrows `err` if it matches any of `types`. Otherwise does nothing. (lib/index.js)

    try {
        await fetchFromDatabase();
    }
    catch (err) {
        Bounce.rethrow(err, 'system');   // rethrows system errors, ignores everything else
        return fallbackValue;
    }

**`Bounce.ignore(err, types, [options])`** -- ignores `err` if it matches any of `types`. Otherwise rethrows. This is the inverse of `rethrow`. (lib/index.js)

    try {
        await fetchFromDatabase();
    }
    catch (err) {
        Bounce.ignore(err, 'boom');    // ignores Boom errors, rethrows everything else
        return fallbackValue;
    }

**`Bounce.background(err, types, [options])`** -- same as `ignore` but designed for fire-and-forget async operations. Instead of rethrowing synchronously, it emits an unhandled rejection for non-matching errors. Use this in code paths where you cannot `await` and cannot `throw`. (lib/index.js)

    // Fire-and-forget: log the event, but don't swallow system errors
    async function logEvent(data) {

        try {
            await writeToLog(data);
        }
        catch (err) {
            Bounce.background(err, 'boom');   // Boom errors ignored; system errors become unhandled rejections
        }
    }

    // Called without await -- no catch possible at call site
    logEvent({ action: 'login' });


### Type Matching


The `types` parameter controls which errors match. It accepts a single value or an array of values:

| Type Value | Matches |
|---|---|
| `'system'` | The six JS system error types: `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`, `URIError` |
| `'boom'` | Any error where `err.isBoom === true` (see [boom errors](boom.md)) |
| A constructor function | Any error that is `instanceof` the given constructor |

**Examples:**

    // Match system errors
    Bounce.rethrow(err, 'system');

    // Match Boom errors
    Bounce.ignore(err, 'boom');

    // Match a specific error class
    Bounce.ignore(err, DatabaseError);

    // Match multiple types (array)
    Bounce.ignore(err, [DatabaseError, 'boom']);

    // Match system errors AND a custom class
    Bounce.rethrow(err, ['system', TimeoutError]);

The `options` parameter accepts:

| Option | Type | Default | Description |
|---|---|---|---|
| `return` | `any` | `undefined` | Value to return when `ignore()` or `rethrow()` does not throw. Useful for one-liner patterns. |


### Integration with Hapi


Bounce is commonly used inside hapi handlers, `ext` functions, server methods with `generateFunc`, and `pre` handlers -- anywhere you catch errors and need to distinguish between operational failures and programmer bugs.

**In a handler:**

    const handler = async function (request, h) {

        try {
            return await request.server.methods.fetchUser(request.params.id);
        }
        catch (err) {
            Bounce.ignore(err, 'boom');        // let Boom errors (404, etc.) propagate
            request.log(['error', 'db'], err);
            throw Boom.serverUnavailable('Database error');
        }
    };

**In a catbox `generateFunc`:**

    server.method('getUser', async (id) => {

        try {
            return await db.query('SELECT * FROM users WHERE id = $1', [id]);
        }
        catch (err) {
            Bounce.rethrow(err, 'system');   // never swallow TypeError, etc.
            return null;                      // treat DB errors as cache miss
        }
    }, {
        cache: { expiresIn: 60000, generateTimeout: 5000 }
    });

**In an `onPreHandler` extension:**

    server.ext('onPreHandler', async (request, h) => {

        try {
            await auditLog(request);
        }
        catch (err) {
            Bounce.rethrow(err, 'system');
            // Operational errors from audit logging are non-fatal
        }

        return h.continue;
    });

**Fire-and-forget with `background`:**

    const handler = async function (request, h) {

        // Don't await analytics -- but don't swallow system errors either
        trackAnalytics(request).catch((err) => Bounce.background(err, 'boom'));

        return { status: 'ok' };
    };


### Gotchas


- **Bounce is not a plugin.** Do not use `server.register()`. Import it directly: `const Bounce = require('@hapi/bounce')`.
- **`ignore` and `rethrow` are inverses.** `ignore(err, 'boom')` rethrows non-Boom errors. `rethrow(err, 'boom')` rethrows Boom errors. Mix them up and you will swallow system errors.
- **`'system'` does not include all built-in errors.** It matches only `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`, and `URIError`. Regular `Error` and custom subclasses of `Error` do not match `'system'`.
- **`background` creates unhandled rejections.** Non-matching errors are thrown inside a detached async function, producing an unhandled rejection. In Node.js, unhandled rejections terminate the process by default (Node 15+). This is intentional -- system errors in fire-and-forget paths should crash rather than be silently swallowed.
- **`'boom'` checks `err.isBoom`.** It does not use `instanceof Boom.Boom`. Any error with a truthy `isBoom` property matches, including manually decorated errors. See [boom errors](boom.md) for how `Boom.boomify()` sets this property.
- **Order matters in catch blocks.** Place `Bounce.rethrow(err, 'system')` as the first line in a catch block to guarantee system errors are never swallowed by subsequent handling logic.
- **Bounce does not catch errors.** It only filters already-caught errors. You still need a `try/catch` block (or `.catch()` callback). Bounce decides what to do with the error after you have caught it.
