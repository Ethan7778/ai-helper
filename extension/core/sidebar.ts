import type { AskFollowUpRequest, AskFollowUpResponse, Thread } from "./types";
import { formatReplyHtml } from "./text-clean";
import { fetchAccessTokenFromPage } from "./chatgpt-auth";
import { completeViaChatGptSession } from "../background/chatgpt-session";

const HOST_ID = "ai-helper-sidebar-host";

export interface SidebarCallbacks {
  onFocusThread: (threadId: string) => void;
  onSend: (
    thread: Thread,
    question: string,
    onPartial?: (text: string) => void
  ) => Promise<{ ok: boolean; reply?: string; error?: string }>;
}

const STYLES = `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
}
.fab {
  position: fixed;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  width: 28px;
  height: 72px;
  padding: 0;
  border: 1px solid #d8d8d4;
  border-radius: 8px;
  background: #f7f7f5;
  color: #333;
  font: 600 11px/1 "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,0.12);
  writing-mode: vertical-rl;
  text-orientation: mixed;
  letter-spacing: 0.04em;
  display: none;
}
.fab.visible {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: 360px;
  max-width: min(360px, 100vw);
  background: #f7f7f5;
  color: #1a1a1a;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  border-left: 1px solid #d8d8d4;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  z-index: 2147483646;
  transform: translateX(0);
  transition: transform 0.2s ease;
  pointer-events: auto;
}
.panel.collapsed {
  transform: translateX(100%);
  box-shadow: none;
  pointer-events: none;
}
.header {
  padding: 14px 16px;
  border-bottom: 1px solid #e4e4e0;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.header span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.collapse-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #555;
  padding: 4px;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.empty {
  color: #777;
  padding: 20px 12px;
  text-align: center;
}
.card {
  background: #fff;
  border: 1px solid #e4e4e0;
  border-radius: 8px;
  margin-bottom: 10px;
  overflow: hidden;
}
.card.active {
  border-color: #c9a227;
  box-shadow: 0 0 0 1px #c9a22733;
}
.card-header {
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.card-header-main {
  flex: 1;
  min-width: 0;
}
.close-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: #888;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 4px;
}
.close-btn:hover {
  background: #eee;
  color: #333;
}
.reply.streaming .body::after {
  content: "|";
  display: inline-block;
  margin-left: 1px;
  animation: blink 1s step-end infinite;
  color: #888;
}
@keyframes blink {
  50% { opacity: 0; }
}
.quote {
  font-style: italic;
  color: #444;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  margin-top: 4px;
  font-size: 11px;
  color: #888;
}
.card-body {
  display: none;
  border-top: 1px solid #eee;
  padding: 10px 12px 12px;
}
.card.expanded .card-body {
  display: block;
}
.replies {
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 10px;
}
.reply {
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 6px;
}
.reply.user {
  background: #eef3ff;
}
.reply.assistant {
  background: #f3f3f0;
}
.reply .role {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #888;
  margin-bottom: 2px;
}
.reply .body {
  white-space: normal;
  word-break: break-word;
}
.reply .body strong {
  font-weight: 600;
}
.reply .body em {
  font-style: italic;
}
.composer {
  display: flex;
  gap: 6px;
}
.composer input {
  flex: 1;
  border: 1px solid #d0d0cc;
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  background: #fff;
  color: #111;
}
.composer button {
  border: none;
  border-radius: 6px;
  padding: 8px 12px;
  background: #1a1a1a;
  color: #fff;
  font: inherit;
  cursor: pointer;
}
.composer button:disabled {
  opacity: 0.5;
  cursor: default;
}
.status {
  margin-top: 6px;
  font-size: 11px;
  color: #a33;
}
`;

export class Sidebar {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private panel!: HTMLElement;
  private fab!: HTMLButtonElement;
  private listEl!: HTMLElement;
  private threads: Thread[] = [];
  private expanded = new Set<string>();
  private activeId: string | null = null;
  /** Start collapsed so we don't cover ChatGPT chrome until needed. */
  private collapsed = true;
  private callbacks: SidebarCallbacks;

