import {
  applyHighlightsToElement,
  attachSelectionHandler,
  getPlainText,
  type SelectionAnchor,
} from "./anchor";
import { Sidebar, sendAskFollowUp } from "./sidebar";
import {
  EXTENSION_RELOAD_MSG,
  isExtensionAlive,
  isKnownSideConversation,
  loadThreads,
  rememberSideConversations,
  saveThreads,
} from "./storage";
import type { SiteAdapter, Thread } from "./types";

const EXCERPT_MAX_CHARS = 4000;
const HELPER_CHAT_BANNER =
  "This looks like a highlight helper chat from the extension — not your main conversation. Go back to the original ChatGPT chat before adding threads.";

function createId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Boots the highlight-to-thread engine for a given site adapter:
 * loads persisted threads, attaches selection UI, renders marks, and
 * keeps the Shadow DOM sidebar in sync.
 */
export async function bootEngine(adapter: SiteAdapter): Promise<() => void> {
  let conversationId = adapter.getConversationId();
  let helperChat = await isKnownSideConversation(
    adapter.siteId,
    conversationId
  );
  let threads: Thread[] = helperChat
    ? []
    : await loadThreads(adapter.siteId, conversationId);
  const messageEls = new Map<string, HTMLElement>();
  let dead = false;

  const markDead = (err?: unknown) => {
    if (dead) return;
    dead = true;
    const msg =
      err instanceof Error && /reload this/i.test(err.message)
        ? err.message
        : EXTENSION_RELOAD_MSG;
    console.warn("[ai-helper]", msg, err instanceof Error ? err.message : err);
  };

  const persist = async () => {
    if (!isExtensionAlive()) {
      markDead();
      throw new Error(EXTENSION_RELOAD_MSG);
    }
    try {
      await saveThreads(adapter.siteId, conversationId, threads);
    } catch (err) {
      markDead(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const surroundingContext = (thread: Thread): string => {
    const el = messageEls.get(thread.messageId);
    if (!el) return thread.quotedText;
    const raw = el.dataset.aiHelperRaw || getPlainText(el);
    const pad = 200;
    const start = Math.max(0, thread.anchorStart - pad);
    const end = Math.min(raw.length, thread.anchorEnd + pad);
    return raw.slice(start, end);
  };

  const conversationExcerpt = (): string => {
    if (typeof adapter.getConversationExcerpt === "function") {
      return adapter.getConversationExcerpt(EXCERPT_MAX_CHARS);
    }
    return "";
  };

  const bindMarkClicks = () => {
    for (const el of messageEls.values()) {
      el.querySelectorAll("mark[data-thread-id]").forEach((mark) => {
        const htmlMark = mark as HTMLElement;
        if (htmlMark.dataset.aiHelperBound) return;
        htmlMark.dataset.aiHelperBound = "1";
        htmlMark.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = htmlMark.dataset.threadId;
          if (id) sidebar.focusThread(id);
        });
      });
    }
  };

  const refreshHighlights = () => {
    for (const [messageId, el] of messageEls) {
      if (!adapter.isMessageComplete(el)) continue;
      const forMessage = threads.filter((t) => t.messageId === messageId);
      applyHighlightsToElement(el, forMessage);
    }
    bindMarkClicks();
  };

  const sidebar = new Sidebar({
    onFocusThread: (threadId) => {
      const mark = document.querySelector(
        `mark[data-thread-id="${CSS.escape(threadId)}"]`
      ) as HTMLElement | null;
      if (mark) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        mark.style.outline = "2px solid #c9a227";
        setTimeout(() => {
          mark.style.outline = "";
        }, 1200);
      }
    },
    onSend: async (thread, question, onPartial) => {
      if (helperChat) {
        return { ok: false, error: HELPER_CHAT_BANNER };
      }
      if (!isExtensionAlive()) {
        markDead();
        return { ok: false, error: EXTENSION_RELOAD_MSG };
      }
      const idx = threads.findIndex((t) => t.id === thread.id);
      if (idx < 0) return { ok: false, error: "Thread not found" };

      const current = threads[idx];
      threads[idx] = {
        ...current,
        replies: [
          ...current.replies,
          { role: "user", text: question, ts: Date.now() },
        ],
      };
      try {
        await persist();
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      sidebar.setThreads(threads);
      sidebar.focusThread(thread.id);

      const result = await sendAskFollowUp(
        {
          siteId: adapter.siteId,
          quotedText: current.quotedText,
          surroundingContext: surroundingContext(current),
          conversationExcerpt: conversationExcerpt(),
          question,
          messageId: current.messageId,
          threadId: current.id,
          sideConversationId: current.sideConversationId,
          sideParentMessageId: current.sideParentMessageId,
        },
        onPartial
      );

      if (result.ok && result.reply) {
        const i = threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) {
          threads[i] = {
            ...threads[i],
            sideConversationId:
              result.sideConversationId ?? threads[i].sideConversationId,
            sideParentMessageId:
              result.sideParentMessageId ?? threads[i].sideParentMessageId,
            replies: [
              ...threads[i].replies,
              { role: "assistant", text: result.reply, ts: Date.now() },
            ],
          };
          if (result.sideConversationId) {
            void rememberSideConversations(adapter.siteId, [
              result.sideConversationId,
            ]);
          }
          try {
            await persist();
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
          sidebar.setThreads(threads);
        }
      }
      return result;
    },
  });

  sidebar.setThreads(threads);
  sidebar.setBanner(helperChat ? HELPER_CHAT_BANNER : null);

  const registerMessage = (el: HTMLElement) => {
    if (helperChat) return;
    const messageId = adapter.getMessageId(el);
    messageEls.set(messageId, el);

    const applyWhenReady = () => {
      if (!adapter.isMessageComplete(el)) {
        setTimeout(applyWhenReady, 400);
        return;
      }
      if (!el.dataset.aiHelperRaw) {
        el.dataset.aiHelperRaw = getPlainText(el);
      }
      const forMessage = threads.filter((t) => t.messageId === messageId);
      applyHighlightsToElement(el, forMessage);
      bindMarkClicks();
    };
    applyWhenReady();
  };

  const onAsk = async (anchor: SelectionAnchor) => {
    if (helperChat) {
      sidebar.setBanner(HELPER_CHAT_BANNER);
      console.warn("[ai-helper]", HELPER_CHAT_BANNER);
      return;
    }
    if (!isExtensionAlive()) {
      markDead();
      console.warn("[ai-helper]", EXTENSION_RELOAD_MSG);
      return;
    }
    const messageId = adapter.getMessageId(anchor.messageRoot);
    messageEls.set(messageId, anchor.messageRoot);

    if (!anchor.messageRoot.dataset.aiHelperRaw) {
      anchor.messageRoot.dataset.aiHelperRaw = getPlainText(
        anchor.messageRoot
      );
    }

    const overlapping = threads.some(
      (t) =>
        t.messageId === messageId &&
        !(anchor.end <= t.anchorStart || anchor.start >= t.anchorEnd)
    );
    if (overlapping) {
      console.warn(
        "[ai-helper] Selection overlaps an existing highlight; create skipped."
      );
      return;
    }

    const thread: Thread = {
      id: createId(),
      messageId,
      anchorStart: anchor.start,
      anchorEnd: anchor.end,
      quotedText: anchor.quotedText,
      replies: [],
    };
    threads = [...threads, thread];
    try {
      await persist();
    } catch (err) {
      threads = threads.filter((t) => t.id !== thread.id);
      console.warn(
        "[ai-helper] could not save new thread:",
        err instanceof Error ? err.message : err
      );
      return;
    }
    sidebar.setThreads(threads);
    sidebar.focusThread(thread.id);
    refreshHighlights();
  };

  const detachSelection = attachSelectionHandler(
    () => (helperChat ? [] : adapter.getMessageContainers()),
    (anchor) => {
      void onAsk(anchor);
    }
  );

  adapter.onNewMessage((el) => registerMessage(el));

  const switchConversation = async (next: string) => {
    conversationId = next;
    helperChat = await isKnownSideConversation(adapter.siteId, next);
    messageEls.clear();
    if (helperChat) {
      threads = [];
      sidebar.setThreads(threads);
      sidebar.setBanner(HELPER_CHAT_BANNER);
      return;
    }
    sidebar.setBanner(null);
    threads = await loadThreads(adapter.siteId, conversationId);
    sidebar.setThreads(threads);
    for (const el of adapter.getMessageContainers()) {
      registerMessage(el);
    }
  };

  const convPoll = setInterval(() => {
    if (dead || !isExtensionAlive()) {
      markDead();
      clearInterval(convPoll);
      return;
    }
    const next = adapter.getConversationId();
    if (next !== conversationId) {
      void switchConversation(next);
    }
  }, 1000);

  // Index any side ids already stored on loaded threads.
  const existingSideIds = threads
    .map((t) => t.sideConversationId)
    .filter((id): id is string => Boolean(id));
  if (existingSideIds.length) {
    void rememberSideConversations(adapter.siteId, existingSideIds);
  }

  console.info(
    `[ai-helper] Engine started for site="${adapter.siteId}" conversation="${conversationId}" (${threads.length} threads loaded)${
      helperChat ? " [helper-chat]" : ""
    }`
  );

  return () => {
    detachSelection();
    clearInterval(convPoll);
  };
}
