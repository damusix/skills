## `@hapi/sse` Event Replay Reference


When a client reconnects after a drop, the browser's `EventSource` sends the `Last-Event-ID` header with the ID of the last event it received. The SSE plugin uses a replay provider to re-deliver any missed events automatically.

Only events published with an explicit `id` are stored by replay providers.

    server.sse.subscription('/feed', {
        replay: new FiniteReplayer({ size: 200, autoId: true }),
        onReconnect: (session, path, params) => {

            console.log('client reconnected, last id:', session.lastEventId);
        }
    });

    await server.sse.publish('/feed', { text: 'hello' }, { id: 'msg-001' });


### `FiniteReplayer`


Ring buffer — keeps the last N events. Bounded memory, predictable behavior.

    import { FiniteReplayer } from '@hapi/sse';

    const replayer = new FiniteReplayer({
        size: 100,     // keep last 100 events
        autoId: true   // auto-generate sequential IDs when no explicit id is given
    });

    server.sse.subscription('/updates', { replay: replayer });

| Option   | Type      | Description                                                   |
|----------|-----------|---------------------------------------------------------------|
| `size`   | `number`  | Maximum number of events to retain in the buffer.             |
| `autoId` | `boolean` | Auto-assign sequential IDs to events that have no explicit ID.|

When the buffer is full, the oldest event is evicted.


### `ValidReplayer`


TTL-based — keeps events for a fixed duration. A periodic cleanup timer prunes expired entries.

    import { ValidReplayer } from '@hapi/sse';

    const replayer = new ValidReplayer({
        ttl: 60_000,   // keep events for 60 seconds
        autoId: true
    });

    server.sse.subscription('/live', { replay: replayer });

Call `replayer.stop()` to clear the cleanup timer. This is called automatically on server stop.

| Option   | Type      | Description                                                   |
|----------|-----------|---------------------------------------------------------------|
| `ttl`    | `number`  | Event lifetime in milliseconds.                               |
| `autoId` | `boolean` | Auto-assign sequential IDs to events that have no explicit ID.|


### Custom Replayer


Implement the `Replayer` interface for custom backends (Redis, Postgres, etc.):

    import type { Replayer, ReplayEntry } from '@hapi/sse';

    class RedisReplayer implements Replayer {

        async record(entry: ReplayEntry): Promise<void> {

            await redis.zadd('events', entry.id, JSON.stringify(entry));
        }

        async replay(lastEventId: string): Promise<ReplayEntry[]> {

            const raw = await redis.zrangebyscore('events', lastEventId, '+inf');
            return raw.map(JSON.parse);
        }

        stop(): void {

            // Optional cleanup
        }
    }

    server.sse.subscription('/feed', {
        replay: new RedisReplayer()
    });

`ReplayEntry` contains the data, event name, and ID that were originally published.


### Gotchas


- **Only events with an explicit `id` are replayed by default.** Use `autoId: true` to have the replayer assign IDs automatically.
- **`FiniteReplayer` evicts old events silently.** If a client was offline long enough that their `lastEventId` has been evicted, replay starts from the oldest available event.
- **`ValidReplayer` requires cleanup.** Call `replayer.stop()` on shutdown, or register it to run automatically (the plugin does this on server stop).
- **`onReconnect` fires after replay, not before.** Use `session.lastEventId` inside it to inspect what the client last received.
- **Replay happens per session, per reconnect.** Every new SSE connection that sends `Last-Event-ID` triggers replay individually.
