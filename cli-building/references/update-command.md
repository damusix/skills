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

Downloading and replacing the running binary. The asset name and `checksums.txt` come straight from the release artifacts [`release.md`](release.md) already produces — reuse the same naming scheme. This block is the verify-and-swap shell; the download itself streams to disk with a stall timeout and resume — see [Download robustness](#download-robustness) below.

```typescript
import { chmodSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Throws on a genuine checksum mismatch; returns quietly when the sums are unreachable. */
async function verifyChecksum(base: string, asset: string, staged: string): Promise<void> {
    let expected: string | undefined;
    try {
        // Same gotcha as the asset download: fetch() never times out on its own.
        const res = await fetch(`${base}/checksums.txt`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return;                       // no sums published — skip
        expected = parseChecksums(await res.text())[asset];
    } catch {
        return;                                    // offline mid-update — non-fatal
    }
    if (!expected) return;                         // asset not listed — skip

    // sha256File: createHash('sha256') fed from a createReadStream — hashes the
    // assembled file from disk, never buffers the binary whole.
    const actual = await sha256File(staged);
    if (actual !== expected) {
        throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
    }
}

async function downloadAndReplace(tag: string, target: string): Promise<void> {
    const asset = assetForPlatform(process.platform, process.arch); // e.g. my-cli-darwin-arm64
    if (!asset) throw new Error(`no prebuilt binary for ${process.platform}/${process.arch}`);
    const base = `https://github.com/${REPO}/releases/download/${tag}`;

    // Stage next to the target (same filesystem), then rename over it.
    const tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`);

    try {
        await downloadWithResume(`${base}/${asset}`, tmp); // streams to tmp — see below
        await verifyChecksum(base, asset, tmp);            // throws on mismatch; silent when sums unreachable
        chmodSync(tmp, 0o755);
        renameSync(tmp, target);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* best effort: original target is untouched */ }
        throw err;
    }
}
```

### Download robustness

A compiled binary is tens of megabytes, and `fetch()` has no default timeout — two facts that make the naive `new Uint8Array(await res.arrayBuffer())` a trap. On a stalled connection the promise never settles: there is no error to catch (a try/catch cannot catch a promise that never resolves), and the command sits on `Installing...` forever. And because the body is buffered, there is nothing to print while it downloads, so a slow connection is indistinguishable from a frozen one. Stream to the staged file, reset a stall timer on every chunk, and resume interrupted transfers:

```typescript
const STALL_MS = 30_000;   // abort when no bytes arrive for this long
const MAX_ATTEMPTS = 4;    // first try + up to three resumes

const isRetriable = (status: number) => status === 408 || status === 429 || status >= 500;
const mb = (n: number) => (n / 1e6).toFixed(1);

async function downloadWithResume(url: string, tmp: string): Promise<void> {
    let etag: string | null = null;

    for (let attempt = 1; ; attempt++) {
        const ctl = new AbortController();
        let timer = setTimeout(() => ctl.abort(), STALL_MS);

        try {
            const offset = statSync(tmp, { throwIfNoEntry: false })?.size ?? 0;
            const headers: Record<string, string> = {};
            if (offset > 0 && etag) {
                headers.Range = `bytes=${offset}-`; // resume from the bytes on disk…
                headers['If-Range'] = etag;         // …only if the asset has not changed
            }

            const res = await fetch(url, { signal: ctl.signal, headers });

            // 404/403 will not get better on retry — surface them immediately.
            if (!res.ok && !isRetriable(res.status)) {
                throw Object.assign(new Error(`download failed (HTTP ${res.status}) for ${url}`), { fatal: true });
            }
            if (!res.ok || !res.body) throw new Error(`transient HTTP ${res.status}`);

            etag = res.headers.get('etag');

            // 206 appends to the partial; a 200 after a Range request means the
            // asset changed (or ranges are unsupported) — truncate and start over.
            const resumed = res.status === 206;
            let received = resumed ? offset : 0;
            const total = received + Number(res.headers.get('content-length') ?? 0);

            const file = await open(tmp, resumed ? 'a' : 'w');
            try {
                for await (const chunk of res.body) {
                    clearTimeout(timer);                             // a chunk arrived —
                    timer = setTimeout(() => ctl.abort(), STALL_MS); // push the stall deadline out
                    await file.write(chunk);
                    received += chunk.length;
                    if (process.stdout.isTTY && total) {
                        const pct = Math.round((received / total) * 100);
                        process.stdout.write(`\rDownloading ${mb(received)} / ${mb(total)} MB (${pct}%)`);
                    }
                }
            } finally {
                await file.close();
                if (process.stdout.isTTY && total) process.stdout.write('\n');
            }

            // A cleanly closed but short body is a truncation, not a success.
            if (total && received < total) {
                throw new Error(`connection closed early (${received}/${total} bytes)`);
            }
            return;
        } catch (err) {
            if ((err as { fatal?: boolean }).fatal || attempt >= MAX_ATTEMPTS) throw err;
            await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1))); // backoff: 1s, 2s, 4s
        } finally {
            clearTimeout(timer);
        }
    }
}
```

- **Retriable vs fatal.** Stalls (the abort), dropped connections, truncated bodies, and `408`/`429`/`5xx` retry with exponential backoff and resume from the bytes already on disk. Any other `4xx` (`404` — no such asset on the tag, `403`) fails on the spot; retrying cannot conjure the asset. If you want recovery to be visible, print a one-line `retrying (2/4)…` notice in the catch.
- **`If-Range` is what makes resume safe.** With a matching ETag the server answers `206 Partial Content` and the partial is appended to; if the asset was re-published (or ranges are unsupported) it answers a full `200` and the code truncates and restarts. Without the guard, resuming across a changed asset splices two different binaries — the checksum would catch it, but only after the whole download is wasted.
- **Progress is TTY-only.** The `\r` carriage-return line keeps a human informed; under a pipe or in CI nothing is printed, and the stall timer — not a human's patience — is what watches for hangs.
- **Resume lives within one run.** The staged filename is pid-suffixed and `downloadAndReplace` unlinks it once all attempts are exhausted, so failed updates never litter the bin directory with partials.

<constraints>

Four rules this code encodes — break any of them and the update is unsafe or fails on a real machine:

- **Stage on the same filesystem as the target, then `rename`.** A `rename` is atomic only within one filesystem; staging in `$TMPDIR` (often a different mount) makes the rename fail with `EXDEV`, or worse, fall back to a non-atomic copy that can leave a half-written binary if interrupted. Write the temp file in the target's own directory. (On macOS this bites for real: `os.tmpdir()` lands on `/var/folders`, a different APFS volume than `~/.local/bin`.)

- **Verify the checksum and fail closed on mismatch.** You are about to execute whatever you downloaded with the user's privileges. A mismatch means a corrupted or tampered asset — abort, never run it. A failure to *fetch* `checksums.txt` (offline mid-update) may be treated as non-fatal, but a fetched-and-mismatched sum must abort. This is the same guarantee [`release.md`](release.md)'s `install.sh` makes; the `update` command must not be the weaker path. Streaming moves *where* you hash, not *whether*: verify the fully-assembled staged file before the swap (or hash chunks incrementally as they are written) — never `rename` a file whose sum you have not checked.

- **Give every `fetch` in the update path a timeout — and bound the asset download by silence, not total time.** `fetch()` has no default timeout: on a stalled socket the promise never settles, so no `catch` fires and the command hangs with no output until the user kills it. Small requests (the release check, `checksums.txt`) can take a flat `AbortSignal.timeout(...)`; the asset download cannot, because a flat deadline kills legitimately slow transfers of a large binary. Reset a stall timer on each received chunk instead — silence, not slowness, is the failure signal.

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
- **Stream the download** with a chunk-reset stall timeout and `Range`/`If-Range` resume — a bare `fetch` + `arrayBuffer()` shows no progress and hangs forever on a stalled socket.
- Stage-then-rename on the **same filesystem**; special-case **Windows** and **permission** errors with real advice.
