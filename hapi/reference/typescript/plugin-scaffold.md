
## hapi Plugin Scaffold Skill


Use when creating typed hapi plugins.


### Basic Plugin


```typescript
import { Plugin, Server } from '@hapi/hapi';

interface MyPluginOptions {
    prefix: string;
    debug?: boolean;
}

const myPlugin: Plugin<MyPluginOptions> = {
    name: 'my-plugin',
    version: '1.0.0',
    register: async (server, options) => {

        // options is typed as MyPluginOptions
        server.route({
            method: 'GET',
            path: `${options.prefix}/status`,
            handler: () => ({ status: 'ok' })
        });
    }
};

// Register
await server.register({ plugin: myPlugin, options: { prefix: '/api' } });
```


### Plugin with Typed Decorations


The second generic parameter declares what the plugin exposes on the server:

```typescript
interface MyPluginDecorations {
    plugins: {
        'my-plugin': {
            add(a: number, b: number): number;
            version: string;
        };
    };
}

const myPlugin: Plugin<MyPluginOptions, MyPluginDecorations> = {
    name: 'my-plugin',
    version: '1.0.0',
    register: async (server, options) => {

        server.expose('add', (a: number, b: number) => a + b);
        server.expose('version', '1.0.0');
    }
};

// register() returns server with typed plugins
const loaded = await server.register({
    plugin: myPlugin,
    options: { prefix: '/api' }
});

const sum: number = loaded.plugins['my-plugin'].add(1, 2);
```


### Plugin Naming


Two forms — name/version directly or via `pkg`:

```typescript
// Direct
const plugin: Plugin<Options> = {
    name: 'my-plugin',
    version: '1.0.0',
    register: async (server, options) => { ... }
};

// Via package.json
const plugin: Plugin<Options> = {
    pkg: require('./package.json'),
    register: async (server, options) => { ... }
};
```


### Plugin Properties


| Property       | Required | Description                                           |
| -------------- | -------- | ----------------------------------------------------- |
| `name`         | Yes*     | Unique plugin name                                    |
| `version`      | No       | Plugin version string                                 |
| `pkg`          | Yes*     | Alternative to name/version via package.json          |
| `register`     | Yes      | `async (server, options) => void`                     |
| `multiple`     | No       | If `true`, allow multiple registrations               |
| `once`         | No       | If `true`, skip duplicate registrations silently      |
| `dependencies` | No       | Required plugins (string, string[], or version map)   |
| `requirements` | No       | `{ node?: string; hapi?: string }` semver constraints |

*Either `name` or `pkg` is required, not both.


### Registration Options


```typescript
await server.register(plugin, {
    once: true,                           // skip if already registered
    routes: {
        prefix: '/api',                   // prefix all plugin routes
        vhost: 'api.example.com'          // restrict to virtual host
    }
});
```


### ServerRegisterPluginObject


Wrap plugin + options for typed registration:

```typescript
import { ServerRegisterPluginObject } from '@hapi/hapi';

const registration: ServerRegisterPluginObject<MyPluginOptions, MyPluginDecorations> = {
    plugin: myPlugin,
    options: { prefix: '/api', debug: true },
    routes: { prefix: '/v1' }
};

const loaded = await server.register(registration);
```


### Plugin Dependencies


```typescript
const plugin: Plugin<Options> = {
    name: 'my-plugin',
    dependencies: ['other-plugin', 'auth-plugin'],
    register: async (server, options) => {

        // or declare dependencies dynamically
        server.dependency(['another-plugin'], async (srv) => {

            // called after all dependencies are registered, before server starts
        });
    }
};
```


### Exposing Data


```typescript
// Key-value (preferred for functions, singletons)
server.expose('helper', myHelperFunction);

// Object merge (deep clones — avoid for large objects)
server.expose({ helper: myHelperFunction, version: '1.0.0' });
```


### Accessing Plugin State


```typescript
// From server
server.plugins['my-plugin'].helper();

// From request (plugin-specific request state)
request.plugins['my-plugin'] = { requestStartTime: Date.now() };
```


### Module Augmentation for Plugins


For full type safety across the application, augment the relevant interfaces:

```typescript
declare module '@hapi/hapi' {
    interface PluginProperties {
        'my-plugin': {
            add(a: number, b: number): number;
        };
    }

    interface PluginsStates {
        'my-plugin': {
            requestStartTime: number;
        };
    }
}
```


### Plugin with Server Decorations


```typescript
declare module '@hapi/hapi' {
    interface Server {
        myHelper(): string;
    }
}

const plugin: Plugin<void> = {
    name: 'my-plugin',
    register: async (server) => {

        server.decorate('server', 'myHelper', function (this: Server) {

            return 'hello from plugin';
        });
    }
};
```
