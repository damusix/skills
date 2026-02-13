
## hapi Auth Scheme Typing Skill


Use when implementing or wiring up authentication with TypeScript.


### Three-Layer Auth Type System


1. **Global interfaces** (module augmentation) — `UserCredentials`, `AppCredentials`
2. **Global defaults** (ReqRefDefaults augmentation) — `AuthCredentialsExtra`, `AuthArtifactsExtra`
3. **Per-route refs** — `AuthUser`, `AuthApp`, `AuthCredentialsExtra`, `AuthArtifactsExtra` in route generic


### Layer 1: Global Credentials


Augment to define your app's user/app credential shapes everywhere:

```typescript
declare module '@hapi/hapi' {
    interface UserCredentials {
        id: string;
        name: string;
        email: string;
        roles: string[];
    }

    interface AppCredentials {
        clientId: string;
        clientName: string;
    }
}
```

Now `request.auth.credentials.user` is `UserCredentials` and `request.auth.credentials.app` is `AppCredentials` on all routes.


### Layer 2: Global Credential Extras


Augment `ReqRefDefaults` for properties your auth scheme always sets:

```typescript
declare module '@hapi/hapi' {
    interface ReqRefDefaults {
        AuthCredentialsExtra: Partial<{
            sessionId: string;
            token: string;
        }>;
    }
}
```

Now ALL routes (including generic `Request` and `Request<Refs>`) see `credentials.sessionId` and `credentials.token`.


### Layer 3: Per-Route Overrides


For routes with specific auth requirements:

```typescript
interface AdminRouteRefs {
    AuthUser: { id: string; name: string; email: string; isAdmin: true };
    AuthCredentialsExtra: { adminToken: string };
    AuthArtifactsExtra: { loginTimestamp: number };
}

const route: ServerRoute<AdminRouteRefs> = {
    method: 'GET',
    path: '/admin',
    handler: (request, h) => {

        const adminToken: string = request.auth.credentials.adminToken;
        const isAdmin: true = request.auth.credentials.user!.isAdmin;
        const loginTs: number = request.auth.artifacts.loginTimestamp;
        return 'ok';
    }
};
```


### How Credentials Resolve


```
request.auth.credentials =
    AuthCredentials<AuthUser, AuthApp> & CredentialsExtra
    = {
        scope?: string[];
        user?: AuthUser;       // from UserCredentials or refs AuthUser
        app?: AuthApp;         // from AppCredentials or refs AuthApp
    } & CredentialsExtra       // from ReqRefDefaults or refs AuthCredentialsExtra

request.auth.artifacts = ArtifactsExtra  // from ReqRefDefaults or refs AuthArtifactsExtra
```


### Implementing an Auth Scheme


```typescript
import { ServerAuthScheme, Request, ResponseToolkit, Lifecycle } from '@hapi/hapi';

interface JwtSchemeOptions {
    secret: string;
    algorithm?: string;
}

const jwtScheme: ServerAuthScheme<JwtSchemeOptions> = (server, options) => {

    return {
        authenticate: async (request, h) => {

            const token = request.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                throw Boom.unauthorized('Missing token');
            }

            const decoded = verify(token, options!.secret);

            return h.authenticated({
                credentials: {
                    user: {
                        id: decoded.sub,
                        name: decoded.name,
                        email: decoded.email,
                        roles: decoded.roles
                    },
                    scope: decoded.scope
                },
                artifacts: { raw: token }
            });
        }
    };
};

// Register
server.auth.scheme('jwt', jwtScheme);
server.auth.strategy('default', 'jwt', { secret: 'my-secret' });
server.auth.default('default');
```


### Typing Strategy and Scope Names


Augment `RouteOptionTypes` to narrow `strategy` and `scope` to specific string unions:

```typescript
declare module '@hapi/hapi' {
    interface RouteOptionTypes {
        Strategy: 'jwt' | 'basic' | 'session';
        Scope: 'admin' | 'user' | 'readonly';
    }
}

// Now route auth config is type-checked:
const route: ServerRoute = {
    method: 'GET',
    path: '/',
    options: {
        auth: {
            strategy: 'jwt',     // only 'jwt' | 'basic' | 'session' allowed
            scope: 'admin'       // only 'admin' | 'user' | 'readonly' allowed
        },
        handler: (request, h) => 'ok'
    }
};
```


### Auth in ResponseToolkit


`h.authenticated()` and `h.unauthenticated()` are typed with the same auth generics:

```typescript
// h.authenticated() accepts AuthenticationData<AuthUser, AuthApp, CredentialsExtra, ArtifactsExtra>
return h.authenticated({
    credentials: {
        user: { id: '1', name: 'Test', email: 'test@test.com', roles: ['user'] },
        scope: ['user']
    },
    artifacts: { token: rawToken }
});

// h.unauthenticated() for failed auth with optional credentials
return h.unauthenticated(
    Boom.unauthorized('Expired token'),
    {
        credentials: {
            user: { id: '1', name: 'Test', email: 'test@test.com', roles: [] }
        }
    }
);
```


### Auth Scheme Object


The scheme factory returns `ServerAuthSchemeObject<Refs>`:

| Method            | Required | Signature                                      |
| ----------------- | -------- | ---------------------------------------------- |
| `authenticate`    | Yes      | `(request, h) => Lifecycle.ReturnValue`        |
| `payload`         | No       | `(request, h) => Lifecycle.ReturnValue`        |
| `response`        | No       | `(request, h) => Lifecycle.ReturnValue`        |
| `verify`          | No       | `(auth: RequestAuth) => Promise<void>`         |
| `api`             | No       | Exposed via `server.auth.api[strategyName]`    |
| `options.payload` | No       | If `true`, requires payload auth on all routes |


### server.auth Methods


```typescript
// Set default auth for all routes
server.auth.default('jwt');
server.auth.default({ strategy: 'jwt', mode: 'optional' });

// Test credentials against a strategy (without route config)
const { credentials, artifacts } = await server.auth.test('jwt', request);

// Verify existing auth is still valid
await server.auth.verify(request);
```
