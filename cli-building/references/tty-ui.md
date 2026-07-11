# Terminal UI Niceties — spinners, progress, inline regions


Long-running commands need feedback. This reference covers two tiers: the spinner you already have, and `@bomb.sh/tty` — a WASM-compiled layout engine (flexbox via [Clay](https://github.com/nicbarker/clay), pointer hit-testing, scroll containers) for when a one-line spinner stops being enough.

> Verified against `@bomb.sh/tty` 0.8.0. Pre-1.0 — pin the exact version.


## Pick the cheapest tier that works

1. **Not a TTY? Plain lines.** Under a pipe or CI, print one log line per step and skip animation entirely. Every pattern below is gated on `process.stdout.isTTY`.
2. **One line of feedback → `@clack/prompts` `spinner()`.** Already in this stack ([prompts.md](prompts.md)) — no new dependency:

    ```typescript
    import { spinner } from '@clack/prompts';

    const s = spinner();
    s.start('Compiling modules');
    await build();
    s.stop('Compiled modules');
    ```

3. **Layout-grade UI → `@bomb.sh/tty`.** Bordered status panels, multi-line animated regions, progress bars with real layout, live dashboards, full-screen apps with mouse support.


## The `@bomb.sh/tty` model

The engine does **zero I/O**: `term.render(ops)` returns ANSI bytes you write to stdout; `input.scan(bytes)` turns raw stdin bytes into structured events (keys, mouse, resize, cursor reports). You own the streams, raw mode, and cleanup. Frames are double-buffered and diffed in WASM, so each render emits only the cells that changed.

```typescript
import { close, createTerm, open, rgba, text } from '@bomb.sh/tty';

const term = await createTerm({ width: 80, height: 24 });

const { output } = term.render([
    open('greeting', {
        layout: { padding: { left: 1, right: 1, top: 1, bottom: 1 } },
        border: { color: rgba(0, 255, 0), left: 1, right: 1, top: 1, bottom: 1 },
        cornerRadius: { tl: 1, tr: 1, bl: 1, br: 1 },
    }),
    text('Hello, World!'),
    close(),
]);

process.stdout.write(new Uint8Array(output));
```

Ops are a flat list: `open(id, config)` … children … `close()`. Layout takes `width`/`height` (`fixed(n)` / `grow()`), `direction` (`'ltr'` / `'ttb'`), `padding`, alignment; elements take `bg`, `border`, and `text(str, { color, bg })`.


## Inline regions — loaders in normal scrollback

The pattern for CLI niceties: animate a small region *in place* without taking over the screen (no alternate buffer), then leave the final state in scrollback like ordinary output. The lifecycle, from upstream's `inline-regions` example:

1. **Allocate** the region's lines with raw newlines.
2. **Locate** it: query the cursor row with a Device Status Report (DSR) and compute the region's top row.
3. **Render** each frame at that row via `term.render(ops, { row })`.
4. **Commit**: restore the cursor below the region and print `\n` — the last frame stays in scrollback.

```typescript
import { readSync } from 'node:fs';
import {
    close, createInput, createTerm, CSI, cursor, DSR, ESC,
    fixed, grow, open, rgba, settings, text, type Op,
} from '@bomb.sh/tty';

/** Ask the terminal where the cursor is (requires raw mode + a real TTY). */
async function queryCursorRow(): Promise<number> {
    const parser = await createInput({ escLatency: 100 });
    process.stdout.write(new Uint8Array(DSR()));
    const buf = Buffer.alloc(32);
    while (true) {
        let n = 0;
        try {
            n = readSync(process.stdin.fd, buf, 0, buf.length, null);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
        }
        if (n === 0) continue;
        for (const ev of parser.scan(buf.subarray(0, n)).events) {
            if (ev.type === 'cursor') return ev.row;
        }
    }
}

/** Animate `frame(i)` in an in-place region of `height` lines, then commit it to scrollback. */
async function inlineRegion(
    height: number,
    frame: (i: number) => Op[],
    frames: number,
    intervalMs: number,
): Promise<void> {
    const columns = process.stdout.columns ?? 80;
    process.stdin.setRawMode(true);
    const hide = settings(cursor(false));

    try {
        process.stdout.write('\n'.repeat(height));            // 1. allocate
        const row = (await queryCursorRow()) - height + 1;    // 2. locate (1-based)
        process.stdout.write(new Uint8Array(ESC('7')));       //    save cursor
        process.stdout.write(new Uint8Array(hide.apply));

        const term = await createTerm({ width: columns, height });
        for (let i = 0; i < frames; i++) {                    // 3. render frames
            const { output } = term.render(frame(i), { row });
            process.stdout.write(new Uint8Array(output));
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    } finally {
        process.stdout.write(new Uint8Array(hide.revert));    // 4. commit
        process.stdout.write(new Uint8Array(ESC('8')));
        process.stdout.write(new Uint8Array(CSI('0m')));
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
    }
}
```

<examples>

<example description="Boxed spinner that resolves to a checkmark, in scrollback">

```typescript
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CYAN = rgba(139, 233, 253);
const GREEN = rgba(80, 250, 123);
const GRAY = rgba(100, 100, 100);

await inlineRegion(3, (i) => {
    const done = i === 29;
    const icon = done ? '✓' : BRAILLE[i % BRAILLE.length];
    const label = done ? 'Compiled modules' : 'Compiling modules...';
    return [
        open('box', {
            layout: { width: grow(), height: grow(), padding: { left: 1 }, alignY: 'center' },
            border: { color: done ? GREEN : GRAY, left: 1, right: 1, top: 1, bottom: 1 },
            cornerRadius: { tl: 1, tr: 1, bl: 1, br: 1 },
        }),
        text(`${icon} ${label}`, { color: done ? GREEN : CYAN }),
        close(),
    ];
}, 30, 80);
```

</example>

<example description="Single-line progress bar with percentage">

```typescript
const WIDTH = Math.min(process.stdout.columns ?? 80, 50);

await inlineRegion(1, (i) => {
    const progress = i / 39;
    const label = 'Downloading ';
    const room = WIDTH - label.length - 5;
    const filled = Math.round(room * progress);
    const bar = '█'.repeat(filled) + '░'.repeat(room - filled);
    const pct = `${Math.round(progress * 100)}%`.padStart(4);
    return [
        open('root', { layout: { width: fixed(WIDTH), height: fixed(1), direction: 'ltr' } }),
        text(label, { color: CYAN }),
        text(bar, { color: CYAN }),
        text(` ${pct}`, { color: GRAY }),
        close(),
    ];
}, 40, 50);
```

For a real task, drive the frame from actual progress (bytes received, files processed) instead of a frame counter — an `update-command.md`-style download already tracks `received / total`.

</example>

</examples>


## Full-screen apps

For an app that owns the whole terminal (dashboards, games, pickers beyond what clack offers): switch to the alternate buffer with `settings(alternateBuffer(true), cursor(false))`, run an input loop over `createInput()` events (keys, mouse via `mouseTracking()`), re-render on state change, and use the renderer's `animating` flag to schedule follow-up frames only while something is moving. The upstream `examples/` directory (keyboard, transitions, 2048) is the reference for this tier — study it before building one.

<constraints>

- **Guard on `isTTY` and degrade to plain lines.** Rendering needs stdout to be a terminal; the DSR cursor query additionally needs stdin in raw mode. Under a pipe or CI, print `Compiling modules... done` and move on.
- **Always restore terminal state.** A hidden cursor, raw mode, or un-reset SGR colors leak into the user's shell on a crash. Do cleanup in `finally` *and* on `SIGINT` — the escape hatches are `cursor(true)`/`.revert`, `setRawMode(false)`, and `CSI('0m')`.
- **Terms are fixed-size.** `createTerm({ width, height })` allocates fixed buffers; on `SIGWINCH` rebuild the term and repaint rather than rendering into stale dimensions.
- **Don't interleave writes.** While a region is animating, any other stdout write lands inside it. Route incidental logging to stderr or queue it until the region commits.
- **Weigh the dependency.** This is a WASM engine, not a one-liner — reach for it when layout genuinely matters. A `\r`-rewritten line (the [update-command.md](update-command.md) download progress) or clack's spinner covers most CLIs without it.

</constraints>


## Documentation source

- `@bomb.sh/tty`: https://github.com/bombshell-dev/tty (README + `examples/`)
