# Entrypoint — `cli/index.ts`


## Pattern

The entrypoint wires three things: the root command, tab completion, and `runMain()`.

```typescript
import { createMain, defineCommand } from 'citty';

const main = defineCommand({
    meta: {
        name: 'my-cli',
        version: '1.0.0',
        description: 'Project CLI tools',
    },
    subCommands: {
        deploy: () => import('./commands/deploy').then((m) => m.default),
        db: () => import('./commands/db/index').then((m) => m.default),
    },
});

// Gated: tab() resolves every lazy subcommand to build the completion tree,
// so only pay that cost when the shell is actually asking for completions.
if (process.argv[2] === 'complete') {
    const { default: tab } = await import('@bomb.sh/tab/citty');
    await tab(main, {
        subCommands: {
            deploy: {
                options: {
                    environment: (complete) => {
                        complete('dev', 'Development');
                        complete('staging', 'Staging');
                        complete('prod', 'Production');
                    },
                },
            },
        },
    });
}

const cli = createMain(main);
cli();
```

See [tab-completion.md](tab-completion.md) for the adapter's requirements (every subcommand needs `meta.description`) and the per-shell install story.


## Alternate: Inline Root Command

If the CLI only has a few commands, define them inline instead of importing a separate registry:

```typescript
import { defineCommand, runMain } from 'citty';

const main = defineCommand({
    meta: {
        name: 'my-cli',
        version: '1.0.0',
        description: 'Project CLI tools',
    },
    subCommands: {
        init: () => import('./commands/init').then((m) => m.default),
        dev: () => import('./commands/dev').then((m) => m.default),
    },
});

runMain(main);
```


## Hashbang for Direct Execution

If the CLI should run directly (not through a bundler), add a hashbang and make it executable:

```typescript
#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
// ... rest of entrypoint
```

For TypeScript, use a runner like `tsx`:

```typescript
#!/usr/bin/env -S npx tsx
import { defineCommand, runMain } from 'citty';
// ... rest of entrypoint
```
