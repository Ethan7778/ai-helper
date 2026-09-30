import type { SiteAdapter } from "../core/types";
import { createDomAdapter } from "./dom-adapter";

const ROLE_SELECTOR =
  "[data-message-author-role], [data-turn], [data-turn-role]";

export function createChatGptAdapter(): SiteAdapter {
  return createDomAdapter({
    siteId: "chatgpt",
    assistantSelectors: [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn-role="assistant"]',
      '[data-testid="assistant-message"]',
    ],
    assistantFallbackSelectors: [".agent-turn"],
    userSelectors: [
      '[data-message-author-role="user"]',
      '[data-turn="user"]',
      'article[data-turn-role="user"]',
    ],
    contentSelector:
      ".markdown, .prose, [class*='markdown'], [class*='prose'], .whitespace-pre-wrap",
    streamingSelectors: ['[data-is-streaming="true"]', ".result-streaming"],
    // data-testid is language-independent; aria-labels are English-only fallbacks.
    stopButtonSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
    ],
    chatRootSelectors: ["main", '[role="main"]'],
    conversationIdFromPath: (pathname) =>
      pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/)?.[2] ?? null,
    messageIdFor: (turn) =>
      turn.getAttribute("data-message-id") ||
      turn.getAttribute("data-testid") ||
      turn.id ||
      null,
    excerptTurns: () =>
      Array.from(document.querySelectorAll<HTMLElement>(ROLE_SELECTOR)).flatMap(
        (el) => {
          const role =
            el.getAttribute("data-message-author-role") ||
            el.getAttribute("data-turn") ||
            el.getAttribute("data-turn-role");
          return role === "user" || role === "assistant" ? [{ role, el }] : [];
        }
      ),
  });
}
