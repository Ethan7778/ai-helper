import type { SiteAdapter } from "../core/types";
import { createDomAdapter } from "./dom-adapter";

export function createGeminiAdapter(): SiteAdapter {
  return createDomAdapter({
    siteId: "gemini",
    // Angular custom elements; far more stable than Gemini's generated classes.
    assistantSelectors: ["model-response"],
    assistantFallbackSelectors: [".model-response-text"],
    userSelectors: ["user-query"],
    // The answer body; `model-thoughts` sits before it and must not win.
    contentSelector: "message-content .markdown",
    streamingSelectors: ['[aria-busy="true"]'],
    stopButtonSelectors: [],
    chatRootSelectors: [
      '[data-test-id="chat-history-container"]',
      "infinite-scroller.chat-history",
      "chat-window",
      "main",
    ],
    conversationIdFromPath: (pathname) =>
      pathname.match(/\/(?:app|gem\/[^/]+)\/([0-9a-f]{8,})/i)?.[1] ?? null,
    messageIdFor: (turn) => {
      const id = turn.querySelector("message-content[id]")?.id;
      return id ? id.replace(/^message-content-id-/, "") : null;
    },
    excerptTurns: () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("user-query, model-response")
      ).map((el) => ({
        role:
          el.tagName.toLowerCase() === "user-query"
            ? ("user" as const)
            : ("assistant" as const),
        el,
      })),
  });
}
