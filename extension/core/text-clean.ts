/**
 * Strip ChatGPT private-use citation / entity tokens into readable text.
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

  // Other type… tokens (cite, etc.) — drop
  out = out.replace(/\uE200\w+\uE202[\s\S]*?\uE201/g, "");

  // Any leftover Private Use Area glyphs
  out = out.replace(/[\uE000-\uF8FF]/g, "");

  // Collapse odd spaces left by removals, keep intentional newlines
  out = out.replace(/[^\S\n]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Escape HTML then apply a tiny markdown subset for sidebar display.
 */
export function formatReplyHtml(text: string): string {
  const cleaned = cleanChatGptText(text);
  let html = escapeHtml(cleaned);

  // **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // *italic* (avoid matching bold leftovers)
  html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  // Simple list lines: "- item" / "* item" at line start
  html = html.replace(/(^|\n)(?:-|\*) (.+)/g, "$1• $2");
  // Newlines → breaks
  html = html.replace(/\n/g, "<br>");

  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
