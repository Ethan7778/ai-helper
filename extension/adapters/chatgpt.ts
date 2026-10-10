import type { SiteAdapter } from "../core/types";
import { createDomAdapter } from "./dom-adapter";

const MODERN_USER_SELECTORS = [
  '[data-content-search-unit-key$=":user"]',
  '[data-chatgpt-search-unit-key$=":user"]',
];
const ROLE_SELECTOR = [
  "[data-message-author-role]",
  "[data-turn]",
  "[data-turn-role]",
  '[data-content-search-unit-key$=":assistant"]',
  '[data-content-search-unit-key$=":user"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  '[data-chatgpt-search-unit-key$=":user"]',
].join(", ");

function roleFor(el: HTMLElement): "user" | "assistant" | null {
  const legacyRole =
    el.getAttribute("data-message-author-role") ||
    el.getAttribute("data-turn") ||
    el.getAttribute("data-turn-role");
  if (legacyRole === "user" || legacyRole === "assistant") {
    return legacyRole;
  }
  const searchKey =
    el.getAttribute("data-content-search-unit-key") ||
    el.getAttribute("data-chatgpt-search-unit-key");
  if (searchKey?.endsWith(":assistant")) return "assistant";
  if (searchKey?.endsWith(":user")) return "user";
  return null;
}

export function createChatGptAdapter(): SiteAdapter {
  return createDomAdapter({
    siteId: "chatgpt",

    selectionStrategy: "native-sticky",
    preferOutermostAssistant: true,
    useAssistantTurnAsContentRoot: true,

    dockFixups: [
      'body :is([class^="Layout-"], [class*=" Layout-"]) { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }',
      "body .w-screen { width: 100% !important; }",
      "body .max-w-screen { max-width: 100% !important; }",
      "body .min-w-screen { min-width: 0 !important; }",
    ],

    assistantSelectors: [
      '[data-content-search-unit-key$=":assistant"]',
      '[data-chatgpt-search-unit-key$=":assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]',
      'article[data-turn="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn-role="assistant"]',
      '[data-testid="assistant-message"]',
    ],

    assistantFallbackSelectors: [".agent-turn"],

    userSelectors: [
      ...MODERN_USER_SELECTORS,
      '[data-message-author-role="user"]',
      '[data-turn="user"]',
      'article[data-turn-role="user"]',
    ],

    contentSelector:
      '.markdown, .prose, [class*="markdown" i], [class*="prose" i], [data-markdown-text-style="assistant-message"], .whitespace-pre-wrap',
    streamingSelectors: ['[data-is-streaming="true"]', ".result-streaming"],
    // data-testid is language-independent; aria-labels are English-only fallbacks.
    stopButtonSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
    ],
    chatRootSelectors: [
      '[data-thread-find-target="conversation"]',
      "main",
      '[role="main"]',
    ],
    conversationIdFromPath: (pathname) =>
      pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/)?.[2] ?? null,
    messageIdFor: (turn) =>
      turn
        .closest("[data-chatgpt-selection-message-id]")
        ?.getAttribute("data-chatgpt-selection-message-id") ||
      turn.getAttribute("data-message-id") ||
      turn.getAttribute("data-testid") ||
      turn.id ||
      null,
    excerptTurns: () =>
      Array.from(document.querySelectorAll<HTMLElement>(ROLE_SELECTOR)).flatMap(
        (el) => {
          const role = roleFor(el);
          return role ? [{ role, el }] : [];
        }
      ),
  });
}
