import {
  applyHighlightsToElement,
  attachSelectionHandler,
  getPlainText,
  type SelectionAnchor,
} from "./anchor";
import { Sidebar, sendAskFollowUp } from "./sidebar";
import { loadThreads, saveThreads } from "./storage";
import type { SiteAdapter, Thread } from "./types";

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
  let threads: Thread[] = await loadThreads(adapter.siteId, conversationId);
  const messageEls = new Map<string, HTMLElement>();

  const persist = async () => {
    await saveThreads(adapter.siteId, conversationId, threads);
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
    onSend: async (thread, question) => {
      const idx = threads.findIndex((t) => t.id === thread.id);
      if (idx < 0) return { ok: false, error: "Thread not found" };

      threads[idx] = {
        ...threads[idx],
        replies: [
          ...threads[idx].replies,
          { role: "user", text: question, ts: Date.now() },
        ],
      };
      await persist();
      sidebar.setThreads(threads);

      const result = await sendAskFollowUp({
        quotedText: thread.quotedText,
        surroundingContext: surroundingContext(thread),
        question,
        messageId: thread.messageId,
        threadId: thread.id,
      });

      if (result.ok && result.reply) {
        const i = threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) {
          threads[i] = {
            ...threads[i],
            replies: [
              ...threads[i].replies,
              { role: "assistant", text: result.reply, ts: Date.now() },
            ],
          };
          await persist();
          sidebar.setThreads(threads);
        }
      }
      return result;
    },
  });

  sidebar.setThreads(threads);

  const registerMessage = (el: HTMLElement) => {
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
    await persist();
    sidebar.setThreads(threads);
    sidebar.focusThread(thread.id);
    refreshHighlights();
  };

  const detachSelection = attachSelectionHandler(
    () => adapter.getMessageContainers(),
    (anchor) => {
      void onAsk(anchor);
    }
  );

  adapter.onNewMessage((el) => registerMessage(el));

  const convPoll = setInterval(() => {
    const next = adapter.getConversationId();
    if (next !== conversationId) {
      conversationId = next;
      void (async () => {
        threads = await loadThreads(adapter.siteId, conversationId);
        messageEls.clear();
        sidebar.setThreads(threads);
        for (const el of adapter.getMessageContainers()) {
          registerMessage(el);
        }
      })();
    }
  }, 1000);

  console.info(
    `[ai-helper] Engine started for site="${adapter.siteId}" conversation="${conversationId}" (${threads.length} threads loaded)`
  );

  return () => {
    detachSelection();
    clearInterval(convPoll);
  };
}
