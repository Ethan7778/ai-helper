import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const markdown = new Marked({
  gfm: true,
  breaks: true,
  extensions: [{
    name: "writingCard",
    level: "block",
    start(source) { return source.search(/^ {0,3}:::writing(?:\{|[ \t]*(?:\n|$))/m); },
    tokenizer(source) {
      const header = /^ {0,3}:::writing(?:\{[^\n]*|[ \t]*)(?:\n|$)/.exec(source);
      if (!header) return;
      const titleMatch = /\btitle\s*=\s*("(?:[^"\\]|\\.)*")/.exec(header[0]);
      let title = "Writing";
      try { if (titleMatch) title = JSON.parse(titleMatch[1]); } catch { /* Partial streamed title. */ }
      let offset = header[0].length, body = "", fence = "";
      for (const line of source.slice(offset).split(/(?<=\n)/)) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
          if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)$`).test(line)) fence = "";
        } else if (marker) fence = marker[1];
        else if (/^ {0,3}:::[ \t]*(?:\n|$)$/.test(line)) {
          offset += line.length;
          return { type: "writingCard", raw: source.slice(0, offset), title, tokens: this.lexer.blockTokens(body) };
        }
        body += line; offset += line.length;
      }
      // An open card is common while tokens are still arriving.
      return { type: "writingCard", raw: source.slice(0, offset), title, tokens: this.lexer.blockTokens(body) };
    },
    renderer(token) {
      return `<div class="writing-card"><div class="writing-title">${escape(String(token.title))}</div><div class="writing-content">${this.parser.parse(token.tokens || [])}</div></div>`;
    },
  }, {
    name: "sidebarMath",
    level: "inline",
    start(source) { return source.search(/\\[([]|\$/); },
    tokenizer(source) {
      const match = /^(?:\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d))/.exec(source);
      if (!match) return;
      return { type: "sidebarMath", raw: match[0], text: match[1] ?? match[2] ?? match[3] ?? match[4], display: match[1] !== undefined || match[3] !== undefined };
    },
    renderer(token) {
      return `<span class="${token.display ? "math-display" : "math-inline"}">${katex.renderToString(token.text, { output: "mathml", displayMode: token.display, throwOnError: false, trust: false })}</span>`;
    },
  }],
  renderer: {
    html({ text }) { return escape(text); },
    code({ text, lang }) {
      const language = (lang || "").split(/\s/)[0].toLowerCase();
      // Unknown languages remain plain code; never guess prose as executable HTML.
      const value = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escape(text);
      return `<div class="code-block"><div class="code-lang">${escape(language || "text")}</div><pre><code>${value}</code></pre></div>`;
    },
    image({ text }) { return escape(text || "[image]"); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return label;
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

/** Bundle the parser, sanitizer and language grammars; no remote scripts. */
export function renderMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "ul", "ol", "li", "blockquote", "pre", "code", "div", "span", "table", "thead", "tbody", "tr", "th", "td", "hr", "a", "input", "math", "semantics", "annotation", "mrow", "mi", "mo", "mn", "mtext", "mspace", "mfrac", "msup", "msub", "msubsup", "msqrt", "mroot", "mtable", "mtr", "mtd", "mover", "munder", "munderover", "menclose", "mpadded", "mstyle", "mfenced", "mmultiscripts", "mprescripts", "none"],
    ALLOWED_ATTR: ["class", "href", "target", "rel", "start", "align", "type", "checked", "disabled", "xmlns", "display", "encoding", "stretchy", "mathvariant", "accent", "accentunder", "linethickness", "columnalign", "columnspacing", "rowspacing", "displaystyle", "scriptlevel", "lspace", "rspace", "width", "height", "depth", "notation", "voffset", "mathsize"],
    RETURN_TRUSTED_TYPE: false,
  });
}
