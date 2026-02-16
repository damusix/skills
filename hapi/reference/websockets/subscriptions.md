## @hapi/nes Subscriptions Reference


Nes subscriptions provide real-time publish/subscribe channels over WebSocket. The server declares named subscription paths, clients subscribe to them, and the server publishes messages that are delivered to all matching subscribers.

    // Server -- declare a channel
    server.subscription('/items/{id}');

    // Server -- publish an update
    server.publish('/items/42', { action: 'updated', data: { name: 'Widget' } });

    // Client -- subscribe
    await client.subscribe('/items/42', (update) => {

        console.log(update);  // { action: 'updated', data: { name: 'Widget' } }
    });


### server.subscription(path, [options])


Declares a subscription channel. Must be called before `server.start()`. The path can include hapi-style parameters. (lib/listener.js)

    server.subscription('/orders/{id}', {
        filter: (path, message, options) => {

            return message.role === options.credentials.role;
        },
        auth: {
            mode: 'required',
            entity: 'user'
        },
        onSubscribe: (socket, path, params) => {

            console.log(`${socket.id} subscribed to ${path}`);
        },
        onUnsubscribe: (socket, path, params) => {

            console.log(`${socket.id} unsubscribed from ${path}`);
        }
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `filter` | `function` | -- | Controls which subscribers receive a published message. Signature: `async function (path, message, options)`. Must return `true` to send, `false` to skip. |
| `auth` | `object \| false` | server default | Auth configuration for subscription access. Set to `false` to disable auth for this channel. |
| `auth.mode` | `string` | `'required'` | `'required'` or `'optional'`. (lib/listener.js:212) |
| `auth.scope` | `string \| array` | -- | Required auth scope(s) for subscribing. |
| `auth.entity` | `string` | -- | Required auth entity: `'user'` or `'app'`. |
| `auth.index` | `boolean` | -- | When `true`, enables per-subscription user indexing for targeted publishing. (lib/listener.js:215) |
| `onSubscribe` | `function` | -- | Called when a client subscribes. Signature: `async function (socket, path, params)`. Throw to reject the subscription. |
| `onUnsubscribe` | `function` | -- | Called when a client unsubscribes or disconnects. Signature: `function (socket, path, params)`. |

**Path parameters:**

Subscription paths support hapi-style parameters. When a client subscribes to `/orders/42`, the `{id}` parameter is `'42'`. The `params` argument in `onSubscribe`/`onUnsubscribe` contains parsed parameters.

    server.subscription('/chat/{room}');

    // Client subscribes to /chat/general
    // onSubscribe receives params = { room: 'general' }


### server.publish(path, message, [options])


Publishes a message to all clients subscribed to the given path. (lib/listener.js)

    server.publish('/items/42', { action: 'deleted' });

    // With internal options
    server.publish('/items/42', { action: 'updated' }, { internal: { source: 'admin' } });

| Parameter | Type | Description |
|---|---|---|
| `path` | `string` | The subscription path (with actual parameter values, not templates). |
| `message` | `any` | The message to send. Must be JSON-serializable. |
| `options` | `object` | Optional. |
| `options.internal` | `any` | Data passed to the `filter` function via `options.internal` but not sent to the client. Useful for filter decisions. |
| `options.user` | `string` | When provided, the message is only sent to authenticated subscribers with matching `credentials.user`. Requires the subscription's `auth.index` to be `true`. |

The `internal` option is the key mechanism for passing server-side context to filter functions without exposing it to clients:

    server.subscription('/notifications/{userId}', {
        filter: (path, message, options) => {

            // options.internal is available here
            // options.credentials has the subscriber's auth credentials
            return options.credentials.id === options.internal.targetUserId;
        }
    });

    server.publish('/notifications/all', { text: 'Hello' }, {
        internal: { targetUserId: '42' }
    });


### server.broadcast(message, [options])


Sends a message to every connected WebSocket client, regardless of subscriptions. (lib/listener.js)

    server.broadcast({ type: 'maintenance', message: 'Server restarting in 5 minutes' });

| Parameter | Type | Description |
|---|---|---|
| `message` | `any` | The message to broadcast. Must be JSON-serializable. |
| `options` | `object` | Optional. |
| `options.user` | `string` | When provided, broadcasts only to authenticated sockets matching this user identifier. Requires `auth.index: true` in plugin options. |

    // Broadcast to a specific user (requires auth.index: true)
    server.broadcast({ type: 'alert', text: 'Your session expires soon' }, { user: 'john' });


### server.eachSocket(each, [options])


Iterates over connected sockets. (lib/listener.js)

    await server.eachSocket((socket) => {

        socket.send({ type: 'ping' });
    }, { subscription: '/chat/general' });

| Option | Type | Description |
|---|---|---|
| `subscription` | `string` | Limit iteration to sockets subscribed to this path. |
| `user` | `string` | Limit iteration to sockets authenticated as this user. Requires `auth.index: true`. |


### Subscription Auth


Auth on subscriptions follows the same scheme/strategy model as hapi route auth. The client must be authenticated on the WebSocket connection, and their credentials must satisfy the subscription's auth requirements.

    server.subscription('/admin/events', {
        auth: {
            mode: 'required',
            scope: 'admin'
        }
    });

    // Client without 'admin' scope will receive an error when subscribing

When `auth` is `false`, any connected client can subscribe -- even unauthenticated ones:

    server.subscription('/public/feed', {
        auth: false
    });


### Filter Functions


Filters run on every `server.publish()` call, once per subscriber. They determine whether a specific subscriber should receive the message. (lib/listener.js)

    server.subscription('/orders/{id}', {
        filter: async (path, message, options) => {

            // path: '/orders/42' (the actual subscribed path)
            // message: the published message object
            // options.credentials: subscriber's auth credentials
            // options.params: parsed path parameters { id: '42' }
            // options.internal: data from publish options.internal

            const order = await getOrder(options.params.id);
            return order.ownerId === options.credentials.id;
        }
    });

Filter function parameters:

| Parameter | Type | Description |
|---|---|---|
| `path` | `string` | The actual subscription path the client subscribed to. |
| `message` | `any` | The published message. |
| `options.credentials` | `object` | The subscriber's auth credentials. |
| `options.params` | `object` | Parsed path parameters from the subscription path. |
| `options.internal` | `any` | Internal data passed via `server.publish()` options. |
| `options.socket` | `object` | The subscriber's Socket object. (lib/listener.js:298) |

Return `true` to send the message, `false` to skip. Filters can be `async`.

**Modifying messages per subscriber:**

Filters can return an object with `override` to send a different message to a specific subscriber:

    server.subscription('/feed', {
        filter: (path, message, options) => {

            if (options.credentials.role !== 'admin') {
                return { override: { text: message.text } };  // Strip sensitive fields
            }

            return true;
        }
    });


### onSubscribe / onUnsubscribe Hooks


These hooks fire when a client subscribes or unsubscribes from a channel.

**`onSubscribe(socket, path, params)`** -- called before the subscription is confirmed. Throw a Boom error to reject:

    server.subscription('/rooms/{roomId}', {
        onSubscribe: async (socket, path, params) => {

            const room = await getRoom(params.roomId);
            if (!room) {
                throw Boom.notFound('Room does not exist');
            }

            if (room.isFull) {
                throw Boom.forbidden('Room is full');
            }
        }
    });

**`onUnsubscribe(socket, path, params)`** -- called after the client unsubscribes or disconnects. Cannot reject (the unsubscription has already happened):

    server.subscription('/rooms/{roomId}', {
        onUnsubscribe: (socket, path, params) => {

            updateRoomCount(params.roomId, -1);
        }
    });


### Gotchas


- **Subscription paths must be declared before `server.start()`.** Calling `server.subscription()` after the server starts will throw.
- **`server.publish()` is fire-and-forget.** It does not return information about how many clients received the message or whether any filters rejected.
- **Filter functions run per subscriber.** For high-traffic channels with many subscribers, expensive filter logic can become a bottleneck. Keep filters fast.
- **Path parameters are strings.** Even if the path is `/items/{id}` and the client subscribes to `/items/42`, `params.id` is the string `'42'`, not a number.
- **`internal` data is never sent to clients.** The `options.internal` value from `server.publish()` is only available inside the filter function. This is the correct way to pass server-side context for filtering decisions.
- **`onSubscribe` throwing rejects the subscription.** The client receives an error. Use Boom errors for proper status codes.
- **`onUnsubscribe` fires on disconnect too.** If a client disconnects without explicitly unsubscribing, `onUnsubscribe` is still called for each active subscription.
- **`broadcast` bypasses subscriptions.** `server.broadcast()` sends to all connected sockets, not just those subscribed to a particular path. Clients receive it via the `onUpdate` handler, not subscription handlers.
- **Filter returning an object with `override`.** To send a modified message to a subscriber, return `{ override: modifiedMessage }` from the filter. Returning just `true` sends the original message.
