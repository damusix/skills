# Tab Completion — `@bomb.sh/tab`


## Citty Adapter

`@bomb.sh/tab/citty` reads the citty command tree and generates completions automatically. Commands, subcommands, and options are all derived from your `defineCommand()` definitions.

```typescript
import { createMain, defineCommand } from 'citty';
import tab from '@bomb.sh/tab/citty';

const main = defineCommand({
    meta: {
        name: 'my-cli',
        version: '1.0.0',
        description: 'My CLI tool',
    },
    subCommands: {
        deploy: defineCommand({
            meta: { name: 'deploy', description: 'Deploy app' },
            args: {
                environment: { type: 'string', description: 'Target env' },
                port: { type: 'string', description: 'Port number' },
            },
        }),
    },
});

const completion = await tab(main);

// Add dynamic completion handlers
const deployCmd = completion.commands.get('deploy');

const envOption = deployCmd?.options.get('environment');
if (envOption) {
    envOption.handler = (complete) => {
        complete('dev', 'Development environment');
        complete('staging', 'Staging environment');
        complete('prod', 'Production environment');
    };
}

const portOption = deployCmd?.options.get('port');
if (portOption) {
    portOption.handler = (complete) => {
        complete('3000', 'Default dev port');
        complete('8080', 'Alternative port');
    };
}

const cli = createMain(main);
cli();
```


## How It Works

The adapter exposes two subcommands on your CLI automatically:

| Command | Purpose |
|---------|---------|
| `my-cli complete [shell]` | Generates the shell completion script |
| `my-cli complete -- [args]` | Handles runtime completion requests |


## User Shell Setup

Users install completions by sourcing the generated script:

```bash
# zsh — add to ~/.zshrc
eval "$(my-cli complete zsh)"

# bash — add to ~/.bashrc
eval "$(my-cli complete bash)"

# fish — add to config.fish
my-cli complete fish | source
```


## Dynamic Completion Handlers

Static completions (command names, flag names) come free from the citty definitions. Use handlers for dynamic values:

```typescript
const dbCmd = completion.commands.get('db');
const tableOption = dbCmd?.options.get('table');
if (tableOption) {
    tableOption.handler = (complete) => {
        // Could read from config, filesystem, API, etc.
        const tables = ['users', 'orders', 'products'];
        for (const table of tables) {
            complete(table, `Table: ${table}`);
        }
    };
}
```

Handlers receive a `complete(value, description)` function. Call it once per completion candidate.


## Integration with Entrypoint

Tab completion setup goes between defining the root command and calling `runMain()`/`createMain()`. The adapter must see the full command tree to generate completions.

```typescript
import { createMain, defineCommand } from 'citty';
import tab from '@bomb.sh/tab/citty';

const main = defineCommand({ /* ... */ });

// 1. Wire tab completion
const completion = await tab(main);

// 2. Add dynamic handlers
// ...

// 3. Run
const cli = createMain(main);
cli();
```


## Documentation Source

If something isn't covered here, consult the upstream docs:

- `@bomb.sh/tab`: https://bomb.sh/docs/tab/
