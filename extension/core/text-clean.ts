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

  // Collapse odd spaces left by removals, keep intentional newlines
  out = out.replace(/[^\S\n]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");

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

/**
 * Escape HTML then apply a tiny markdown subset for sidebar display.
 */
export function formatReplyHtml(text: string): string {
  const cleaned = cleanChatGptText(text);
  let html = escapeHtml(cleaned);

  // Headings / blockquotes on real newlines first
  html = html.replace(/(^|\n)#{1,6}\s+/g, "$1");
  html = html.replace(/(^|\n)&gt;\s?/g, "$1");

  // **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // *italic* (avoid matching bold leftovers)
  html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  // Simple list lines: "- item" / "* item" at line start
  html = html.replace(/(^|\n)(?:-|\*) (.+)/g, "$1• $2");
  // Newlines → breaks
  html = html.replace(/\n/g, "<br>");

  // Drop any stray ** that never closed
  html = html.replace(/\*\*/g, "");

  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
