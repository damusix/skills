# Tab Completion — `@bomb.sh/tab`


tab implements the Cobra-style completion protocol for JavaScript CLIs: your CLI answers `complete` requests, and a generated shell script (zsh, bash, fish, powershell — plus a Fig spec) forwards every `<TAB>` press to it. Because the script calls back into the CLI at completion time, completions stay current as commands evolve — the script never needs regenerating for new flags or subcommands.

> Verified against `@bomb.sh/tab` 0.0.19. The package is pre-1.0 and the API moves between patch releases — pin the exact version and re-check the [upstream docs](https://bomb.sh/docs/tab/) when upgrading.


## Citty Adapter

`@bomb.sh/tab/citty` reads the citty command tree and derives completions from your `defineCommand()` definitions. Attach dynamic value handlers with the completion config — the second argument, mirroring the command tree with `args` (positionals), `options`, and `subCommands`:

```typescript
import { createMain, defineCommand } from 'citty';
import tab from '@bomb.sh/tab/citty';

const main = defineCommand({
    meta: { name: 'my-cli', version: '1.0.0', description: 'My CLI tool' },
    args: {
        config: { type: 'string', description: 'Config file', alias: 'c' },
    },
    subCommands: {
        deploy: defineCommand({
            meta: { name: 'deploy', description: 'Deploy app' },
            args: {
                environment: { type: 'string', description: 'Target env' },
                verbose: { type: 'boolean', description: 'Verbose output' },
            },
        }),
    },
});

const completion = await tab(main, {
    options: {
        config: (complete) => {
            complete('my-cli.config.ts', 'TypeScript config');
            complete('my-cli.config.js', 'JavaScript config');
        },
    },
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
```

The returned root command is also mutable after the fact — useful when handlers are wired up elsewhere. Commands are keyed by their space-joined path:

```typescript
completion.commands.get('deploy')!.options.get('environment')!.handler = (complete) => {
    complete('dev', 'Development');
};
completion.commands.get('deploy migrate'); // nested subcommand
```

What the adapter derives from the citty tree:

| Citty definition | Completion behaviour |
|---|---|
| Subcommand + `meta.description` | completed with description (**description is required** — `tab()` throws without one) |
| Arg with `alias` | first alias completes as the short flag (`-c`) |
| String/number option, no handler | flag *name* completes; **no value suggestions** |
| Option with a handler | value completion — `--env <TAB>` and `--env=<TAB>` both work |
| Positional with an `args` handler | value completion; `required: false` positionals are treated as variadic |
| Boolean arg | flag-name completion; never consumes a following value |

<constraints>

- **Every subcommand needs `meta.description`, and the root needs `meta.name`.** The adapter throws otherwise — and if `tab()` runs unconditionally at startup, one missing description breaks every invocation of the CLI, not just completions.
- **Handlers must be synchronous.** The parse walk collects suggestions synchronously; an async handler's completions arrive after the output is already printed and are silently dropped. Read from sync sources (`readFileSync`, a cached config), not the network.
- **A value option without a handler is treated as a boolean flag.** If `--config <TAB>` should suggest anything, it needs a handler — even a trivial one.
- **The adapter registers a `complete` subcommand on your tree.** If your CLI already has a command named `complete`, it gets overwritten (the commander adapter accepts `completionCommandName`; the citty adapter does not).

</constraints>


## Wiring without giving up lazy loading

`tab()` must resolve every subcommand to build the completion tree — including `() => import()` lazy ones. Wired unconditionally, it defeats lazy loading on every startup. Gate it: the tree is only needed when the shell is asking for completions.

```typescript
const main = defineCommand({ /* meta + lazy subCommands */ });

if (process.argv[2] === 'complete') {
    await tab(main, completionHandlers); // registers the `complete` subcommand
}

const cli = createMain(main);
cli();
```

The tradeoff is that `complete` is absent from `--help` output — acceptable for shell plumbing; put the install one-liners in your README instead. Keep the entry path import-light either way: every `<TAB>` press spawns your CLI once (`my-cli complete -- …`), so startup time *is* completion latency.


## How it works — the protocol

| Command | Purpose |
|---------|---------|
| `my-cli complete zsh\|bash\|fish\|powershell` | print the shell completion script |
| `my-cli complete fig` | print a Fig autocomplete spec |
| `my-cli complete -- [args]` | answer a completion request |

The generated script invokes the CLI by its `meta.name`, so the installed bin must be on `PATH` under that exact name — which is also why it works for compiled binaries.

Test completions without touching a shell — a trailing `""` means "fresh word" (the user typed a space before `<TAB>`):

```bash
my-cli complete -- deploy --environment=""
# --environment=dev	Development
# --environment=staging	Staging
# --environment=prod	Production
# :4
```

Each line is `value<TAB>description`; the final `:N` is a shell directive (`:4` = no file completion fallback, `:0` = default). Descriptions show in zsh, fish, and powershell menus; bash displays plain values only.


## Installing completions (per shell)

One-time trial in the current shell: `source <(my-cli complete zsh)`.

For permanent installs, prefer writing the script to a file over `eval`-ing in the rc — `eval "$(my-cli complete zsh)"` spawns your CLI at every shell startup just to regenerate an identical script.

**zsh** — the script runs `compdef`, so it must load *after* `compinit`. The clean way is an `fpath` install:

```bash
mkdir -p ~/.zsh/completions
my-cli complete zsh > ~/.zsh/completions/_my-cli
```

```bash
# ~/.zshrc — the fpath line must come BEFORE compinit runs
fpath=(~/.zsh/completions $fpath)
autoload -U compinit && compinit
```

With oh-my-zsh, `compinit` runs inside `source $ZSH/oh-my-zsh.sh` — add the `fpath` line above that, or drop the file into a custom plugin directory. The symptom of wrong ordering is `command not found: compdef` at shell startup.

**bash** — source the generated file from `.bashrc`:

```bash
mkdir -p ~/.config/my-cli
my-cli complete bash > ~/.config/my-cli/completion.bash
echo 'source ~/.config/my-cli/completion.bash' >> ~/.bashrc
```

If the `bash-completion` v2 package is installed, `~/.local/share/bash-completion/completions/my-cli` (filename = command name) gets lazy-loaded instead — no rc edit.

**fish** — the best story: fish autoloads from its completions directory on first `<TAB>`, no rc edit, zero startup cost:

```bash
my-cli complete fish > ~/.config/fish/completions/my-cli.fish
```

**powershell**:

```powershell
my-cli complete powershell > ~/.my-cli-completion.ps1
Add-Content $PROFILE '. ~/.my-cli-completion.ps1'
```

Ship these one-liners in your README, and if you distribute via an `install.sh` ([release.md](release.md)), have it drop the fish/zsh files into place — installed-by-default completions are the difference between a feature and a footnote.

<constraints>

- **Keep stdout clean on the completion path.** The shell parses `my-cli complete -- …` stdout as the protocol. Any stray startup output — a passive update banner ([update-command.md](update-command.md)), a deprecation notice, a debug log — gets spliced into the suggestion list. Suppress banners when `argv` contains `complete`, or route them to stderr.
- **`npx`/`bunx` never complete** — they are separate binaries with no completion of their own. `pnpm exec my-cli <TAB>`, `npm exec`, and `bun x` *do* delegate to your CLI when the user has installed tab's package-manager completions (`npm i -g @bomb.sh/tab` + `source <(tab pnpm zsh)`).
- **Regeneration is rarely needed.** The script defers to the live CLI, so new commands and flags appear immediately. Regenerate only if the CLI is renamed or tab's script template changes on upgrade.

</constraints>


## Dynamic completion handlers

Handlers receive a `complete(value, description)` collector and the command's option map; `this` is bound to the `Option`/`Argument` being completed. Call `complete` once per candidate — tab filters by the typed prefix for you:

```typescript
subCommands: {
    db: {
        options: {
            table: (complete) => {
                // sync sources only — completions render inline in the shell
                const tables = JSON.parse(readFileSync(cachePath, 'utf8'));
                for (const t of tables) complete(t.name, t.description);
            },
        },
    },
},
```


## Documentation source

If something isn't covered here, consult the upstream docs:

- `@bomb.sh/tab`: https://bomb.sh/docs/tab/ and https://github.com/bombshell-dev/tab
