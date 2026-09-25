import type {
  AskFollowUpRequest,
  AskFollowUpResponse,
} from "../core/types";

const LOG = "[ai-helper][chatgpt-session]";

/**
 * Background service worker.
 *
 * ChatGPT follow-ups complete in the content script (direct path) to avoid
 * nested CS↔SW messaging during long WebSocket handoffs.
 *
 * This worker remains the routing point for future non-ChatGPT / official APIs.
 */
chrome.runtime.onMessage.addListener(
  (
    message: AskFollowUpRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: AskFollowUpResponse) => void
  ) => {
    if (!message || message.type !== "ask-follow-up") {
      return false;
    }

    if (message.siteId === "chatgpt") {
      // Should not normally arrive — content script handles ChatGPT locally.
      console.warn(
        `${LOG} Received chatgpt ask-follow-up in SW; content script should handle this directly.`
      );
      sendResponse({
        ok: false,
        error:
          "ChatGPT follow-ups must run in the page script. Reload chatgpt.com and try again.",
      });
      return false;
    }

    sendResponse({
      ok: false,
      error: `No provider wired for siteId="${message.siteId}" yet.`,
    });
    return false;
  }
);

console.info(
  "[ai-helper] Service worker ready (ChatGPT follow-ups run in-page)"
);
