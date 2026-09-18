import type { AskFollowUpRequest, AskFollowUpResponse, Thread } from "./types";

const HOST_ID = "ai-helper-sidebar-host";

export interface SidebarCallbacks {
  onFocusThread: (threadId: string) => void;
  onSend: (
    thread: Thread,
    question: string
  ) => Promise<{ ok: boolean; reply?: string; error?: string }>;
}

const STYLES = `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
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
  z-index: 2147483647;
  transform: translateX(0);
  transition: transform 0.2s ease;
}
.panel.collapsed {
  transform: translateX(calc(100% - 40px));
}
.toggle {
  position: absolute;
  left: -40px;
  top: 72px;
  width: 40px;
  height: 40px;
  border: 1px solid #d8d8d4;
  border-right: none;
  border-radius: 8px 0 0 8px;
  background: #f7f7f5;
  cursor: pointer;
  font-size: 16px;
  color: #333;
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
  private listEl!: HTMLElement;
  private threads: Thread[] = [];
  private expanded = new Set<string>();
  private activeId: string | null = null;
  private collapsed = false;
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
    this.collapsed = false;
    this.panel.classList.remove("collapsed");
    this.renderList();
    const card = this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"]`
    ) as HTMLElement | null;
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  private renderShell(): void {
    this.shadow.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.innerHTML = `
      <button type="button" class="toggle" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
      <div class="header">
        <span>Highlight threads</span>
        <button type="button" class="collapse-btn" title="Collapse" aria-label="Collapse">›</button>
      </div>
      <div class="list"></div>
    `;
    this.shadow.appendChild(this.panel);
    this.listEl = this.panel.querySelector(".list") as HTMLElement;

    this.panel.querySelector(".toggle")?.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.panel.classList.toggle("collapsed", this.collapsed);
    });
    this.panel.querySelector(".collapse-btn")?.addEventListener("click", () => {
      this.collapsed = true;
      this.panel.classList.add("collapsed");
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
    header.innerHTML = `
      <div class="quote">${escapeHtml(thread.quotedText)}</div>
      <div class="meta">${thread.replies.length} ${
      thread.replies.length === 1 ? "reply" : "replies"
    }</div>
    `;
    header.addEventListener("click", () => {
      if (this.expanded.has(thread.id)) {
        this.expanded.delete(thread.id);
      } else {
        this.expanded.add(thread.id);
      }
      this.activeId = thread.id;
      this.callbacks.onFocusThread(thread.id);
      this.renderList();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "card-body";

    const replies = document.createElement("div");
    replies.className = "replies";
    for (const r of thread.replies) {
      const div = document.createElement("div");
      div.className = `reply ${r.role}`;
      div.innerHTML = `<div class="role">${r.role}</div><div>${escapeHtml(
        r.text
      )}</div>`;
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
        const result = await this.callbacks.onSend(thread, question);
        if (!result.ok) {
          status.textContent = result.error || "Request failed";
        } else {
          input.value = "";
        }
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        send.disabled = false;
        this.renderList();
        this.focusThread(thread.id);
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

/** Send an ask-follow-up request to the background service worker. */
export function sendAskFollowUp(
  payload: Omit<AskFollowUpRequest, "type">
): Promise<AskFollowUpResponse> {
  const message: AskFollowUpRequest = { type: "ask-follow-up", ...payload };
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
