import type { AskFollowUpRequest, AskFollowUpResponse, Thread } from "./types";
import { formatReplyHtml } from "./text-clean";
import { fetchAccessTokenFromPage } from "./chatgpt-auth";
import { completeViaChatGptSession } from "../background/chatgpt-session";
import { completeViaClaudeSession } from "../background/claude-session";
import { completeViaGeminiSession } from "../background/gemini-session";
import { setHtml } from "./html";
import {
  SIDEBAR_HOST_ID,
  SIDEBAR_KEY_EVENT,
} from "./input-guard";
import { rafThrottle } from "./dom";
import {
  Dock,
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
} from "./dock";
import { loadSidebarWidth, saveSidebarWidth } from "./storage";
import { StreamSmoother } from "./stream-smoother";
import { createLogger } from "./log";

const log = createLogger("sidebar");

export const HOST_ID = SIDEBAR_HOST_ID;
const COMPOSER_MAX_HEIGHT = 200;
/** Within this many px of the bottom counts as "following" the conversation. */
const STICK_TO_BOTTOM_PX = 48;
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const MONO_STACK = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

export interface SidebarCallbacks {
  onFocusThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onSend: (
    thread: Thread,
    question: string,
    onPartial?: (text: string) => void
  ) => Promise<{ ok: boolean; reply?: string; error?: string }>;
}

export interface SidebarOptions {
  /** Extra page CSS so a site's fixed chrome respects the docked panel. */
  dockFixups?: readonly string[];
}

