import type { SiteAdapter } from "../core/types";
import { createDomAdapter } from "./dom-adapter";

const ASSISTANT = '[data-testid="assistant-message"]';
const USER = '[data-testid="user-message"]';

export function createClaudeAdapter(): SiteAdapter {
  return createDomAdapter({
    siteId: "claude",
    assistantSelectors: [ASSISTANT],
    assistantFallbackSelectors: [".font-claude-response", ".font-claude-message"],
    userSelectors: [USER],
    contentSelector: ".font-claude-response, .font-claude-message",
    streamingSelectors: ['[data-is-streaming="true"]'],
    stopButtonSelectors: [],
    // The transcript is virtualized; rows mount/unmount inside this list.
    chatRootSelectors: [
      '[data-testid="transcript-list"]',
      '[data-testid="chat-column"]',
      "main",
    ],
    conversationIdFromPath: (pathname) =>
      pathname.match(/\/chat\/([0-9a-f-]{8,})/i)?.[1] ?? null,
    messageIdFor: (turn) => {
      const index = turn
        .closest('[data-testid="transcript-row"]')
        ?.getAttribute("data-index");
      return index != null ? `row-${index}` : null;
    },
    excerptTurns: () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`${USER}, ${ASSISTANT}`)
      ).map((el) => ({
        role: el.matches(USER) ? ("user" as const) : ("assistant" as const),
        el,
      })),
  });
}
