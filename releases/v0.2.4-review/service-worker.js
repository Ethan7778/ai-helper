"use strict";
(() => {
  // extension/core/log.ts
  var DEBUG_DEFAULT = false;
  var DEBUG_STORAGE_KEY = "ai-helper:debug";
  var PREFIX = "[ai-helper]";
  function readDebugOverride() {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }
  var DEBUG = DEBUG_DEFAULT || readDebugOverride();
  function createLogger(scope) {
    const tag = scope ? `${PREFIX}[${scope}]` : PREFIX;
    return {
      debug: (...args) => {
        if (DEBUG) console.log(tag, ...args);
      },
      info: (...args) => console.info(tag, ...args),
      warn: (...args) => console.warn(tag, ...args),
      error: (...args) => console.error(tag, ...args)
    };
  }

  // extension/background/service-worker.ts
  var log = createLogger("service-worker");
  var IN_PAGE_SITES = /* @__PURE__ */ new Set(["chatgpt", "claude", "gemini"]);
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (!message || message.type !== "ask-follow-up") {
        return false;
      }
      if (IN_PAGE_SITES.has(message.siteId)) {
        log.warn(
          `Received ${message.siteId} ask-follow-up in SW; content script should handle this directly.`
        );
        sendResponse({
          ok: false,
          error: "Follow-ups must run in the page script. Reload the tab and try again."
        });
        return false;
      }
      sendResponse({
        ok: false,
        error: `No provider wired for siteId="${message.siteId}" yet.`
      });
      return false;
    }
  );
  log.debug("Service worker ready (follow-ups run in-page)");
})();
//# sourceMappingURL=service-worker.js.map