const SEND_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BACK_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 999px;
  background: #0d0d0d;
  color: #fff;
  font: 600 11px/1 ${FONT_STACK};
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.25);
  writing-mode: vertical-rl;
  text-orientation: mixed;
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: right 0.2s ease;
}
.fab:hover {
  background: #2f2f2f;
}
.fab.dragging {
  transition: none;
}
.panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: ${SIDEBAR_DEFAULT_WIDTH}px;
  max-width: 100vw;
  background: #f9f9f7;
  color: #1a1a1a;
  font-family: ${FONT_STACK};
  font-size: 13.5px;
  line-height: 1.55;
  border-left: 1px solid #deded9;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  z-index: 2147483646;
  transform: translateX(0);
  transition: transform 0.2s ease;
  pointer-events: auto;
}
.panel.docked {
  box-shadow: none;
}
.panel.collapsed {
  transform: translateX(100%);
  box-shadow: none;
  pointer-events: none;
}
.panel.dragging {
  transition: none;
  user-select: none;
}
.resizer {
  position: absolute;
  top: 0;
  left: -4px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  z-index: 3;
  touch-action: none;
}
.resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
  transition: background 0.15s ease;
}
.resizer:hover::after,
.panel.dragging .resizer::after {
  background: #c9a227;
}
.view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.header {
  flex-shrink: 0;
  height: 52px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid #e6e6e1;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.header .title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header.thread {
  padding-left: 6px;
}
.count {
  font-weight: 500;
  font-size: 11px;
  color: #666;
  background: #ececE8;
  border-radius: 999px;
  padding: 1px 8px;
}
.icon-btn {
  border: none;
  background: transparent;
  color: #444;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.icon-btn:hover {
  background: #ececE8;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.empty {
  color: #777;
  padding: 28px 16px;
  text-align: center;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 6px 10px 12px;
  margin-bottom: 6px;
  border: 1px solid #e6e6e1;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  user-select: none;
}
.row:hover {
  border-color: #d2d2cc;
  background: #fdfdfc;
}
.row.active {
  border-color: #c9a227;
  box-shadow: 0 0 0 1px #c9a22733;
}
.row-main {
  flex: 1;
  min-width: 0;
}
.quote {
  font-style: italic;
  color: #333;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  border-left: 3px solid #e2c55a;
  padding-left: 8px;
}
.preview {
  margin-top: 4px;
  font-size: 12px;
  color: #777;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview .live {
  color: #9a7b12;
}
.menu {
  position: relative;
  flex-shrink: 0;
}
.menu-btn {
  border: none;
  background: transparent;
  color: #888;
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 6px;
  letter-spacing: 0.02em;
}
.menu-btn:hover,
.menu.open .menu-btn {
  background: #eee;
  color: #333;
}
.menu-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  min-width: 130px;
  padding: 4px;
  background: #fff;
  border: 1px solid #e4e4e0;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.12);
  z-index: 4;
}
.menu.open .menu-dropdown {
  display: block;
}
.menu-item {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  font: inherit;
  font-weight: 400;
  font-size: 13px;
  color: #a33;
  cursor: pointer;
}
.menu-item:hover {
  background: #f5eaea;
}
.quote-block {
  flex-shrink: 0;
  margin: 12px 14px 0;
  padding: 8px 10px 8px 12px;
  border-left: 3px solid #e2c55a;
  background: #fbf6e3;
  border-radius: 0 8px 8px 0;
  color: #3b3b3b;
  font-style: italic;
  cursor: pointer;
  max-height: 30vh;
  overflow-y: auto;
}
.quote-block .quote-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.quote-block.open .quote-text {
  display: block;
}
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hint {
  margin: auto 0;
  text-align: center;
  color: #888;
}
.msg {
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.msg.user {
  align-self: flex-end;
  max-width: 85%;
  background: #ececE8;
  border-radius: 18px;
  padding: 8px 14px;
  white-space: pre-wrap;
}
.msg.assistant {
  align-self: stretch;
}
.body > :first-child {
  margin-top: 0;
}
.body > :last-child {
  margin-bottom: 0;
}
.body p {
  margin: 0 0 8px;
}
.body p.h {
  font-weight: 650;
  font-size: 14px;
  margin-top: 12px;
}
.body ul,
.body ol {
  margin: 0 0 8px;
  padding-left: 20px;
}
.body li {
  margin: 2px 0;
}
.body strong {
  font-weight: 650;
}
.body em {
  font-style: italic;
}
.body blockquote {
  margin: 0 0 8px;
  padding-left: 10px;
  border-left: 3px solid #d8d8d2;
  color: #555;
}
.body code {
  font-family: ${MONO_STACK};
  font-size: 12px;
  background: #ececE8;
  border-radius: 4px;
  padding: 1px 4px;
}
.code-block {
  margin: 0 0 8px;
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e1e;
}
.code-lang {
  font: 500 11px/1 ${FONT_STACK};
  color: #b8b8b8;
  background: #2b2b2b;
  padding: 6px 10px;
}
.code-block pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
}
.code-block code {
  background: none;
  padding: 0;
  color: #f2f2f2;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}
.msg.streaming .body > p:last-child::after,
.msg.streaming .body > ul:last-child li:last-child::after,
.msg.streaming .body > ol:last-child li:last-child::after {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 4px;
  border-radius: 50%;
  background: #1a1a1a;
  vertical-align: middle;
  animation: pulse 1s ease-in-out infinite;
}
.typing {
  display: inline-flex;
  gap: 4px;
  padding: 6px 0;
}
.typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9a9a95;
  animation: bounce 1.2s ease-in-out infinite;
}
.typing span:nth-child(2) { animation-delay: 0.15s; }
.typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}
.footer {
  flex-shrink: 0;
  padding: 8px 12px 12px;
}
.status {
  font-size: 11.5px;
  color: #a33;
  margin: 0 4px 6px;
}
.status:empty {
  display: none;
}
.status.waiting {
  color: #777;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 6px 6px 6px 12px;
  border: 1px solid #d6d6d0;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.composer:focus-within {
  border-color: #b5b5ae;
}
.composer textarea {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  padding: 6px 0;
  font: inherit;
  line-height: 1.45;
  background: transparent;
  color: #111;
  resize: none;
  overflow-y: hidden;
  max-height: ${COMPOSER_MAX_HEIGHT}px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.send {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: #1a1a1a;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.send.idle {
  opacity: 0.35;
}
.send:disabled {
  cursor: default;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .panel, .fab, .resizer::after { transition: none; }
  .typing span, .spinner, .msg.streaming .body > *::after { animation: none; }
}
`;

/** Plain one-line preview of a reply for the thread list. */
function previewText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " [code] ")
    .replace(/[`*#>_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export class Sidebar {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private panel!: HTMLElement;
  private fab!: HTMLButtonElement;
  private viewEl!: HTMLElement;
  private threads: Thread[] = [];
  /** Thread shown in the full-height chat view; null shows the list. */
  private openId: string | null = null;
  /** Unsent composer text per thread, so re-renders don't wipe it. */
  private drafts = new Map<string, string>();
  /** Thread ids currently waiting on a reply. */
  private sending = new Set<string>();
  /** When each in-flight send started; its stored reply stays hidden until the reveal finishes. */
  private sendStarted = new Map<string, number>();
  /** Last send error per thread, cleared on the next successful attempt. */
  private errors = new Map<string, string>();
  /** Streamed text currently on screen, so it survives a full rebuild. */
  private partials = new Map<string, string>();
  private openQuote = false;
  private activeId: string | null = null;
  /** Start collapsed so we don't cover the site's chrome until needed. */
  private collapsed = true;
  /** Width the user chose; the applied width is this clamped to the viewport. */
  private preferredWidth = SIDEBAR_DEFAULT_WIDTH;
  private width = SIDEBAR_DEFAULT_WIDTH;
  private dock: Dock;
  private callbacks: SidebarCallbacks;

  constructor(callbacks: SidebarCallbacks, options: SidebarOptions = {}) {
    this.callbacks = callbacks;
    this.dock = new Dock(options.dockFixups ?? []);

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
    }
    // Lives on <html>, not <body>: a docked <body> contains fixed descendants.
    document.documentElement.appendChild(host);
    this.host = host;
    this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "beforeinput",
      "input",
      "paste",
      "cut",
      "copy",
      "compositionstart",
      "compositionend",
    ] as const) {
      this.shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    this.renderShell();
    this.applyLayout();

    void loadSidebarWidth().then((saved) => {
      if (saved == null) return;
      this.preferredWidth = saved;
      this.applyLayout();
    });
    window.addEventListener("resize", () => this.applyLayout());
  }

  /** Re-append the host if the page's own rendering removed it. */
  ensureMounted(): void {
    this.dock.reassert();
    if (this.host.isConnected) return;
    log.debug("Sidebar host was removed by the page; re-attaching");
    document.documentElement.appendChild(this.host);
  }

  isMounted(): boolean {
    return this.host.isConnected;
  }

  describe(): Record<string, unknown> {
    return {
      collapsed: this.collapsed,
      view: this.openId ? "thread" : "list",
      preferredWidth: this.preferredWidth,
      hostParent: this.host.parentElement?.tagName.toLowerCase() ?? null,
      panelRect: this.panel.getBoundingClientRect().toJSON(),
      ...this.dock.describe(),
    };
  }

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    if (this.openId && !threads.some((t) => t.id === this.openId)) {
      this.openId = null;
    }
    this.render();
  }

  focusThread(threadId: string): void {
    if (this.openId !== threadId) this.openQuote = false;
    this.openId = threadId;
    this.activeId = threadId;
    this.setCollapsed(false);
    this.render();
    this.composerFor(threadId)?.focus({ preventScroll: true });
  }

  private openThread(threadId: string): void {
    this.openQuote = false;
    this.openId = threadId;
    this.activeId = threadId;
    this.callbacks.onFocusThread(threadId);
    this.render();
    this.composerFor(threadId)?.focus({ preventScroll: true });
  }

  private showList(): void {
    this.openId = null;
    this.render();
  }

  private composerFor(threadId: string): HTMLTextAreaElement | null {
    return this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"] textarea`
    ) as HTMLTextAreaElement | null;
  }

  private messagesFor(threadId: string): HTMLElement | null {
    return this.shadow.querySelector(
      `.view[data-thread-id="${CSS.escape(threadId)}"] .messages`
    ) as HTMLElement | null;
  }

  /** Update the in-flight assistant message without rebuilding the view. */
  patchAssistantReply(threadId: string, text: string): void {
    this.partials.set(threadId, text);
    const messages = this.messagesFor(threadId);
    if (!messages) return;
    const follow = isNearBottom(messages);

    let live = messages.querySelector(".msg.assistant.streaming") as HTMLElement | null;
    if (!live) {
      live = document.createElement("div");
      live.className = "msg assistant streaming";
      setHtml(live, `<div class="body"></div>`);
      messages.appendChild(live);
    }
    const body = live.querySelector(".body");
    if (body) {
      const html = text ? formatReplyHtml(text) : "";
      setHtml(
        body,
        html || `<div class="typing" aria-label="Assistant is typing"><span></span><span></span><span></span></div>`
      );
    }
    if (follow) messages.scrollTop = messages.scrollHeight;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel.classList.toggle("collapsed", collapsed);
    this.fab.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? "Open highlight threads" : "Close highlight threads";
    this.fab.title = label;
    this.fab.setAttribute("aria-label", label);
    this.applyLayout();
  }

  /** Sync panel width, toggle position, and page docking with current state. */
  private applyLayout(): void {
    this.width = clampSidebarWidth(this.preferredWidth);
    this.panel.style.width = `${this.width}px`;
    const docked = this.dock.apply(!this.collapsed, this.width);
    this.panel.classList.toggle("docked", docked);
    this.fab.style.right = this.collapsed
      ? "10px"
      : `${Math.min(this.width, window.innerWidth) + 10}px`;
  }

  private closeAllMenus(): void {
    this.shadow
      .querySelectorAll(".menu.open")
      .forEach((el) => el.classList.remove("open"));
  }

  private renderShell(): void {
    this.shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    this.fab = document.createElement("button");
    this.fab.type = "button";
    this.fab.className = "fab";
    this.fab.title = "Open highlight threads";
    this.fab.setAttribute("aria-label", "Open highlight threads");
    this.fab.setAttribute("aria-expanded", "false");
    this.fab.textContent = "Threads";
    this.fab.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.shadow.appendChild(this.fab);

    this.panel = document.createElement("div");
    this.panel.className = "panel collapsed";
    this.panel.appendChild(this.buildResizer());
    this.viewEl = document.createElement("div");
    this.viewEl.className = "view";
    this.panel.appendChild(this.viewEl);
    this.shadow.appendChild(this.panel);

    this.shadow.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (!target?.closest(".menu")) this.closeAllMenus();
    });
  }

  private buildResizer(): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "resizer";
    handle.title = "Drag to resize (double-click to reset)";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize highlight threads panel");

    const resizeTo = rafThrottle((clientX: number) => {
      this.preferredWidth = clampSidebarWidth(window.innerWidth - clientX);
      this.applyLayout();
    });
    let dragging = false;
    const stopDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      resizeTo.cancel();
      this.preferredWidth = clampSidebarWidth(window.innerWidth - e.clientX);
      this.applyLayout();
      this.panel.classList.remove("dragging");
      this.fab.classList.remove("dragging");
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      saveSidebarWidth(this.preferredWidth);
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone (e.g. released before the handler ran).
      }
      this.panel.classList.add("dragging");
      this.fab.classList.add("dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.stopPropagation();
      resizeTo(e.clientX);
    });
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
    handle.addEventListener("dblclick", () => {
      this.preferredWidth = SIDEBAR_DEFAULT_WIDTH;
      this.applyLayout();
      saveSidebarWidth(this.preferredWidth);
    });
    return handle;
  }

  private render(): void {
    const focused = this.shadow.activeElement;
    const focusState =
      focused instanceof HTMLTextAreaElement
        ? {
            id: focused.closest("[data-thread-id]")?.getAttribute("data-thread-id") ?? undefined,
            start: focused.selectionStart,
            end: focused.selectionEnd,
          }
        : null;

    const thread = this.openId
      ? this.threads.find((t) => t.id === this.openId)
      : undefined;

    const prevMessages = this.viewEl.querySelector(".messages") as HTMLElement | null;
    const prevThreadId = this.viewEl.getAttribute("data-thread-id");
    const scrollState =
      prevMessages && prevThreadId === (thread?.id ?? null)
        ? { follow: isNearBottom(prevMessages), top: prevMessages.scrollTop }
        : null;
    const prevList = this.viewEl.querySelector(".list") as HTMLElement | null;
    const listScroll = !thread && prevList ? prevList.scrollTop : 0;

    const view = thread ? this.buildThreadView(thread) : this.buildListView();
    this.viewEl.replaceWith(view);
    this.viewEl = view;

    if (thread) {
      const partial = this.partials.get(thread.id);
      if (this.sending.has(thread.id) || partial !== undefined) {
        this.patchAssistantReply(thread.id, partial ?? "");
      }
      const messages = view.querySelector(".messages") as HTMLElement | null;
      if (messages) {
        messages.scrollTop =
          !scrollState || scrollState.follow ? messages.scrollHeight : scrollState.top;
      }
    } else {
      const list = view.querySelector(".list") as HTMLElement | null;
      if (list) list.scrollTop = listScroll;
    }

    if (focusState?.id) {
      const input = this.composerFor(focusState.id);
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(focusState.start, focusState.end);
    }
  }

  private buildListView(): HTMLElement {
    const view = document.createElement("div");
    view.className = "view";

    const header = document.createElement("div");
    header.className = "header";
    setHtml(
      header,
      `<span class="title">Highlight threads</span>${
        this.threads.length ? `<span class="count">${this.threads.length}</span>` : ""
      }`
    );
    view.appendChild(header);

    const list = document.createElement("div");
    list.className = "list";
    view.appendChild(list);

    if (this.threads.length === 0) {
      setHtml(
        list,
        `<div class="empty">Highlight text in a reply and click “Ask about this” to start a thread.</div>`
      );
      return view;
    }

    for (const thread of this.threads) list.appendChild(this.buildRow(thread));
    return view;
  }

  private buildRow(thread: Thread): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.threadId = thread.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (this.activeId === thread.id) row.classList.add("active");

    const main = document.createElement("div");
    main.className = "row-main";
    const last = thread.replies[thread.replies.length - 1];
    let preview: string;
    if (this.sending.has(thread.id)) {
      preview = `<span class="live">Replying…</span>`;
    } else if (last) {
      const who = last.role === "user" ? "You: " : "";
      const n = thread.replies.length;
      preview = `${escapeHtml(who + previewText(last.text))}`;
      if (n > 1) preview = `${n} messages · ${preview}`;
    } else {
      preview = "No messages yet";
    }
    setHtml(
      main,
      `<div class="quote">${escapeHtml(thread.quotedText)}</div><div class="preview">${preview}</div>`
    );
    row.appendChild(main);
    row.appendChild(this.buildMenu(thread));

    row.addEventListener("click", (e) => {
      if ((e.target as Element | null)?.closest(".menu")) return;
      this.openThread(thread.id);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.openThread(thread.id);
      }
    });
    return row;
  }

  private buildMenu(thread: Thread): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "menu";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "menu-btn";
    menuBtn.title = "Thread options";
    menuBtn.setAttribute("aria-label", "Thread options");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      this.closeAllMenus();
      if (!wasOpen) {
        menu.classList.add("open");
        menuBtn.setAttribute("aria-expanded", "true");
      }
    });

    const dropdown = document.createElement("div");
    dropdown.className = "menu-dropdown";
    dropdown.setAttribute("role", "menu");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "menu-item";
    deleteBtn.setAttribute("role", "menuitem");
    deleteBtn.textContent = "Delete thread";
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeAllMenus();
      this.drafts.delete(thread.id);
      this.errors.delete(thread.id);
      this.partials.delete(thread.id);
      this.sending.delete(thread.id);
      this.sendStarted.delete(thread.id);
      if (this.activeId === thread.id) this.activeId = null;
      if (this.openId === thread.id) this.openId = null;
      void this.callbacks.onDeleteThread(thread.id);
    });
    dropdown.appendChild(deleteBtn);
    menu.appendChild(menuBtn);
    menu.appendChild(dropdown);
    return menu;
  }

  private buildThreadView(thread: Thread): HTMLElement {
    const view = document.createElement("div");
    view.className = "view";
    view.dataset.threadId = thread.id;

    const header = document.createElement("div");
    header.className = "header thread";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "icon-btn";
    back.title = "Back to threads";
    back.setAttribute("aria-label", "Back to threads");
    setHtml(back, BACK_ICON);
    back.addEventListener("click", () => this.showList());
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Thread";
    header.appendChild(back);
    header.appendChild(title);
    header.appendChild(this.buildMenu(thread));
    view.appendChild(header);

    const quote = document.createElement("div");
    quote.className = "quote-block";
    if (this.openQuote) quote.classList.add("open");
    quote.title = "Expand and show in chat";
    setHtml(quote, `<div class="quote-text">${escapeHtml(thread.quotedText)}</div>`);
    quote.addEventListener("click", () => {
      this.openQuote = !this.openQuote;
      quote.classList.toggle("open", this.openQuote);
      this.callbacks.onFocusThread(thread.id);
    });
    view.appendChild(quote);

    const messages = document.createElement("div");
    messages.className = "messages";
    messages.setAttribute("aria-live", "polite");
    const started = this.sendStarted.get(thread.id);
    const visible = thread.replies.filter(
      (r) => !(started !== undefined && r.role === "assistant" && r.ts >= started)
    );
    if (visible.length === 0 && !this.sending.has(thread.id)) {
      setHtml(messages, `<div class="hint">Ask anything about this highlight.</div>`);
    }
    for (const r of visible) {
      const div = document.createElement("div");
      div.className = `msg ${r.role}`;
      if (r.role === "assistant") {
        setHtml(div, `<div class="body">${formatReplyHtml(r.text)}</div>`);
      } else {
        div.textContent = r.text;
      }
      messages.appendChild(div);
    }
    view.appendChild(messages);

    view.appendChild(this.buildFooter(thread));
    return view;
  }

  private buildFooter(thread: Thread): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "footer";
    const isSending = this.sending.has(thread.id);

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const error = this.errors.get(thread.id);
    if (isSending) {
      status.classList.add("waiting");
      status.textContent = "Waiting for a reply…";
    } else {
      status.textContent = error ?? "";
    }

    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask about this snippet…";
    input.setAttribute("aria-label", "Ask about this snippet");
    input.readOnly = isSending;
    input.value = this.drafts.get(thread.id) ?? "";

    const send = document.createElement("button");
    send.type = "button";
    send.className = "send";
    send.disabled = isSending;
    send.title = isSending ? "Waiting for a reply" : "Send";
    send.setAttribute("aria-label", send.title);
    setHtml(send, isSending ? `<span class="spinner"></span>` : SEND_ICON);
    const syncIdle = () => {
      send.classList.toggle("idle", !isSending && !input.value.trim());
    };
    syncIdle();

    const autoGrow = () => {
      input.style.overflowY = "hidden";
      input.style.height = "auto";
      const borders = input.offsetHeight - input.clientHeight;
      const wanted = input.scrollHeight + borders;
      input.style.height = `${Math.min(wanted, COMPOSER_MAX_HEIGHT)}px`;
      if (wanted > COMPOSER_MAX_HEIGHT) input.style.overflowY = "auto";
    };
    input.addEventListener("input", () => {
      this.drafts.set(thread.id, input.value);
      autoGrow();
      syncIdle();
    });
    if (input.value) requestAnimationFrame(autoGrow);

    const doSend = async () => {
      const question = input.value.trim();
      if (!question || this.sending.has(thread.id)) return;
      this.sending.add(thread.id);
      this.sendStarted.set(thread.id, Date.now());
      this.errors.delete(thread.id);
      // Clear the composer while waiting so the draft isn't stuck on screen.
      this.drafts.delete(thread.id);
      this.partials.set(thread.id, "");
      this.render();
      const messages = this.messagesFor(thread.id);
      if (messages) messages.scrollTop = messages.scrollHeight;

      const smoother = new StreamSmoother((visible) =>
        this.patchAssistantReply(thread.id, visible)
      );
      try {
        const result = await this.callbacks.onSend(thread, question, (text) =>
          smoother.push(text)
        );
        if (result.ok) {
          if (result.reply) smoother.push(result.reply);
          await smoother.finish();
        } else {
          this.errors.set(thread.id, result.error || "Request failed");
          // Restore the draft so a failed send isn't lost.
          this.drafts.set(thread.id, question);
        }
      } catch (err) {
        this.errors.set(
          thread.id,
          err instanceof Error ? err.message : String(err)
        );
        this.drafts.set(thread.id, question);
      } finally {
        smoother.cancel();
        this.sending.delete(thread.id);
        this.sendStarted.delete(thread.id);
        this.partials.delete(thread.id);
        this.render();
      }
    };

    send.addEventListener("click", () => void doSend());
    const onKeyDown = (e: KeyboardEvent) => {
      // Shift+Enter inserts a newline; Enter during IME composition confirms text.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void doSend();
      }
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener(SIDEBAR_KEY_EVENT, (event) => {
      onKeyDown((event as CustomEvent<KeyboardEvent>).detail);
    });

    composer.appendChild(input);
    composer.appendChild(send);
    footer.appendChild(status);
    footer.appendChild(composer);
    return footer;
  }
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type SessionCompleter = (
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
) => Promise<AskFollowUpResponse>;

/** Sites whose follow-ups run in-page through the user's logged-in session. */
const SESSION_COMPLETERS: Record<string, SessionCompleter> = {
  chatgpt: async (req, onPartial) =>
    completeViaChatGptSession(await fetchAccessTokenFromPage(), req, onPartial),
  claude: completeViaClaudeSession,
  gemini: completeViaGeminiSession,
};

/**
 * Ask a follow-up about a highlight.
 *
 * Session-backed sites run entirely in the content script (no CS↔SW↔CS nested
 * messaging): that pattern closes the message channel before long streams
 * finish, and page cookies are only same-origin from here.
 */
export async function sendAskFollowUp(
  payload: Omit<AskFollowUpRequest, "type">,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  const message: AskFollowUpRequest = { type: "ask-follow-up", ...payload };

  const complete = SESSION_COMPLETERS[payload.siteId];
  if (complete) {
    try {
      log.debug(`Completing ${payload.siteId} follow-up in page`);
      return await complete(message, onPartial);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Follow-up failed:", error);
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
