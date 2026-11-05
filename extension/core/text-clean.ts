import { renderMarkdown } from "./markdown";
/**
 * Strip ChatGPT private-use citation / entity / media tokens into readable text.
 * Example: entity["people","Fred DeLuca","…"] → Fred DeLuca
 */
export function cleanChatGptText(text: string): string {
  return splitFences(text.replace(/\r\n?/g, "\n"))
    .map(seg => seg.code ? seg.raw : seg.raw.split(/(`+[^`\n]*`+)/g)
      .map(part => part.startsWith("`") ? part : cleanProse(part)).join(""))
    .join("").replace(/^\n+|\n+$/g, "");
}

function cleanProse(text: string): string {
  let out = text;
  // entity → prefer display name (index 1)
  out = out.replace(
    /\uE200entity\uE202(\[[\s\S]*?\])\uE201/g,
    (_m, json: string) => {
      try {
        const arr = JSON.parse(json) as unknown;
        if (Array.isArray(arr)) {
          const name = arr[1] ?? arr[0];
          return typeof name === "string" ? name : "";
        }
      } catch {
        // fall through
      }
      return "";
    }
  );

  // Other type… tokens (cite, image_group, etc.) — drop
  out = out.replace(/\uE200\w+\uE202[\s\S]*?\uE201/g, "");

  // After PUA glyphs are stripped (or never present), ChatGPT sometimes leaves
  // bare widget leftovers like: image_group{"query":"$4 Meal"} or cite{...}
  out = stripNamedJsonWidgets(out);

  // Any leftover Private Use Area glyphs
  out = out.replace(/[\uE000-\uF8FF]/g, "");

  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove `name{...}` / `name[...]` blobs ChatGPT embeds for media & cites.
 * Handles nested braces roughly so we don't leave `image_group{"query4 Meal**`.
 */
function stripNamedJsonWidgets(text: string): string {
  const names =
    "image_group|image|cite|entity|product|navlist|finance|sports|weather|map|file|snippet|search|products";
  const nameRe = new RegExp(`(?:^|\\s)(${names})(?=[\\{\\[])`, "gi");

  let out = text;
  let guard = 0;
  while (guard++ < 50) {
    nameRe.lastIndex = 0;
    const m = nameRe.exec(out);
    if (!m || m.index == null) break;
    const start = m.index + (m[0].startsWith(" ") || m[0].startsWith("\n") ? 1 : 0);
    const openIdx = start + m[1]!.length;
    const open = out[openIdx];
    if (open !== "{" && open !== "[") break;
    const close = open === "{" ? "}" : "]";
    const end = findMatching(out, openIdx, open, close);
    if (end < 0) {
      // Unbalanced — drop from widget name through end of line / next **
      out = out.slice(0, start) + out.slice(openIdx).replace(/^[^\n]*/, "");
      continue;
    }
    out = out.slice(0, start) + out.slice(end + 1);
  }

  // Catch any remaining `image_group…` fragments without braces
  out = out.replace(
    new RegExp(`\\b(?:${names})\\s*(?:\\{[^\\n]*|\\[[^\\n]*)`, "gi"),
    ""
  );

  // Bare widget names whose data was sent separately, e.g. a paragraph starting
  // "image_group He couldn't play…". Only names that are never ordinary words.
  out = out.replace(/(^|[^\w])(?:image_group|navlist)\b[^\S\n]*/gi, "$1");

  return out;
}

function findMatching(
  s: string,
  openIdx: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Segment {
  raw: string;
  code: boolean;
}

/** Split on ``` fences; an unclosed trailing fence (mid-stream) counts as code. */
function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose = "", code = "", fence = "";
  for (const line of text.split(/(?<=\n)/)) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && open) {
      if (prose) segments.push({ raw: prose, code: false });
      prose = ""; fence = open[1]; code = line;
    } else if (fence) {
      code += line;
      if (new RegExp("^ {0,3}" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$").test(line)) {
        segments.push({ raw: code, code: true }); code = ""; fence = "";
      }
    } else prose += line;
  }
  if (code) segments.push({ raw: code, code: true });
  if (prose) segments.push({ raw: prose, code: false });
  return segments;
}

export function formatReplyHtml(text: string): string {
  // A streaming cut can land inside a ChatGPT citation token; hide the tail.
  const cleaned = cleanChatGptText(text.replace(/\uE200[^\uE201]*$/, ""));
  return renderMarkdown(cleaned);
}
