import type { SiteAdapter } from "../core/types";

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
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

function findChatScrollContainer(): HTMLElement | null {
  // ChatGPT typically scrolls inside a main conversation pane.
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
  // Paths look like /c/<uuid> or /share/<id>
  const match = location.pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/);
  if (match) return match[2];
  // New/empty chats may have no id yet — use a session-scoped fallback.
  return `anon-${location.pathname || "root"}`;
}

export function createChatGptAdapter(): SiteAdapter {
  let warnedEmpty = false;
  let warnedNoScroll = false;

  const adapter: SiteAdapter = {
    siteId: "chatgpt",

    getConversationId(): string {
      return extractConversationIdFromUrl();
    },

    getMessageContainers(): HTMLElement[] {
      const turns = Array.from(
        document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR)
      );
      if (turns.length === 0 && !warnedEmpty) {
        console.warn(
          `[ai-helper] ChatGPT adapter: no messages matched selector "${ASSISTANT_SELECTOR}". ` +
            "The site DOM may have changed."
        );
        warnedEmpty = true;
      }
      if (turns.length > 0) {
        warnedEmpty = false;
      }

      // Prefer the markdown/prose body so highlight re-renders don't wipe
      // avatars, action buttons, or other chrome around the turn.
      return turns.map((turn) => {
        const content =
          turn.querySelector<HTMLElement>(
            ".markdown, .prose, [class*='markdown']"
          ) ?? turn;
        return content;
      });
    },

    getMessageId(el: HTMLElement): string {
      const turn =
        el.closest<HTMLElement>(ASSISTANT_SELECTOR) ?? el;
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
          // A stop button anywhere usually means generation is still running.
          // Prefer checking near this message if possible.
          const near = el.closest("article, [data-testid]") ?? el.parentElement;
          if (near?.querySelector(sel) || document.querySelector(sel)) {
            return false;
          }
        }
      }
      // Also treat messages still marked as streaming as incomplete when present.
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
        // Debounce ~500ms of quiet DOM before treating new nodes as settled.
        quietTimer = setTimeout(() => {
          reportExisting();
        }, 500);
      });

      observer.observe(root, { childList: true, subtree: true });

      // Also re-scan on SPA navigations (conversation switches).
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
