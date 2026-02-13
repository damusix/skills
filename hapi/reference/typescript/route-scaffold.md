
## hapi Route Scaffold Skill


Use when writing typed hapi routes in application code.


### Basic Pattern


Every typed route uses `ServerRoute<Refs>` where `Refs` is a partial override of `ReqRefDefaults`:

```typescript
import { ServerRoute } from '@hapi/hapi';

const route: ServerRoute<{
    Params: { id: string };
    Query: { expand?: string };
    Payload: { name: string; email: string };
}> = {
    method: 'POST',
    path: '/users/{id}',
    handler: (request, h) => {

        const id: string = request.params.id;
        const expand: string | undefined = request.query.expand;
        const name: string = request.payload.name;
        return { id, name };
    }
};
```

Only include the Refs keys you need. Omitted keys keep their defaults.


### Available Refs Keys


| Key                    | Default                                           | When to Override                             |
| ---------------------- | ------------------------------------------------- | -------------------------------------------- |
| `Params`               | `Record<string, string>`                          | Always — match your path params              |
| `Query`                | `Record<string, string \| string[] \| undefined>` | When you have specific query params          |
| `Payload`              | `stream.Readable \| Buffer \| string \| object`   | When parsing JSON/form bodies                |
| `Headers`              | `Record<string, string \| string[] \| undefined>` | Rarely — only if checking specific headers   |
| `Pres`                 | `Record<string, any>`                             | When using pre-handlers with `assign`        |
| `RequestApp`           | `RequestApplicationState`                         | When using `request.app` with specific shape |
| `RouteApp`             | `RouteOptionsApp`                                 | When using `route.options.app`               |
| `AuthUser`             | `UserCredentials`                                 | Per-route auth user override                 |
| `AuthApp`              | `AppCredentials`                                  | Per-route auth app override                  |
| `AuthApi`              | `ServerAuthSchemeObjectApi`                       | When typing `server.auth.api[strategyName]`  |
| `AuthCredentialsExtra` | `Record<string, unknown>`                         | Extra credential properties                  |
| `AuthArtifactsExtra`   | `Record<string, unknown>`                         | Custom artifact shape                        |
| `Bind`                 | `object \| null`                                  | When using `this` in non-arrow handlers      |
| `Rules`                | `RouteRules`                                      | When using custom route rules                |
| `Server`               | `Server`                                          | When using typed `server.app`                |


### Params Are Always Strings


URL path parameters are strings at runtime (before Joi validation). The default `Record<string, string>` reflects this. Override with specific param names but keep values as `string`:

```typescript
// Good
{ Params: { id: string; slug: string } }

// Bad — params are strings before validation
{ Params: { id: number } }
```


### Pre-Handlers


When using `pre` with `assign`, provide the `Pres` key:

```typescript
interface MyRefs {
    Params: { id: string };
    Pres: { user: { name: string; email: string } };
}

const route: ServerRoute<MyRefs> = {
    method: 'GET',
    path: '/users/{id}',
    options: {
        pre: [
            {
                method: async (request, h) => {

                    return { name: 'Test', email: 'test@example.com' };
                },
                assign: 'user'
            }
        ],
        handler: (request, h) => {

            return request.pre.user;  // typed as { name: string; email: string }
        }
    }
};
```


### Typed Server App


To access a typed `server.app`, use the `Server` ref key:

```typescript
import { Server } from '@hapi/hapi';

interface AppSpace {
    db: DatabaseClient;
    config: AppConfig;
}

type MyServer = Server<AppSpace>;

const route: ServerRoute<{ Server: MyServer }> = {
    method: 'GET',
    path: '/',
    handler: (request, h) => {

        const db = request.server.app.db;  // typed
        return 'ok';
    }
};
```


### Handler as Options vs Top-Level


Both patterns work — handler can be top-level or inside `options`:

```typescript
// Top-level handler
const route: ServerRoute<Refs> = {
    method: 'GET',
    path: '/',
    handler: (request, h) => 'ok'
};

// Options handler
const route: ServerRoute<Refs> = {
    method: 'GET',
    path: '/',
    options: {
        handler: (request, h) => 'ok'
    }
};
```

Use `options` when you need auth, validation, pre-handlers, or other route config.


### Lifecycle Method Typing


The handler signature is `Lifecycle.Method<Refs>`:

```typescript
(this: MergeRefs<Refs>['Bind'], request: Request<Refs>, h: ResponseToolkit<Refs>, err?: Error) => Lifecycle.ReturnValue<Refs>
```

The `this` binding only works with `function` declarations, not arrow functions. Use `Bind` ref to type it:

```typescript
const route: ServerRoute<{ Bind: { greeting: string } }> = {
    method: 'GET',
    path: '/',
    options: {
        bind: { greeting: 'Hello' },
        handler: function (request, h) {

            return this.greeting;  // typed as string
        }
    }
};
```


### Route Arrays


`server.route()` accepts arrays. All routes in the array share the same Refs:

```typescript
server.route<{ Params: { id: string } }>([
    { method: 'GET', path: '/items/{id}', handler: getItem },
    { method: 'PUT', path: '/items/{id}', handler: updateItem },
    { method: 'DELETE', path: '/items/{id}', handler: deleteItem }
]);
```

If routes need different refs, register them separately.
