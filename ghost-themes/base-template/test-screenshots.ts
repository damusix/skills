/**
 * Visual screenshot tests for Ghost theme.
 *
 * Navigates to key pages on a running Ghost instance and captures
 * screenshots using Bun.WebView (headless browser, zero deps on macOS).
 *
 * Usage:
 *   bun run test:visual                          # default: http://localhost:2368
 *   GHOST_URL=https://staging.example.com bun run test:visual
 *
 * Requires: Bun >= 1.3.12, Ghost running at GHOST_URL
 * Output:   tmp/screenshots/<page>-<width>.png
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";

const GHOST_URL = process.env.GHOST_URL || "http://localhost:2368";
const OUT_DIR = path.resolve(import.meta.dir, "tmp/screenshots");

if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
}

interface Route {
    name: string;
    path: string;
}

const routes: Route[] = [
    { name: "homepage", path: "/" },
    { name: "post", path: "/welcome/" },
    { name: "author", path: "/author/ghost/" },
    { name: "tag", path: "/tag/getting-started/" },
    { name: "404", path: "/this-page-does-not-exist/" },
];

const viewports = [
    { name: "desktop", width: 1280, height: 900 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 375, height: 812 },
];

async function waitForGhost(url: string, maxRetries = 30): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch {
            // Ghost not ready yet
        }
        await Bun.sleep(1000);
    }
    throw new Error(`Ghost not reachable at ${url} after ${maxRetries}s`);
}

async function captureRoute(route: Route, viewport: typeof viewports[number]): Promise<string> {
    await using view = new Bun.WebView({
        width: viewport.width,
        height: viewport.height,
    });

    const url = `${GHOST_URL}${route.path}`;
    await view.navigate(url);

    // Wait for content to render
    await Bun.sleep(1500);

    const png = await view.screenshot({ format: "png" });
    const filename = `${route.name}-${viewport.name}.png`;
    const filepath = path.join(OUT_DIR, filename);
    await Bun.write(filepath, png);

    return filepath;
}

async function main() {
    console.log(`Checking Ghost at ${GHOST_URL}...`);
    await waitForGhost(GHOST_URL);
    console.log("Ghost is up.\n");

    const results: string[] = [];

    for (const viewport of viewports) {
        console.log(`--- ${viewport.name} (${viewport.width}x${viewport.height}) ---`);

        for (const route of routes) {
            try {
                const filepath = await captureRoute(route, viewport);
                console.log(`  ✓ ${route.name}: ${filepath}`);
                results.push(filepath);
            } catch (err) {
                console.error(`  ✗ ${route.name}: ${err}`);
            }
        }
    }

    console.log(`\nDone. ${results.length} screenshots saved to ${OUT_DIR}`);
}

await main();
