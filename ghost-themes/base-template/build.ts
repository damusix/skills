import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import postcss from "postcss";
import postcssImport from "postcss-import";

const srcDir = path.resolve(import.meta.dir, "assets/src");
const outDir = path.resolve(import.meta.dir, "assets/built");

if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
}

const isWatch = process.argv.includes("--watch");

async function buildJS() {
    const result = await Bun.build({
        entrypoints: [
            path.join(srcDir, "app.ts"),
        ],
        outdir: outDir,
        minify: !isWatch,
        target: "browser",
        sourcemap: isWatch ? "inline" : "none",
    });

    if (!result.success) {
        console.error("JS build failed:");
        for (const log of result.logs) {
            console.error(log);
        }
        process.exit(1);
    }
}

async function buildCSS() {
    const cssEntry = path.join(srcDir, "app.css");
    const cssOut = path.join(outDir, "app.css");
    const src = readFileSync(cssEntry, "utf8");

    const plugins: postcss.AcceptedPlugin[] = [postcssImport()];
    const result = await postcss(plugins).process(src, {
        from: cssEntry,
        to: cssOut,
    });

    writeFileSync(cssOut, result.css);
}

async function build() {
    await Promise.all([buildJS(), buildCSS()]);
    console.log("Build succeeded:");
    console.log("  assets/built/app.js");
    console.log("  assets/built/app.css");
}

await build();

if (isWatch) {
    console.log("\nWatching for changes...");
    const { watch } = await import("fs");
    watch(srcDir, { recursive: true }, async () => {
        await build();
    });
}
