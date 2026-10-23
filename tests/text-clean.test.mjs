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

const bare = cleanChatGptText(
  "Depth is the concern.\n\nimage_group If he couldn't play, veterans like Laken Tomlinson step in."
);
assert(
  bare === "Depth is the concern.\n\nIf he couldn't play, veterans like Laken Tomlinson step in.",
  `bare image_group left: ${JSON.stringify(bare)}`
);
const pua = cleanChatGptText("Intro.\n\n\uE200image_group\uE202If he couldn't play.");
assert(pua === "Intro.\n\nIf he couldn't play.", `PUA bare image_group left: ${JSON.stringify(pua)}`);
assert(cleanChatGptText("An image of a dog.") === "An image of a dog.", "ordinary 'image' was stripped");

const html = formatReplyHtml("## Hello\n> quoted\n**bold**");
assert(!/#/.test(html.replace(/&#/g, "")), `heading hash left: ${html}`);
assert(!/&gt;/.test(html), `blockquote left: ${html}`);
assert(/<strong>bold<\/strong>/.test(html), `bold missing: ${html}`);

const code = formatReplyHtml("Try:\n\n```js\nif (x) {\n    run(<a>);\n}\n```\nDone `inline`");
assert(/<pre><code>if \(x\) \{\n    run\(&lt;a&gt;\);\n\}<\/code><\/pre>/.test(code), `code block wrong: ${code}`);
assert(/class="code-lang">js</.test(code), `code lang missing: ${code}`);
assert(/<code>inline<\/code>/.test(code), `inline code missing: ${code}`);

const open = formatReplyHtml("Start\n```py\nprint(1)");
assert(/<pre><code>print\(1\)<\/code><\/pre>/.test(open), `unclosed fence wrong: ${open}`);

const lists = formatReplyHtml("- a\n- b\n\n1. one\n2. two");
assert(/<ul><li>a<\/li><li>b<\/li><\/ul><ol><li>one<\/li><li>two<\/li><\/ol>/.test(lists), `lists wrong: ${lists}`);

const kept = cleanChatGptText("x\n```\n  indented\n```");
assert(/\n  indented\n/.test(kept), `fence indentation lost: ${JSON.stringify(kept)}`);

for (const fence of ['```', '````', '~~~']) {
  const source = `${fence}js\n  map[key] = image[index];\n  const x = "**literal**";\n${fence}`;
  assert(cleanChatGptText(source) === source, 'cleanup modified fenced code');
  assert(formatReplyHtml(source).includes('map[key] = image[index];'), 'renderer deleted code');
}
assert(cleanChatGptText('Use `map[key]` here.') === 'Use `map[key]` here.', 'cleanup modified inline code');
assert(formatReplyHtml('````md\n```js\nx\n```\n````').includes('```js\nx\n```'), 'nested fence ended early');
for (const source of [String.raw`\(x^2\)`, String.raw`\[\frac{1}{2}\]`, '$$x^2$$', '$x^2$']) {
  assert(formatReplyHtml(source).includes('<math'), `math missing: ${source}`);
}
assert(!formatReplyHtml('`$x$`').includes('<math'), 'inline code rendered as math');
assert(!formatReplyHtml('```tex\n$x$\n```').includes('<math'), 'fenced code rendered as math');
assert(!formatReplyHtml('Costs $5 or $10.').includes('<math'), 'currency rendered as math');
assert(!formatReplyHtml(String.raw`\(\href{javascript:alert(1)}{x}\)`).includes('href="javascript:'), 'unsafe math link');
assert(formatReplyHtml('<script>alert(1)</script>').includes('&lt;script&gt;'), 'HTML was not escaped');

rmSync(dir, { recursive: true, force: true });
console.log("ok — text-clean strips image_group widgets and markdown noise");
