/**
 * Strip ChatGPT private-use citation / entity / media tokens into readable text.
 * Example: entity["people","Fred DeLuca","…"] → Fred DeLuca
 */
export function cleanChatGptText(text: string): string {
  if (!text) return "";

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

  // Collapse odd spaces left by removals, keep intentional newlines.
  // Code fences keep their whitespace so indentation survives.
  out = splitFences(out)
    .map((seg) =>
      seg.code
        ? seg.raw
        : seg.raw
            .replace(/[^\S\n]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
    )
    .join("");

  return out.trim();
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
  const re = /```[^\n]*(?:\n(?:[\s\S]*?\n)?```[^\n]*|[\s\S]*$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) segments.push({ raw: text.slice(last, m.index), code: false });
    segments.push({ raw: m[0], code: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) segments.push({ raw: text.slice(last), code: false });
  return segments;
}

/** Inline markdown on already-escaped text: `code`, **bold**, *italic*. */
function formatInline(escaped: string): string {
  const codes: string[] = [];
  let html = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  // Drop any stray ** that never closed (common mid-stream)
  html = html.replace(/\*\*/g, "");
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

function formatCodeBlock(raw: string): string {
  const firstNl = raw.indexOf("\n");
  const lang = (firstNl < 0 ? raw.slice(3) : raw.slice(3, firstNl)).trim();
  let body = firstNl < 0 ? "" : raw.slice(firstNl + 1);
  body = body.replace(/(?:^|\n)```[^\n]*$/, "");
  const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
  return `<div class="code-block">${label}<pre><code>${escapeHtml(body)}</code></pre></div>`;
}

type ListKind = "ul" | "ol";

function formatProse(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: ListKind; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((li) => `<li>${li}</li>`).join("");
      out.push(`<${list.kind}>${items}</${list.kind}>`);
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      out.push(`<p class="h">${formatInline(escapeHtml(heading[1]!))}</p>`);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(formatInline(escapeHtml(q[1]!)));
      continue;
    }
    flushQuote();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind: ListKind = bullet ? "ul" : "ol";
      flushPara();
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      list.items.push(formatInline(escapeHtml((bullet ?? numbered)![1]!)));
      continue;
    }
    if (list) {
      flushList();
    }
    para.push(formatInline(escapeHtml(line.trim())));
  }
  flushAll();
  return out.join("");
}

/**
 * Escape HTML then apply a small markdown subset for sidebar display:
 * paragraphs, headings, quotes, lists, code fences, inline code, bold, italic.
 */
export function formatReplyHtml(text: string): string {
  // A streaming cut can land inside a ChatGPT citation token; hide the tail.
  const cleaned = cleanChatGptText(text.replace(/\uE200[^\uE201]*$/, ""));
  return splitFences(cleaned)
    .map((seg) => (seg.code ? formatCodeBlock(seg.raw) : formatProse(seg.raw)))
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
