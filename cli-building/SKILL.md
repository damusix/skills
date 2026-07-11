---
name: cli-building
description: "Use when building TypeScript CLIs. Guides command structure, interactive prompts, tab completion, and terminal UI niceties (spinners, progress, inline regions) using citty, `@clack/prompts`, `@bomb.sh/tab`, and `@bomb.sh/tty` — and shipping them: CI gates, versioning (Changesets / release-please), and npm or single-binary release."
---

# Citty CLI

## Quick Start

    npm install citty `@bomb.sh/tab` `@clack/prompts`

Minimal command:

```ts
import { defineCommand, runMain } from 'citty';

export default defineCommand({
    meta: { name: 'greet', description: 'Say hello' },
    args: { name: { type: 'string', description: 'Your name', required: true } },
    run({ args }) { console.log(`Hello, ${args.name}!`); },
});
```

## Critical Rules

1. **Every command exports default `defineCommand()`** — no exceptions
2. **Lazy-load subcommands** — `() => import('./cmd').then(m => m.default)`
3. **Check `isCancel()` after every `@clack/prompts` call** — never skip
4. **Citty handles all arg parsing** — no external parsers
5. **Architecture is opt-in** — only suggest `cli/` structure when the user asks for project layout or scaffolding. Single-file CLIs are valid.
6. **Gate `tab()` behind `process.argv[2] === 'complete'`** — the adapter eagerly resolves lazy subcommands, defeating rule 2 on every startup

## Architecture (only when user asks for structure)

See [architecture](references/architecture.md) for the full `cli/` layout with commands, prompts, and lib directories. Do not impose this structure unless the user explicitly asks for scaffolding or project organization.

## Workflow

1. Define commands — [commands](references/commands.md)
2. Add prompts if interactive — [prompts](references/prompts.md)
3. Add spinners/progress for long-running work — [tty-ui](references/tty-ui.md)
4. Wire tab completion — [tab-completion](references/tab-completion.md)
5. Scaffold `cli/` if multi-command — [architecture](references/architecture.md)
6. Configure bin entry — [sidecar setup](references/sidecar-setup.md)
7. **Verify** — run with `--help` to confirm command registration
8. Ship it — CI gates, versioning, npm or binary release — [release](references/release.md)

## References

- [Architecture](references/architecture.md) — Structure and responsibilities
- [Entrypoint](references/entrypoint.md) — runMain + tab completion wiring
- [Commands](references/commands.md) — defineCommand, args, subcommands
- [Prompts](references/prompts.md) — `@clack/prompts` reusable modules
- [Tab Completion](references/tab-completion.md) — `@bomb.sh/tab` citty adapter, completion protocol, per-shell install (compinit ordering, fish autoload), lazy-loading gate
- [TTY UI](references/tty-ui.md) — spinners and progress: `@clack/prompts` spinner first, `@bomb.sh/tty` inline regions and layout for richer feedback
- [Sidecar Setup](references/sidecar-setup.md) — bin entry, build config
- [Citty API](references/citty-api.md) — Resolvable, plugins, CLIError
- [Release](references/release.md) — CI gates, Changesets/release-please, npm + binary distribution
- [Versioning](references/versioning.md) — named schemes (SemVer/CalVer), 0.x vs 1.0, pre-releases, which bump, decision matrix, recording the policy
- [Update Command](references/update-command.md) — ask-first self-update: install-mode routing, streaming download (stall timeout, resumable retry), checksum-verified atomic swap, passive banner