  constructor(callbacks: SidebarCallbacks) {
    this.callbacks = callbacks;

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.body.appendChild(host);
    }
    this.host = host;
    this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    this.renderShell();
  }

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    this.renderList();
  }

  focusThread(threadId: string): void {
    this.expanded.add(threadId);
    this.activeId = threadId;
    this.setCollapsed(false);
    this.renderList();
    const card = this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"]`
    ) as HTMLElement | null;
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** Update the in-flight assistant bubble without rebuilding the whole list. */
  patchAssistantReply(threadId: string, text: string): void {
    const card = this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"]`
    );
    if (!card) return;
    const replies = card.querySelector(".replies");
    if (!replies) return;

    let live = replies.querySelector(
      ".reply.assistant.streaming"
    ) as HTMLElement | null;
    if (!live) {
      live = document.createElement("div");
      live.className = "reply assistant streaming";
      live.innerHTML = `<div class="role">assistant</div><div class="body"></div>`;
      replies.appendChild(live);
    }
    const body = live.querySelector(".body");
    if (body) body.innerHTML = formatReplyHtml(text) || "&nbsp;";
    replies.scrollTop = replies.scrollHeight;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel.classList.toggle("collapsed", collapsed);
    this.fab.classList.toggle("visible", collapsed);
    this.fab.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  private renderShell(): void {
    this.shadow.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    this.fab = document.createElement("button");
    this.fab.type = "button";
    this.fab.className = "fab visible";
    this.fab.title = "Open highlight threads";
    this.fab.setAttribute("aria-label", "Open highlight threads");
    this.fab.textContent = "Threads";
    this.fab.addEventListener("click", () => this.setCollapsed(false));
    this.shadow.appendChild(this.fab);

    this.panel = document.createElement("div");
    this.panel.className = "panel collapsed";
    this.panel.innerHTML = `
      <div class="header">
        <span>Highlight threads</span>
        <button type="button" class="collapse-btn" title="Collapse" aria-label="Collapse">›</button>
      </div>
      <div class="list"></div>
    `;
    this.shadow.appendChild(this.panel);
    this.listEl = this.panel.querySelector(".list") as HTMLElement;

    this.panel.querySelector(".collapse-btn")?.addEventListener("click", () => {
      this.setCollapsed(true);
    });
  }

  private renderList(): void {
    if (this.threads.length === 0) {
      this.listEl.innerHTML = `<div class="empty">Highlight text in a reply and click “Ask about this” to start a thread.</div>`;
      return;
    }

    this.listEl.innerHTML = "";
    for (const thread of this.threads) {
      this.listEl.appendChild(this.buildCard(thread));
    }
  }

  private buildCard(thread: Thread): HTMLElement {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.threadId = thread.id;
    if (this.expanded.has(thread.id)) card.classList.add("expanded");
    if (this.activeId === thread.id) card.classList.add("active");

    const header = document.createElement("div");
    header.className = "card-header";

    const main = document.createElement("div");
    main.className = "card-header-main";
    main.innerHTML = `
      <div class="quote">${escapeHtml(thread.quotedText)}</div>
      <div class="meta">${thread.replies.length} ${
      thread.replies.length === 1 ? "reply" : "replies"
    }</div>
    `;
    main.addEventListener("click", () => {
      if (this.expanded.has(thread.id)) {
        this.expanded.delete(thread.id);
      } else {
        this.expanded.add(thread.id);
      }
      this.activeId = thread.id;
      this.callbacks.onFocusThread(thread.id);
      this.renderList();
    });

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "close-btn";
    const isExpanded = this.expanded.has(thread.id);
    collapseBtn.title = isExpanded ? "Collapse thread" : "Expand thread";
    collapseBtn.setAttribute(
      "aria-label",
      isExpanded ? "Collapse thread" : "Expand thread"
    );
    collapseBtn.textContent = isExpanded ? "▾" : "▸";
    collapseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.expanded.has(thread.id)) {
        this.expanded.delete(thread.id);
      } else {
        this.expanded.add(thread.id);
        this.activeId = thread.id;
        this.callbacks.onFocusThread(thread.id);
      }
      this.renderList();
    });

    header.appendChild(main);
    header.appendChild(collapseBtn);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "card-body";

    const replies = document.createElement("div");
    replies.className = "replies";
    for (const r of thread.replies) {
      const div = document.createElement("div");
      div.className = `reply ${r.role}`;
      div.innerHTML = `<div class="role">${r.role}</div><div class="body">${
        r.role === "assistant" ? formatReplyHtml(r.text) : escapeHtml(r.text)
      }</div>`;
      replies.appendChild(div);
    }
    body.appendChild(replies);

    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Ask about this snippet…";
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send";
    const status = document.createElement("div");
    status.className = "status";

    const doSend = async () => {
      const question = input.value.trim();
      if (!question) return;
      send.disabled = true;
      status.textContent = "";
      try {
        const result = await this.callbacks.onSend(
          thread,
          question,
          (partial) => this.patchAssistantReply(thread.id, partial)
        );
        if (!result.ok) {
          status.textContent = result.error || "Request failed";
        } else {
          input.value = "";
        }
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        send.disabled = false;
        if (this.threads.some((t) => t.id === thread.id)) {
          this.renderList();
          this.focusThread(thread.id);
        } else {
          this.renderList();
        }
      }
    };

    send.addEventListener("click", () => void doSend());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doSend();
      }
    });

    composer.appendChild(input);
    composer.appendChild(send);
    body.appendChild(composer);
    body.appendChild(status);
    card.appendChild(body);
    return card;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Ask a follow-up about a highlight.
 *
 * ChatGPT runs entirely in the content script (no CS↔SW↔CS nested messaging).
 * That nested pattern closes the message channel before long handoff/WS work
 * finishes. Other sites can still route through the service worker later.
 */
export async function sendAskFollowUp(
  payload: Omit<AskFollowUpRequest, "type">,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  const message: AskFollowUpRequest = { type: "ask-follow-up", ...payload };

  if (payload.siteId === "chatgpt") {
    try {
      console.info(
        "[ai-helper][chatgpt-session] Completing follow-up in page (direct path)"
      );
      const creds = await fetchAccessTokenFromPage();
      return await completeViaChatGptSession(creds, message, onPartial);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[ai-helper][chatgpt-session] complete failed:", error);
      return { ok: false, error };
    }
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: AskFollowUpResponse) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      resolve(response ?? { ok: false, error: "Empty response" });
    });
  });
}
