# Architecture


## Directory Structure

```
cli/
    index.ts                        # Entrypoint: runMain() + tab completion
    commands/
        index.ts                    # Command registry — lazy subCommands record
        deploy.ts                   # Leaf command (no subcommands)
        db/
            index.ts                # Parent command + subcommand registry
            migrate.ts              # Subcommand: db migrate
            seed.ts                 # Subcommand: db seed
    prompts/
        confirm-deploy.ts           # Reusable prompt: confirm deployment target
        select-environment.ts       # Reusable prompt: pick env (dev/staging/prod)
    lib/
        config.ts                   # Config loading (env, files, defaults)
        types.ts                    # Shared TypeScript types
        constants.ts                # CLI-wide constants
```


## File Responsibilities

### `cli/index.ts`

The root command. Imports the command registry, wires tab completion, calls `runMain()`. This is the bin entrypoint. See [entrypoint](entrypoint.md).


### `cli/commands/index.ts`

Exports a `subCommands` record with lazy imports. Every top-level command is registered here.

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'my-cli',
        version: '1.0.0',
        description: 'Project CLI tools',
    },
    subCommands: {
        deploy: () => import('./deploy').then((m) => m.default),
        db: () => import('./db/index').then((m) => m.default),
    },
});
```


### `cli/commands/[name].ts` — Leaf Command

A single file exporting `defineCommand()` as default. Handles its own args, validation, and execution.

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'deploy',
        description: 'Deploy to target environment',
    },
    args: {
        environment: {
            type: 'enum',
            description: 'Target environment',
            options: ['dev', 'staging', 'prod'] as const,
            required: true,
        },
        dryRun: {
            type: 'boolean',
            description: 'Preview without executing',
        },
    },
    run({ args }) {
        console.log(`Deploying to ${args.environment}`);
    },
});
```


### `cli/commands/[name]/index.ts` — Parent Command

Registers subcommands via lazy imports. May define shared args inherited by subcommands.

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'db',
        description: 'Database management commands',
    },
    subCommands: {
        migrate: () => import('./migrate').then((m) => m.default),
        seed: () => import('./seed').then((m) => m.default),
    },
});
```


### `cli/commands/[name]/[sub].ts` — Subcommand

Identical structure to a leaf command. The parent registers it; the subcommand doesn't know about its parent.

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'migrate',
        description: 'Run database migrations',
    },
    args: {
        direction: {
            type: 'enum',
            description: 'Migration direction',
            options: ['up', 'down'] as const,
            default: 'up',
        },
    },
    run({ args }) {
        console.log(`Running migrations ${args.direction}`);
    },
});
```


### `cli/prompts/[name].ts`

Each file exports a typed async function composing `@clack/prompts` calls. See [prompts](prompts.md).


### `cli/lib/`

Shared utilities. Keep it minimal — only extract when two or more commands need the same logic.
