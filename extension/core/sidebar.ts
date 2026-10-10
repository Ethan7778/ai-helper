import type {
  AskFollowUpRequest,
  AskFollowUpResponse,
  HighlightStyle,
  Thread,
  UiAppearance,
} from "./types";
import { DEFAULT_UI_APPEARANCE } from "./types";
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
import { hexToRgba } from "./anchor";

const log = createLogger("sidebar");

export const HOST_ID = SIDEBAR_HOST_ID;
const COMPOSER_MAX_HEIGHT = 200;
/** Within this many px of the bottom counts as "following" the conversation. */
const STICK_TO_BOTTOM_PX = 48;
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const MONO_STACK = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const HIGHLIGHT_COLOR_PRESETS = [
  "#c9a227",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#ec4899",
  "#f97316",
] as const;

const GEAR_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2.5M12 20.5V23M4.22 4.22l1.77 1.77M18.01 18.01l1.77 1.77M1 12h2.5M20.5 12H23M4.22 19.78l1.77-1.77M18.01 5.99l1.77-1.77"/></svg>`;

export interface SidebarCallbacks {
  onFocusThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onSend: (
    thread: Thread,
    question: string,
    onPartial?: (text: string) => void
  ) => Promise<{ ok: boolean; reply?: string; error?: string }>;
  onAppearanceChange: (appearance: UiAppearance) => void | Promise<void>;
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
  --bg: #f7f7f5;
  --bg-elevated: #ffffff;
  --bg-muted: #ecece8;
  --bg-hover: #f3f3f0;
  --text: #1a1a1a;
  --text-secondary: #333333;
  --text-muted: #777777;
  --border: #e6e6e1;
  --border-strong: #d6d6d0;
  --accent: #c9a227;
  --accent-soft: #e2c55a;
  --accent-ring: rgba(201, 162, 39, 0.2);
  --quote-bg: #fbf6e3;
  --danger: #a33;
  --danger-bg: #f5eaea;
  --fab-bg: #0d0d0d;
  --fab-bg-hover: #2f2f2f;
  --fab-fg: #ffffff;
  --fab-border: rgba(255,255,255,0.18);
  --send-bg: #1a1a1a;
  --send-fg: #ffffff;
  --shadow: rgba(0,0,0,0.08);
  --code-inline-bg: #ecece8;
  --stream-dot: #1a1a1a;
  --live: #9a7b12;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #1c1c1e;
    --bg-elevated: #2a2a2c;
    --bg-muted: #3a3a3c;
    --bg-hover: #323234;
    --text: #f2f2f2;
    --text-secondary: #d8d8d8;
    --text-muted: #9a9a9a;
    --border: #3a3a3c;
    --border-strong: #4a4a4c;
    --quote-bg: rgba(201, 162, 39, 0.14);
    --danger: #f07178;
    --danger-bg: rgba(240, 113, 120, 0.14);
    --fab-bg: #2a2a2c;
    --fab-bg-hover: #3a3a3c;
    --fab-fg: #f2f2f2;
    --fab-border: rgba(255,255,255,0.12);
    --send-bg: #f2f2f2;
    --send-fg: #1a1a1a;
    --shadow: rgba(0,0,0,0.45);
    --code-inline-bg: #3a3a3c;
    --stream-dot: #f2f2f2;
    --live: #e2c55a;
  }
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
  border: 1px solid var(--fab-border);
  border-radius: 999px;
  background: var(--fab-bg);
  color: var(--fab-fg);
  font: 600 11px/1 ${FONT_STACK};
  cursor: pointer;
  box-shadow: 0 4px 14px var(--shadow);
  writing-mode: vertical-rl;
  text-orientation: mixed;
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: right 0.2s ease;
}
.fab:hover {
  background: var(--fab-bg-hover);
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
  background: var(--bg);
  color: var(--text);
  font-family: ${FONT_STACK};
  font-size: 13.5px;
  line-height: 1.55;
  border-left: 1px solid var(--border);
  box-shadow: -4px 0 24px var(--shadow);
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
  background: var(--accent);
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
  border-bottom: 1px solid var(--border);
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
  color: var(--text-muted);
  background: var(--bg-muted);
  border-radius: 999px;
  padding: 1px 8px;
}
.icon-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 0;
}
.icon-btn svg {
  display: block;
  flex-shrink: 0;
}
.icon-btn:hover {
  background: var(--bg-muted);
}
.list,
.settings {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.empty {
  color: var(--text-muted);
  padding: 28px 16px;
  text-align: center;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 6px 10px 12px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  cursor: pointer;
  user-select: none;
}
.row:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.row.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-ring);
}
.row-main {
  flex: 1;
  min-width: 0;
}
.quote {
  font-style: italic;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  border-left: 3px solid var(--accent-soft);
  padding-left: 8px;
}
.preview {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview .live {
  color: var(--live);
}
.menu {
  position: relative;
  flex-shrink: 0;
}
.menu-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 6px;
  letter-spacing: 0.02em;
}
.menu-btn:hover,
.menu.open .menu-btn {
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.menu-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  min-width: 130px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px var(--shadow);
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
  color: var(--danger);
  cursor: pointer;
}
.menu-item:hover {
  background: var(--danger-bg);
}
.quote-block {
  flex-shrink: 0;
  margin: 12px 14px 0;
  padding: 8px 10px 8px 12px;
  border-left: 3px solid var(--accent-soft);
  background: var(--quote-bg);
  border-radius: 0 8px 8px 0;
  color: var(--text-secondary);
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
  color: var(--text-muted);
}
.msg {
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.msg.user {
  align-self: flex-end;
  max-width: 85%;
  background: var(--bg-muted);
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
  border-left: 3px solid var(--border-strong);
  color: var(--text-muted);
}
.body code {
  font-family: ${MONO_STACK};
  font-size: 12px;
  background: var(--code-inline-bg);
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
  background: var(--stream-dot);
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
  background: var(--text-muted);
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
  color: var(--danger);
  margin: 0 4px 6px;
}
.status:empty {
  display: none;
}
.status.waiting {
  color: var(--text-muted);
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--bg-elevated);
  box-shadow: 0 1px 4px var(--shadow);
}
.composer:focus-within {
  border-color: var(--accent);
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
  color: var(--text);
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
  background: var(--send-bg);
  color: var(--send-fg);
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
  border: 2px solid color-mix(in srgb, var(--send-fg) 35%, transparent);
  border-top-color: var(--send-fg);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.settings-section {
  margin-bottom: 18px;
}
.settings-label {
  display: block;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 8px;
  color: var(--text-secondary);
}
.settings-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 10px;
}
.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.color-swatches {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}
.swatch.active {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg);
}
.color-picker {
  width: 36px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  cursor: pointer;
}
.style-toggle {
  display: flex;
  gap: 6px;
}
.style-btn {
  flex: 1;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text);
  border-radius: 10px;
  padding: 10px 8px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.style-btn.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-ring);
  background: var(--quote-bg);
}
.preview-mark {
  display: inline;
  border-radius: 2px;
  cursor: default;
}
.preview-mark.classic {
  background: var(--preview-fill, rgba(201, 162, 39, 0.45));
}
.preview-mark.underline {
  background: transparent;
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
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
  /** Settings screen open from the thread list header. */
  private settingsOpen = false;
  private appearance: UiAppearance = { ...DEFAULT_UI_APPEARANCE };
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
    this.applyAppearanceVars();
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
      view: this.settingsOpen ? "settings" : this.openId ? "thread" : "list",
      preferredWidth: this.preferredWidth,
      appearance: this.appearance,
      hostParent: this.host.parentElement?.tagName.toLowerCase() ?? null,
      panelRect: this.panel.getBoundingClientRect().toJSON(),
      ...this.dock.describe(),
    };
  }

  setAppearance(appearance: UiAppearance): void {
    this.appearance = { ...appearance };
    this.applyAppearanceVars();
    if (this.settingsOpen) this.render();
  }

  private applyAppearanceVars(): void {
    const color = this.appearance.highlightColor;
    this.host.style.setProperty("--accent", color);
    this.host.style.setProperty("--accent-soft", hexToRgba(color, 0.75));
    this.host.style.setProperty("--accent-ring", hexToRgba(color, 0.22));
    this.host.style.setProperty("--preview-fill", hexToRgba(color, 0.45));
    this.host.style.setProperty("--live", color);
    // Quote tint tracks the chosen highlight color in both themes.
    this.host.style.setProperty("--quote-bg", hexToRgba(color, 0.14));
  }

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    if (this.openId && !threads.some((t) => t.id === this.openId)) {
      this.openId = null;
    }
    this.render();
  }

  focusThread(threadId: string): void {
    this.settingsOpen = false;
    if (this.openId && this.openId !== threadId) {
      this.discardOpenDraftIfEmpty();
    }
    if (this.openId !== threadId) this.openQuote = false;
    this.openId = threadId;
    this.activeId = threadId;
    this.setCollapsed(false);
    this.render();
    this.composerFor(threadId)?.focus({ preventScroll: true });
  }

  private openThread(threadId: string): void {
    this.settingsOpen = false;
    if (this.openId && this.openId !== threadId) {
      this.discardOpenDraftIfEmpty();
    }
    this.openQuote = false;
    this.openId = threadId;
    this.activeId = threadId;
    this.callbacks.onFocusThread(threadId);
    this.render();
    this.composerFor(threadId)?.focus({ preventScroll: true });
  }

  private showList(): void {
    this.discardOpenDraftIfEmpty();
    this.settingsOpen = false;
    this.openId = null;
    this.render();
  }

  private openSettings(): void {
    this.discardOpenDraftIfEmpty();
    this.openId = null;
    this.settingsOpen = true;
    this.setCollapsed(false);
    this.render();
  }

  private updateAppearance(partial: Partial<UiAppearance>): void {
    this.appearance = { ...this.appearance, ...partial };
    this.applyAppearanceVars();
    this.render();
    void this.callbacks.onAppearanceChange(this.appearance);
  }

  /**
   * Unsent highlight drafts are never persisted. Drop them as soon as the
   * user leaves the composer (back, close panel, open another thread).
   */
  private discardOpenDraftIfEmpty(): void {
    const id = this.openId;
    if (!id || this.sending.has(id)) return;
    const thread = this.threads.find((t) => t.id === id);
    if (!thread || thread.replies.length > 0) return;

    this.drafts.delete(id);
    this.errors.delete(id);
    this.partials.delete(id);
    this.sendStarted.delete(id);
    if (this.activeId === id) this.activeId = null;
    this.openId = null;
    void this.callbacks.onDeleteThread(id);
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
    if (collapsed) this.discardOpenDraftIfEmpty();
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

    const thread =
      !this.settingsOpen && this.openId
        ? this.threads.find((t) => t.id === this.openId)
        : undefined;

    const prevMessages = this.viewEl.querySelector(".messages") as HTMLElement | null;
    const prevThreadId = this.viewEl.getAttribute("data-thread-id");
    const scrollState =
      prevMessages && prevThreadId === (thread?.id ?? null)
        ? { follow: isNearBottom(prevMessages), top: prevMessages.scrollTop }
        : null;
    const prevList = this.viewEl.querySelector(".list") as HTMLElement | null;
    const listScroll = !thread && !this.settingsOpen && prevList ? prevList.scrollTop : 0;

    const view = this.settingsOpen
      ? this.buildSettingsView()
      : thread
        ? this.buildThreadView(thread)
        : this.buildListView();
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
    } else if (!this.settingsOpen) {
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
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Highlight threads";
    header.appendChild(title);
    if (this.threads.length) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(this.threads.length);
      header.appendChild(count);
    }
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "icon-btn";
    settingsBtn.title = "Appearance settings";
    settingsBtn.setAttribute("aria-label", "Appearance settings");
    setHtml(settingsBtn, GEAR_ICON);
    settingsBtn.addEventListener("click", () => this.openSettings());
    header.appendChild(settingsBtn);
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

  private buildSettingsView(): HTMLElement {
    const view = document.createElement("div");
    view.className = "view";

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
    title.textContent = "Appearance";
    header.appendChild(back);
    header.appendChild(title);
    view.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings";

    const colorSection = document.createElement("div");
    colorSection.className = "settings-section";
    setHtml(
      colorSection,
      `<div class="settings-label">Highlight color</div>
       <p class="settings-hint">Used for marks in the chat and accents in this panel.</p>`
    );
    const colorRow = document.createElement("div");
    colorRow.className = "color-row";
    const swatches = document.createElement("div");
    swatches.className = "color-swatches";
    for (const preset of HIGHLIGHT_COLOR_PRESETS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      if (preset === this.appearance.highlightColor) swatch.classList.add("active");
      swatch.style.background = preset;
      swatch.title = preset;
      swatch.setAttribute("aria-label", `Highlight color ${preset}`);
      swatch.addEventListener("click", () =>
        this.updateAppearance({ highlightColor: preset })
      );
      swatches.appendChild(swatch);
    }
    colorRow.appendChild(swatches);
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "color-picker";
    picker.value = this.appearance.highlightColor;
    picker.title = "Custom highlight color";
    picker.setAttribute("aria-label", "Custom highlight color");
    picker.addEventListener("input", () => {
      const value = picker.value.toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(value)) {
        this.updateAppearance({ highlightColor: value });
      }
    });
    colorRow.appendChild(picker);
    colorSection.appendChild(colorRow);
    body.appendChild(colorSection);

    const styleSection = document.createElement("div");
    styleSection.className = "settings-section";
    setHtml(
      styleSection,
      `<div class="settings-label">Highlight style</div>
       <p class="settings-hint">Classic fills the text; underline only draws a line under it.</p>`
    );
    const toggle = document.createElement("div");
    toggle.className = "style-toggle";
    toggle.appendChild(
      this.styleOptionButton("classic", "Classic", this.appearance.highlightStyle)
    );
    toggle.appendChild(
      this.styleOptionButton("underline", "Underline", this.appearance.highlightStyle)
    );
    styleSection.appendChild(toggle);
    body.appendChild(styleSection);

    const previewSection = document.createElement("div");
    previewSection.className = "settings-section";
    setHtml(previewSection, `<div class="settings-label">Preview</div>`);
    const preview = document.createElement("p");
    preview.className = "settings-hint";
    const mark = document.createElement("span");
    mark.className = `preview-mark ${this.appearance.highlightStyle}`;
    mark.textContent = "highlighted text";
    preview.append("Looks like ", mark, " in the chat.");
    previewSection.appendChild(preview);
    body.appendChild(previewSection);

    view.appendChild(body);
    return view;
  }

  private styleOptionButton(
    style: HighlightStyle,
    label: string,
    current: HighlightStyle
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "style-btn";
    if (style === current) btn.classList.add("active");
    btn.textContent = label;
    btn.addEventListener("click", () =>
      this.updateAppearance({ highlightStyle: style })
    );
    return btn;
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
