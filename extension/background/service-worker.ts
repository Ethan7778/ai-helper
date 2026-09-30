import type {
  AskFollowUpRequest,
  AskFollowUpResponse,
} from "../core/types";
import { createLogger } from "../core/log";

const log = createLogger("service-worker");

/** Sites whose follow-ups run in the content script via the logged-in session. */
const IN_PAGE_SITES = new Set(["chatgpt", "claude", "gemini"]);

/**
 * Background service worker.
 *
 * ChatGPT, Claude, and Gemini follow-ups complete in the content script
 * (direct path) to avoid nested CS↔SW messaging during long streams.
 *
 * This worker remains the routing point for future official-API providers.
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

    if (IN_PAGE_SITES.has(message.siteId)) {
      // Should not normally arrive — the content script handles these locally.
      log.warn(
        `Received ${message.siteId} ask-follow-up in SW; content script should handle this directly.`
      );
      sendResponse({
        ok: false,
        error:
          "Follow-ups must run in the page script. Reload the tab and try again.",
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

log.debug("Service worker ready (follow-ups run in-page)");
