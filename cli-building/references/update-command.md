# Self-Update Command


[`release.md`](release.md) gets your CLI published — npm package, binary, or both. This is the matching runtime feature: an `update` subcommand so a user already running the CLI can pull the newest version without remembering install instructions. It is the natural counterpart to the binary-distribution path, where there is no package manager to run `npm i -g` for them.

It comes down to three calls:

1. **Behaviour** — does `update` ask before replacing the binary, apply silently, or just nudge?
2. **Install-mode routing** — was the CLI installed via npm or as a standalone binary? They update differently.
3. **Mechanics** — how the running binary gets replaced safely (checksum, atomic swap, platform limits).


## Decision 1 — Behaviour

| | Ask-first | Apply-immediately | Passive banner |
|--|-----------|-------------------|----------------|
| What `update` does | check → show `current → latest` → **confirm** → install | check → install, no prompt | does nothing on its own |
| How the user is told | the command itself | the command itself | a one-line banner printed by *other* commands when a newer version exists |
| Bypass for CI | `--yes` skips the prompt | already non-interactive | n/a |
| Feel | explicit, reversible | fast, trusting | unobtrusive; user opts in by running `update` |

**Recommended default: ask-first.** Replacing the binary a user is running is a hard-to-reverse action on a shared path; a one-line `confirm()` is cheap insurance and costs nothing in CI because `--yes` bypasses it. Pair it with a passive banner (see [Passive notification](#passive-notification-optional)) so users learn an update exists without running `update` blind. Apply-immediately is fine for a single-author tool you trust yourself with; reach for it only when the prompt is pure friction.


## Decision 2 — Install-mode routing

A binary that downloads a replacement binary is wrong for a CLI someone installed with `npm i -g` — npm owns that file and will fight the swap. Detect how the CLI is running and route:

| Mode | How to detect | How to update |
|------|---------------|---------------|
| `development` | version is the dev sentinel (`0.0.0-dev`) the build stamps in | refuse — tell the user to `git pull` |
| `npm` | running through a `node`/`bun` runtime (the global-install bin shim) | shell out to `npm install -g <pkg>@latest` (or just print that line) |
| `binary` | `process.execPath` is the compiled executable itself | download the release asset, verify, swap in place |

```typescript
import { basename } from 'node:path';

// CURRENT_VERSION is your build-time-injected version (the release skill's
// checker.ts pattern). RUNTIMES are the interpreters a non-compiled CLI runs under.
const RUNTIMES = new Set(['node', 'node.exe', 'bun', 'bun.exe']);

export type InstallMode = 'development' | 'npm' | 'binary';

export function detectInstallMode(): InstallMode {
    // Dev checkout: the build stamps a sentinel version instead of a real one.
    if (CURRENT_VERSION === '0.0.0-dev') return 'development';

    // Running under a runtime means an npm/global install — the bin shim shells
    // out to node/bun. A compiled binary IS its own execPath, so it falls through.
    const exe = basename(process.execPath).toLowerCase();
    return RUNTIMES.has(exe) ? 'npm' : 'binary';
}
```

> Detection routes on `process.execPath`, not on `__filename` — in an ESM build `__filename` is undefined, which would silently send every npm install down the `binary` path and stomp the npm-managed file. If you only ever ship a binary, you can drop the npm branch, but keep the `development` guard so a dev checkout (carrying the `0.0.0-dev` sentinel) never tries to overwrite itself.


## Decision 3 — The command

Wire `update` like any other citty command (see [commands.md](commands.md)). Two flags carry the behaviour:

- `--check` — report whether an update exists and exit; never install. Useful in CI and for the passive banner's "run `my-cli update`" hint.
- `--yes` — skip the confirmation prompt (non-interactive installs, scripts).

```typescript
import { defineCommand } from 'citty';
import { runUpdate } from '../lib/update';

export default defineCommand({
    meta: { name: 'update', description: 'Update my-cli to the latest release' },
    args: {
        check: { type: 'boolean', description: 'Only check; do not install' },
        yes: { type: 'boolean', description: 'Skip the confirmation prompt' },
    },
    async run({ args }) {
        process.exit(await runUpdate({ check: args.check, yes: args.yes }));
    },
});
```

<workflow>

`runUpdate` follows a fixed order. Each step can short-circuit, so check cheap conditions before expensive ones.

1. **Check.** Resolve the latest release tag (a `GET` to `https://github.com/<repo>/releases/latest` with `redirect: 'manual'` returns a `Location` you parse the tag from — no API token, no rate-limit pain). Compare against the embedded current version.
2. **Up to date?** Print `my-cli X is up to date.` and exit 0.
3. **`--check`?** Print `current → latest` plus a `run my-cli update` hint and exit. (See [Exit codes](#exit-codes-for---check).)
4. **Route by install mode.** `development` → tell them to `git pull` and exit. `npm` → run `npm install -g <pkg>@latest` and exit. `binary` → continue.
5. **Platform guard.** On Windows a running `.exe` cannot replace itself — print a manual-download line and exit. (Unix keeps the old inode for the live process, so the swap is safe there.)
6. **Confirm (ask-first).** Unless `--yes`: if stdout is not a TTY, print "re-run interactively or pass `--yes`" and exit; otherwise `confirm()` and honour cancel/no. Always `isCancel()`-check the clack result (see [prompts.md](prompts.md)).
7. **Download, verify, swap.** See [Mechanics](#mechanics) below.
8. **Report.** Print `Updated to my-cli X.` Map permission errors to actionable advice (`sudo`, or re-run the installer).

</workflow>

The confirm gate, the part that makes it ask-first — `info` is the check result from step 1 (`current`, `latest`, `tag`), `opts` is the `{ check, yes }` passed to `runUpdate`:

```typescript
if (!opts.yes) {
    if (!process.stdout.isTTY) {
        console.log('Re-run in an interactive terminal, or `my-cli update --yes` to install non-interactively.');
        return 0;
    }
    const { confirm, isCancel } = await import('@clack/prompts');
    const answer = await confirm({ message: `Update to ${info.latest} now?` });
    if (isCancel(answer) || !answer) {
        console.log('Update cancelled.');
        return 0;
    }
}
```


## Mechanics

Downloading and replacing the running binary. The asset name and `checksums.txt` come straight from the release artifacts [`release.md`](release.md) already produces — reuse the same naming scheme.

```typescript
import { chmodSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Throws on a genuine checksum mismatch; returns quietly when the sums are unreachable. */
async function verifyChecksum(base: string, asset: string, bytes: Uint8Array): Promise<void> {
    let expected: string | undefined;
    try {
        const res = await fetch(`${base}/checksums.txt`);
        if (!res.ok) return;                       // no sums published — skip
        expected = parseChecksums(await res.text())[asset];
    } catch {
        return;                                    // offline mid-update — non-fatal
    }
    if (!expected) return;                         // asset not listed — skip

    const actual = await sha256(bytes);
    if (actual !== expected) {
        throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
    }
}

async function downloadAndReplace(tag: string, target: string): Promise<void> {
    const asset = assetForPlatform(process.platform, process.arch); // e.g. my-cli-darwin-arm64
    if (!asset) throw new Error(`no prebuilt binary for ${process.platform}/${process.arch}`);
    const base = `https://github.com/${REPO}/releases/download/${tag}`;

    const res = await fetch(`${base}/${asset}`);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${asset}`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    await verifyChecksum(base, asset, bytes); // throws on mismatch; silent when sums unreachable

    // Stage next to the target (same filesystem), then rename over it.
    const tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`);
    await Bun.write(tmp, bytes);
    chmodSync(tmp, 0o755);

    try {
        renameSync(tmp, target);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* best effort: original target is untouched */ }
        throw err;
    }
}
```

<constraints>

Three rules this code encodes — break any of them and the update is unsafe or fails on a real machine:

- **Stage on the same filesystem as the target, then `rename`.** A `rename` is atomic only within one filesystem; staging in `$TMPDIR` (often a different mount) makes the rename fail with `EXDEV`, or worse, fall back to a non-atomic copy that can leave a half-written binary if interrupted. Write the temp file in the target's own directory.

- **Verify the checksum and fail closed on mismatch.** You are about to execute whatever you downloaded with the user's privileges. A mismatch means a corrupted or tampered asset — abort, never run it. A failure to *fetch* `checksums.txt` (offline mid-update) may be treated as non-fatal, but a fetched-and-mismatched sum must abort. This is the same guarantee [`release.md`](release.md)'s `install.sh` makes; the `update` command must not be the weaker path.

- **Do not try to self-replace a running `.exe` on Windows.** Windows locks the executing image; the rename fails. Detect `win32` and print a manual-download line instead. On Unix the kernel keeps the old inode alive for the running process, so overwriting the file is safe and the new version takes effect on next launch.

</constraints>

Permission failures are the common real-world error — map them to advice instead of a raw stack:

```typescript
if (/EACCES|EPERM|EROFS|permission|denied/i.test(message)) {
    process.stderr.write(
        `Error: cannot write to ${target} (${message}).\n` +
        'Try: sudo my-cli update --yes\n' +
        `Or reinstall: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh\n`,
    );
}
```


## Exit codes for `--check`

Two conventions, pick one and document it:

- **Exit 0 always**, print the result. Simplest; callers parse stdout. Good when humans run `--check`.
- **`diff(1)` idiom**: exit 1 when an update *is* available, exit 0 when current, exit 2 on a hard error (network/parse). Lets a CI step gate on it directly — `my-cli update --check && echo current`. The cost is that "exit 1" reads as failure to anyone who didn't read the docs.

Whichever you choose, keep `update` (without `--check`) on the normal convention: 0 on success or no-op, nonzero only on a real failure.


## Passive notification (optional)

Ask-first tells the user about an update only when they run `update`. A passive banner closes the loop: other commands print a one-line nudge when a newer version exists, so the user learns to run `update` on their own.

Two guards keep it from becoming a network tax or a nag:

- **Cache window.** Persist `{ checkedAt, latestVersion }` to a dotfile (e.g. `~/.my-cli/update-cache.json`). Only hit the network if the cache is older than ~1 hour; otherwise read the cached `latestVersion`. Run the check in the background (don't block the command the user actually asked for) and never let a failed check surface an error.

- **Notify window.** Record `notifiedAt`; show the banner at most once per ~24 hours so repeat invocations stay quiet.

```text
update available: 1.4.0 (current: 1.3.2). run: my-cli update
```

For an interactive TUI, the same check can drive an in-app banner with an "update now" action instead of a printed line — a background check on launch, gated by a user setting (`checkUpdates: true`), feeding a dismissable notification.


## Putting it together

- Default to **ask-first** with `--yes` to bypass, plus a **passive banner** so updates get discovered.
- **Route by install mode** — never download a binary over an npm-managed install, never overwrite a dev checkout.
- Reuse the release artifacts: same asset names, same `checksums.txt`, **verify and fail closed**.
- Stage-then-rename on the **same filesystem**; special-case **Windows** and **permission** errors with real advice.
