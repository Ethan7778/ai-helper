import { createRequire } from "module";
import { buildSync } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const dir = mkdtempSync(join(tmpdir(), "ai-helper-text-clean-"));
const outfile = join(dir, "text-clean.mjs");

buildSync({
  entryPoints: ["extension/core/text-clean.ts"],
  bundle: true,
  format: "esm",
  outfile,
  platform: "neutral",
});

const { cleanChatGptText, formatReplyHtml } = await import(
  pathToFileURL(outfile).href
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sample = cleanChatGptText(
  `There isn't a single objective "best" value menu item, but a few Wendy's value items became especially popular because they offered a lot for the price:\n\nimage_group{"query":"$4 Meal","src":"https://example.com/x.png"}**$4 Meal** – One of Wendy's most successful promotions.`
);

assert(!/image_group/.test(sample), `still has image_group: ${sample}`);
assert(!/\{"query"/.test(sample), `still has query json: ${sample}`);
assert(/\$4 Meal/.test(sample) || /4 Meal/.test(sample), `lost meal text: ${sample}`);

const mangled = cleanChatGptText(`image_group{"query4 Meal** – promo`);
assert(!/image_group/.test(mangled), `mangled still dirty: ${mangled}`);

const html = formatReplyHtml("## Hello\n> quoted\n**bold**");
assert(!/#/.test(html.replace(/&#/g, "")), `heading hash left: ${html}`);
assert(!/&gt;/.test(html), `blockquote left: ${html}`);
assert(/<strong>bold<\/strong>/.test(html), `bold missing: ${html}`);

rmSync(dir, { recursive: true, force: true });
console.log("ok — text-clean strips image_group widgets and markdown noise");
