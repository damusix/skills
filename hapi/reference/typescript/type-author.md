
## hapi Type Author Skill


Use when modifying hapi's internal `.d.ts` type definitions in `lib/types/`.


### Architecture


The type system centers on the **ReqRef/MergeRefs** pattern:

- `InternalRequestDefaults` — defines all 15 customizable keys with default types
- `ReqRefDefaults extends InternalRequestDefaults` — user-augmentable interface
- `ReqRef = Partial<Record<keyof ReqRefDefaults, unknown>>` — the constraint for route-level overrides
- `MergeType<T, U> = Omit<T, keyof U> & U` — merge utility
- `MergeRefs<T extends ReqRef> = MergeType<ReqRefDefaults, T>` — resolves defaults + overrides


### Critical Rule


**Always use `MergeRefs<Refs>['Key']`, never `Refs['Key']` directly.**

`Refs` is `Partial<Record<..., unknown>>`, so `Refs['Pres']` is `unknown` when the user doesn't provide it. `MergeRefs<Refs>['Pres']` correctly falls through to the default `Record<string, any>`.

Bad:

```typescript
// route.d.ts — WRONG
assign?: keyof Refs['Pres'] | undefined;  // keyof unknown = never
```

Good:

```typescript
// route.d.ts — CORRECT
assign?: keyof MergeRefs<Refs>['Pres'] | undefined;  // keyof Record<string, any> = string
```


### File Map


| File                             | Contains                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/types/request.d.ts`         | `InternalRequestDefaults`, `ReqRefDefaults`, `ReqRef`, `MergeRefs`, `MergeType`, `Request`, `RequestAuth`, `AuthCredentials`, `UserCredentials`, `AppCredentials` |
| `lib/types/route.d.ts`           | `ServerRoute`, `RouteOptions`, `CommonRouteProperties`, `RouteOptionsPreObject`, `RouteOptionsAccess`, `RouteOptionTypes`                                         |
| `lib/types/utils.d.ts`           | `Lifecycle.Method`, `Lifecycle.ReturnValue`, `Lifecycle.FailAction`, `HTTP_METHODS`, `Json` namespace                                                             |
| `lib/types/response.d.ts`        | `ResponseToolkit`, `ResponseObject`, `Auth`, `AuthenticationData`                                                                                                 |
| `lib/types/server/server.d.ts`   | `Server` class, `server()` factory, `decorate()` overloads, reserved keys                                                                                         |
| `lib/types/server/methods.d.ts`  | `ServerMethods`, `CachedServerMethod`, `ServerMethodOptions`                                                                                                      |
| `lib/types/server/auth.d.ts`     | `ServerAuth`, `ServerAuthScheme`, `ServerAuthSchemeObject`                                                                                                        |
| `lib/types/server/ext.d.ts`      | Extension point types                                                                                                                                             |
| `lib/types/server/events.d.ts`   | Server event types                                                                                                                                                |
| `lib/types/server/cache.d.ts`    | Cache types                                                                                                                                                       |
| `lib/types/server/inject.d.ts`   | `ServerInjectOptions`, `ServerInjectResponse`                                                                                                                     |
| `lib/types/server/options.d.ts`  | `ServerOptions`                                                                                                                                                   |
| `lib/types/server/state.d.ts`    | Cookie/state types                                                                                                                                                |
| `lib/types/server/info.d.ts`     | `ServerInfo`                                                                                                                                                      |
| `lib/types/server/encoders.d.ts` | `ContentDecoders`, `ContentEncoders`                                                                                                                              |
| `lib/types/plugin.d.ts`          | `Plugin`, `PluginBase`, `ServerRegisterPluginObject`, `ServerRealm`                                                                                               |
| `test/types/index.ts`            | Type tests — every type change must have a test here                                                                                                              |


### Auth Type Resolution


`request.auth` is `RequestAuth<AuthUser, AuthApp, CredentialsExtra, ArtifactsExtra>` where all four generics come from `MergeRefs<Refs>`:

```
credentials = AuthCredentials<AuthUser, AuthApp> & CredentialsExtra
            = { scope?, user?: AuthUser, app?: AuthApp } & CredentialsExtra

artifacts = ArtifactsExtra
```

The `AuthCredentials` interface provides the structural `.scope`, `.user`, `.app` properties. `CredentialsExtra` adds arbitrary top-level properties. Both `UserCredentials` and `AppCredentials` are globally augmentable empty interfaces.


### Invariance Constraint


`Request<Refs>` is invariant in `Refs` because the generic appears in both covariant (property types) and contravariant (lifecycle method parameters) positions. This means `Request<{ Params: { id: string } }>` is NOT assignable to `Request<ReqRefDefaults>`.

This is a known TypeScript limitation. Do not try to "fix" it — the correct workaround is generic helper functions: `function helper<Refs extends ReqRef>(req: Request<Refs>)`.


### Test Patterns


The test file at `test/types/index.ts` uses `@hapi/lab`'s type checking utilities:

```typescript
import { types as lab } from '@hapi/lab';
const { expect: check } = lab;

// Assert a value has a specific type
check.type<string>(request.params.id);

// Assert an expression causes a type error
// @ts-expect-error Lab does not support overload errors
check.error(() => server.decorate('request', 'payload', fn));
```

The `IsAny<T>` helper detects `any` leakage:

```typescript
type IsAny<T> = (
    unknown extends T
        ? [keyof T] extends [never] ? false : true
        : false
);

const isAny: IsAny<typeof value> = false;  // fails to compile if value is `any`
```


### Verification Command


Always run after type changes:

```bash
npx tsc --noEmit test/types/index.ts --strict --esModuleInterop --moduleResolution node --target es2022 --module es2022
```


### Checklist for Type Changes


1. Use `MergeRefs<Refs>['Key']` everywhere, never raw `Refs['Key']`
2. Add test cases to `test/types/index.ts` for new/changed behavior
3. Test both the default case (`ServerRoute` with no generic) and the override case (`ServerRoute<{ Key: CustomType }>`)
4. Verify `any` doesn't leak using `IsAny<T>` checks
5. Verify the `@ts-expect-error` tests for known limitation cases
6. Run the tsc verification command
