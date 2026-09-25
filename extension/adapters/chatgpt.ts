import type { SiteAdapter } from "../core/types";

/** Prefer stable role attrs; fall back to newer turn markers ChatGPT experiments with. */
const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-turn="assistant"]',
  'article[data-turn-role="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-testid*="assistant"]',
  'div[class*="agent-turn"]',
];
const USER_SELECTORS = [
  '[data-message-author-role="user"]',
  '[data-turn="user"]',
  'article[data-turn-role="user"]',
];
const MESSAGE_CONTENT_SELECTORS =
  ".markdown, .prose, [class*='markdown'], [class*='prose'], .whitespace-pre-wrap";
const STOP_BUTTON_SELECTORS = [
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  '[data-testid="stop-button"]',
];

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function queryAll(selectors: string[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const out: HTMLElement[] = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function findChatScrollContainer(): HTMLElement | null {
  const candidates = [
    document.querySelector("main"),
    document.querySelector('[class*="react-scroll"]'),
    document.querySelector('[data-testid="conversation-turns"]')?.parentElement,
    document.body,
  ];
  for (const el of candidates) {
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

function extractConversationIdFromUrl(): string {
  const match = location.pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/);
  if (match) return match[2];
  return `anon-${location.pathname || "root"}`;
}

const ROLE_SELECTOR =
  "[data-message-author-role], [data-turn], [data-turn-role]";

export function createChatGptAdapter(): SiteAdapter {
  let warnedEmpty = false;
  let warnedNoScroll = false;
  let warnedEmptyExcerpt = false;

  const adapter: SiteAdapter = {
    siteId: "chatgpt",

    getConversationId(): string {
      return extractConversationIdFromUrl();
    },

    getConversationExcerpt(maxChars: number): string {
      const turns = Array.from(
        document.querySelectorAll<HTMLElement>(ROLE_SELECTOR)
      );
      if (turns.length === 0) {
        // Empty new chat — expected, stay quiet.
        return "";
      }
      warnedEmptyExcerpt = false;

      const chunks: string[] = [];
      for (const turn of turns) {
        const role =
          turn.getAttribute("data-message-author-role") ||
          turn.getAttribute("data-turn") ||
          turn.getAttribute("data-turn-role") ||
          "unknown";
        if (role !== "user" && role !== "assistant") continue;
        const body =
          turn.querySelector<HTMLElement>(
            ".markdown, .prose, [class*='markdown']"
          ) ?? turn;
        const text = (body.innerText || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        chunks.push(`${role.toUpperCase()}: ${text}`);
      }

      if (chunks.length === 0) {
        if (!warnedEmptyExcerpt) {
          console.warn(
            "[ai-helper][chatgpt-session] Conversation excerpt: turns present but no usable text."
          );
          warnedEmptyExcerpt = true;
        }
        return "";
      }

      let excerpt = "";
      for (let i = chunks.length - 1; i >= 0; i--) {
        const next = excerpt ? `${chunks[i]}\n\n${excerpt}` : chunks[i];
        if (next.length > maxChars) {
          if (!excerpt) {
            excerpt = chunks[i].slice(-maxChars);
          }
          break;
        }
        excerpt = next;
      }
      return excerpt;
    },

    getMessageContainers(): HTMLElement[] {
      const turns = queryAll(ASSISTANT_SELECTORS);
      const users = queryAll(USER_SELECTORS);

      // Only warn when the page clearly has chat content but assistants are missing.
      if (turns.length === 0 && users.length > 0 && !warnedEmpty) {
        console.warn(
          `[ai-helper] ChatGPT adapter: found user turns but no assistant messages ` +
            `(tried: ${ASSISTANT_SELECTORS.join(", ")}). The site DOM may have changed.`
        );
        warnedEmpty = true;
      }
      if (turns.length > 0) {
        warnedEmpty = false;
      }

      return turns.map((turn) => {
        const content =
          turn.querySelector<HTMLElement>(MESSAGE_CONTENT_SELECTORS) ?? turn;
        return content;
      });
    },

    getMessageId(el: HTMLElement): string {
      const turn =
        el.closest<HTMLElement>(ASSISTANT_SELECTORS.join(",")) ?? el;
      const fromAttr =
        turn.getAttribute("data-message-id") ||
        turn.getAttribute("data-testid") ||
        turn.id;
      if (fromAttr) return fromAttr;

      const containers = adapter.getMessageContainers();
      const index = containers.indexOf(el);
      const prefix = (el.innerText || "").slice(0, 80).replace(/\s+/g, " ");
      return `hash-${simpleHash(`${index}:${prefix}`)}`;
    },

    isMessageComplete(el: HTMLElement): boolean {
      for (const sel of STOP_BUTTON_SELECTORS) {
        if (document.querySelector(sel)) {
          const near = el.closest("article, [data-testid]") ?? el.parentElement;
          if (near?.querySelector(sel) || document.querySelector(sel)) {
            return false;
          }
        }
      }
      if (
        el.getAttribute("data-is-streaming") === "true" ||
        el.querySelector('[data-is-streaming="true"]')
      ) {
        return false;
      }
      return true;
    },

    onNewMessage(cb: (el: HTMLElement) => void): void {
      const seen = new WeakSet<HTMLElement>();

      const reportExisting = () => {
        for (const el of adapter.getMessageContainers()) {
          if (seen.has(el)) continue;
          seen.add(el);
          cb(el);
        }
      };

      reportExisting();

      const root = findChatScrollContainer();
      if (!root) {
        if (!warnedNoScroll) {
          console.error(
            "[ai-helper] ChatGPT adapter: could not find chat scroll container for MutationObserver."
          );
          warnedNoScroll = true;
        }
        return;
      }

      let quietTimer: ReturnType<typeof setTimeout> | null = null;

      const observer = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          reportExisting();
        }, 500);
      });

      observer.observe(root, { childList: true, subtree: true });

      let lastHref = location.href;
      setInterval(() => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          warnedEmpty = false;
          reportExisting();
        }
      }, 1000);
    },
  };

  return adapter;
}
