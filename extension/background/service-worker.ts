import type {
  AskFollowUpRequest,
  AskFollowUpResponse,
} from "../core/types";

/**
 * Background service worker.
 *
 * Follow-up questions are routed here (not from the content script) so API
 * keys and provider selection never live on the host page.
 *
 * TODO: Wire a real backend / multi-model router here. Routing must NOT depend
 * on which site the highlight came from — only on the quoted snippet, context,
 * and question. Possible shape:
 *   async function callModel(req): Promise<string> { ... }
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

    void handleAskFollowUp(message).then(sendResponse);
    // Keep the message channel open for the async response.
    return true;
  }
);

async function handleAskFollowUp(
  req: AskFollowUpRequest
): Promise<AskFollowUpResponse> {
  try {
    // --- Stub: fake echo so the full loop works end-to-end ---
    // TODO: Replace this block with a real API call / multi-model router.
    const reply = [
      `(stub) You asked about: "${truncate(req.quotedText, 120)}"`,
      "",
      `Question: ${req.question}`,
      "",
      "This is a placeholder response from the background service worker.",
      "Wire your backend or provider SDK here — do not call APIs from the content script.",
    ].join("\n");

    // Small delay so the UI can show a brief "sending" state.
    await delay(300);

    return { ok: true, reply };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.info("[ai-helper] Service worker ready");
