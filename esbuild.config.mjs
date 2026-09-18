import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "extension", "dist");
const watch = process.argv.includes("--watch");

mkdirSync(distDir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "es2020",
  logLevel: "info",
};

async function build() {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: {
      content: join(__dirname, "extension", "content-scripts", "inject.ts"),
      "service-worker": join(
        __dirname,
        "extension",
        "background",
        "service-worker.ts"
      ),
    },
    outdir: distDir,
    format: "iife",
  });

  copyFileSync(
    join(__dirname, "extension", "manifest.json"),
    join(distDir, "manifest.json")
  );

  if (watch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("Build complete → extension/dist");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
