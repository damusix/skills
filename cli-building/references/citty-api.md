# Citty API Reference


## Core Functions

| Function | Purpose |
|----------|---------|
| `defineCommand(def)` | Type-safe command definition (identity function) |
| `runMain(cmd, opts?)` | Parse argv, handle --help/--version, run command |
| `createMain(cmd)` | Returns a callable function instead of running immediately |
| `runCommand(cmd, opts)` | Lower-level: parse args, run setup/run/cleanup |
| `parseArgs(rawArgs, argsDef)` | Parse raw string args against an ArgsDef |
| `renderUsage(cmd, parent?)` | Returns formatted help string |
| `showUsage(cmd, parent?)` | Prints help to console |
| `defineCittyPlugin(def)` | Type-safe plugin definition |


## Resolvable<T>

Every major field in a command definition accepts `Resolvable<T>`:

```typescript
type Resolvable<T> = T | Promise<T> | (() => T) | (() => Promise<T>);
```

This applies to: `meta`, `args`, `subCommands`, and plugins.

Use it for lazy loading:

```typescript
subCommands: {
    // Static — loaded at import time
    help: helpCommand,

    // Lazy — loaded only when invoked
    deploy: () => import('./deploy').then((m) => m.default),

    // Async factory — computed dynamically
    scaffold: async () => {
        const templates = await loadTemplates();
        return buildScaffoldCommand(templates);
    },
}
```


## Plugins

Reusable setup/cleanup hook bundles:

```typescript
import { defineCittyPlugin } from 'citty';

const timing = defineCittyPlugin({
    name: 'timing',
    setup() {
        console.time('command');
    },
    cleanup() {
        console.timeEnd('command');
    },
});

export default defineCommand({
    meta: { name: 'build' },
    plugins: [timing],
    run() {
        // ...
    },
});
```

Execution order:

1. Plugin `setup` hooks (first → last)
2. Command `setup`
3. Command `run`
4. Command `cleanup`
5. Plugin `cleanup` hooks (last → first)

Cleanup always runs, even if `run()` throws.


## CLIError

Citty throws `CLIError` for user-facing validation failures. `runMain` catches these and prints usage + error message.

Error codes:

| Code | Meaning |
|------|---------|
| `EARG` | Missing required arg or invalid enum value |
| `E_UNKNOWN_COMMAND` | Subcommand not found |
| `E_NO_COMMAND` | No subcommand given and no `default` set |
| `E_DEFAULT_CONFLICT` | Both `run` and `default` defined on same command |
| `E_NO_VERSION` | `--version` used but no `meta.version` set |


## CommandContext

The object passed to `setup`, `run`, and `cleanup`:

```typescript
interface CommandContext<T extends ArgsDef> {
    rawArgs: string[];        // Raw argv slice
    args: ParsedArgs<T>;      // Typed parsed arguments
    cmd: CommandDef<T>;       // The command definition
    subCommand?: CommandDef;  // Resolved subcommand (if any)
    data?: Record<string, unknown>;  // Passable context data
}
```


## Arg Definition Options

| Option | Applies To | Description |
|--------|-----------|-------------|
| `type` | All | `'positional'`, `'string'`, `'boolean'`, `'enum'` |
| `description` | All | Help text |
| `required` | All | Throws CLIError if missing |
| `default` | All | Default value |
| `alias` | string, boolean, enum | Short flag aliases (e.g., `['o']`) |
| `valueHint` | string, enum | Help display hint (e.g., `'dir'` → `--output=<dir>`) |
| `options` | enum only | Allowed values array |
| `negativeDescription` | boolean only | Description for `--no-` variant |


## Built-in Flags

`--help`/`-h` and `--version`/`-v` are handled automatically by `runMain`. They disable themselves if your args definition uses conflicting names or aliases.


## runMain Options

```typescript
interface RunMainOptions {
    rawArgs?: string[];               // Override process.argv
    showUsage?: typeof showUsage;     // Custom usage renderer
}
```


## Documentation Source

If something isn't covered here, consult the upstream docs:

- GitHub: https://github.com/unjs/citty
- Docs: https://citty.unjs.io
