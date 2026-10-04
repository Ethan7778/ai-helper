import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "extension", "dist");
const iconsSrc = join(__dirname, "extension", "icons");
const iconsDist = join(distDir, "icons");
const watch = process.argv.includes("--watch");

mkdirSync(distDir, { recursive: true });
mkdirSync(iconsDist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "es2020",
  logLevel: "info",
  define: {
    __AI_HELPER_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
};

function copyStaticAssets() {
  copyFileSync(
    join(__dirname, "extension", "manifest.json"),
    join(distDir, "manifest.json")
  );
  for (const name of readdirSync(iconsSrc)) {
    if (!name.endsWith(".png")) continue;
    // Ship only the sizes Chrome lists in the manifest.
    if (!/^icon(16|48|128)\.png$/.test(name)) continue;
    copyFileSync(join(iconsSrc, name), join(iconsDist, name));
  }
}

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

  copyStaticAssets();

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
