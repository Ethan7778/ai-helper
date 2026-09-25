import type { Thread } from "./types";

/**
 * Convert a DOM position (node + offset) into a plain-text character offset
 * relative to `root`, by walking text nodes with a TreeWalker.
 */
export function getTextOffset(
  root: Node,
  node: Node,
  offset: number
): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current: Node | null = walker.nextNode();

  while (current) {
    if (current === node) {
      return total + offset;
    }
    total += (current.textContent ?? "").length;
    current = walker.nextNode();
  }

  if (root.contains(node)) {
    try {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return total;
    }
  }

  return -1;
}

/** Extract the concatenated plain text of all text nodes under `root`. */
export function getPlainText(root: Node): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  let current: Node | null = walker.nextNode();
  while (current) {
    text += current.textContent ?? "";
    current = walker.nextNode();
  }
  return text;
}

/**
 * Given raw message text and thread anchors, return HTML with
 * <mark data-thread-id="..."> spliced in at the right offsets.
 *
 * Used by the static harness; live ChatGPT uses wrapHighlightsInPlace instead
 * so host markdown/DOM structure is preserved.
 *
 * Overlaps are rejected (later starts that collide with a kept interval
 * are skipped). TODO: replace with a real interval-based renderer that
 * can split/merge overlapping highlights cleanly.
 */
export function renderWithHighlights(
  rawText: string,
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[]
): string {
  const kept = filterNonOverlapping(threads, rawText.length);
  if (kept.length === 0) {
    return escapeHtml(rawText);
  }

  let html = "";
  let cursor = 0;

  for (const t of kept) {
    if (cursor < t.anchorStart) {
      html += escapeHtml(rawText.slice(cursor, t.anchorStart));
    }
    html += `<mark data-thread-id="${escapeAttr(t.id)}">${escapeHtml(
      rawText.slice(t.anchorStart, t.anchorEnd)
    )}</mark>`;
    cursor = t.anchorEnd;
  }

  if (cursor < rawText.length) {
    html += escapeHtml(rawText.slice(cursor));
  }

  return html;
}

function filterNonOverlapping(
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[],
  textLen: number
): Pick<Thread, "id" | "anchorStart" | "anchorEnd">[] {
  const sorted = [...threads].sort((a, b) => a.anchorStart - b.anchorStart);
  const kept: typeof sorted = [];
  let lastEnd = -1;

  for (const t of sorted) {
    if (
      t.anchorStart < 0 ||
      t.anchorEnd > textLen ||
      t.anchorStart >= t.anchorEnd
    ) {
      continue;
    }
    if (t.anchorStart < lastEnd) {
      console.warn(
        "[ai-helper] Skipping overlapping highlight",
        t.id,
        `(${t.anchorStart}-${t.anchorEnd} overlaps prior end ${lastEnd})`
      );
      continue;
    }
    kept.push(t);
    lastEnd = t.anchorEnd;
  }
  return kept;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export interface SelectionAnchor {
  messageRoot: HTMLElement;
  start: number;
  end: number;
  quotedText: string;
  rect: DOMRect;
}

/**
 * If the current window selection lies entirely inside one of the given
 * message roots, return its character offsets and bounding rect.
 * Also recovers when ChatGPT wraps the selection in a slightly different node
 * than our registered markdown root (walk up to an assistant turn).
 */
export function getSelectionAnchor(
  messageRoots: HTMLElement[]
): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const { startContainer, endContainer } = range;
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;

  let messageRoot =
    messageRoots.find(
      (root) =>
        root.contains(startContainer) && root.contains(endContainer)
    ) ?? null;

  if (!messageRoot) {
    messageRoot = findAssistantRootFromNode(startContainer);
    if (
      !messageRoot ||
      !messageRoot.contains(startContainer) ||
      !messageRoot.contains(endContainer)
    ) {
      return null;
    }
  }

  const start = getTextOffset(messageRoot, startContainer, startOffset);
  const end = getTextOffset(messageRoot, endContainer, endOffset);
  if (start < 0 || end < 0 || start >= end) {
    return null;
  }

  const quotedText = range.toString();
  if (!quotedText.trim()) {
    return null;
  }

  let rect = range.getBoundingClientRect();
  if ((!rect.width && !rect.height) || Number.isNaN(rect.top)) {
    const rects = range.getClientRects();
    if (rects.length > 0) {
      rect = rects[0]!;
    }
  }

  return {
    messageRoot,
    start,
    end,
    quotedText,
    rect,
  };
}

/** Walk up from a selection node to a plausible assistant message root. */
function findAssistantRootFromNode(node: Node): HTMLElement | null {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  if (!el) return null;

  const turn = el.closest<HTMLElement>(
    [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-testid*="assistant"]',
    ].join(", ")
  );
  if (!turn) return null;

  // Prefer the markdown body when present so offsets match highlight wrapping.
  return (
    turn.querySelector<HTMLElement>(
      ".markdown, .prose, [class*='markdown'], [class*='prose'], .whitespace-pre-wrap"
    ) ?? turn
  );
}

/** Recompute a viewport rect for a previously captured selection anchor. */
export function getAnchorRect(anchor: SelectionAnchor): DOMRect | null {
  if (!anchor.messageRoot.isConnected) return null;
  const range = rangeFromOffsets(anchor.messageRoot, anchor.start, anchor.end);
  return range?.getBoundingClientRect() ?? null;
}

function rangeFromOffsets(
  root: HTMLElement,
  start: number,
  end: number
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;

  let current: Node | null = walker.nextNode();
  while (current) {
    const node = current as Text;
    const len = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;

    if (!startNode && start >= nodeStart && start <= nodeEnd) {
      startNode = node;
      startOff = start - nodeStart;
    }
    if (!endNode && end >= nodeStart && end <= nodeEnd) {
      endNode = node;
      endOff = end - nodeStart;
      break;
    }
    offset = nodeEnd;
    current = walker.nextNode();
  }

  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  } catch {
    return null;
  }
}

const ASK_BUTTON_ID = "ai-helper-ask-btn";
const ASK_BUTTON_INJECTED = "ai-helper-ask-injected";

export type AskButtonHandler = (anchor: SelectionAnchor) => void;

function styleAskButton(button: HTMLButtonElement, inline: boolean): void {
  Object.assign(button.style, {
    position: inline ? "static" : "fixed",
    zIndex: inline ? "auto" : "2147483646",
    margin: inline ? "0 0 0 6px" : "0",
    padding: "6px 10px",
    fontSize: "12px",
    fontFamily: "system-ui, sans-serif",
    lineHeight: "1.2",
    border: "1px solid #ccc",
    borderRadius: "6px",
    background: "#fff",
    color: "#111",
    boxShadow: inline ? "none" : "0 2px 8px rgba(0,0,0,0.15)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
  } as CSSStyleDeclaration);
}

function createAskButton(
  getPending: () => SelectionAnchor | null,
  onAsk: AskButtonHandler,
  hide: () => void,
  inline: boolean
): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = inline ? ASK_BUTTON_INJECTED : ASK_BUTTON_ID;
  button.type = "button";
  button.textContent = "Ask about this";
  button.dataset.aiHelperAsk = "1";
  styleAskButton(button, inline);
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const anchor = getPending();
    if (anchor) onAsk(anchor);
    hide();
    window.getSelection()?.removeAllRanges();
  });
  return button;
}

/** Find ChatGPT's native "Ask ChatGPT" control and its toolbar row. */
function findNativeAskToolbar(): {
  button: HTMLElement;
  row: HTMLElement;
} | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='button'], a")
  );
  const native = candidates.find((el) => {
    if (el.dataset.aiHelperAsk) return false;
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    return txt === "Ask ChatGPT" || txt.startsWith("Ask ChatGPT");
  });
  if (!native?.parentElement) return null;
  return { button: native, row: native.parentElement };
}

/**
 * Always show a floating "Ask about this" near the selection.
 * Also try injecting next to ChatGPT's toolbar when present (bonus), but
 * never rely on that alone — React often remounts and drops injected nodes.
 */
export function attachSelectionHandler(
  getMessageRoots: () => HTMLElement[],
  onAsk: AskButtonHandler
): () => void {
  let button: HTMLButtonElement | null = null;
  let pending: SelectionAnchor | null = null;
  let toolbarObserver: MutationObserver | null = null;
  let injectTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;

  const clearObserver = () => {
    toolbarObserver?.disconnect();
    toolbarObserver = null;
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
  };

  const hide = () => {
    clearObserver();
    document
      .querySelectorAll<HTMLElement>("[data-ai-helper-ask='1']")
      .forEach((el) => el.remove());
    button = null;
    pending = null;
  };

  const positionFloating = (el: HTMLElement, rect: DOMRect) => {
    const top = Math.min(
      window.innerHeight - 40,
      Math.max(8, rect.bottom + 8)
    );
    const left = Math.min(
      window.innerWidth - 160,
      Math.max(8, rect.left)
    );
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  };

  const placeFloating = (anchor: SelectionAnchor) => {
    const existing = document.getElementById(
      ASK_BUTTON_ID
    ) as HTMLButtonElement | null;
    if (existing) {
      button = existing;
      positionFloating(existing, anchor.rect);
      return;
    }
    button = createAskButton(() => pending, onAsk, hide, false);
    positionFloating(button, anchor.rect);
    document.body.appendChild(button);
  };

  const tryInjectIntoToolbar = (): boolean => {
    if (!pending) return false;
    if (document.getElementById(ASK_BUTTON_INJECTED)) return true;

    const found = findNativeAskToolbar();
    if (!found) return false;

    const injected = createAskButton(() => pending, onAsk, hide, true);
    if (found.button.nextSibling) {
      found.button.parentElement?.insertBefore(
        injected,
        found.button.nextSibling
      );
    } else {
      found.row.appendChild(injected);
    }

    try {
      const cs = getComputedStyle(found.button);
      injected.style.fontSize = cs.fontSize || injected.style.fontSize;
      injected.style.borderRadius =
        cs.borderRadius || injected.style.borderRadius;
      injected.style.padding = cs.padding || injected.style.padding;
      injected.style.fontFamily = cs.fontFamily || injected.style.fontFamily;
    } catch {
      // ignore style copy failures
    }
    return true;
  };

  const show = (anchor: SelectionAnchor) => {
    // Keep pending across re-shows so we don't flicker the floating button away.
    pending = anchor;
    placeFloating(anchor);
    tryInjectIntoToolbar();

    if (!toolbarObserver) {
      toolbarObserver = new MutationObserver(() => {
        if (!pending) return;
        // Re-inject if ChatGPT remounted the toolbar and dropped our node.
        tryInjectIntoToolbar();
        // Always ensure floating exists as the reliable path.
        if (!document.getElementById(ASK_BUTTON_ID)) {
          placeFloating(pending);
        }
      });
      toolbarObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
      injectTimer = setTimeout(() => clearObserver(), 4000);
    }
  };

  const refreshFromSelection = () => {
    const anchor = getSelectionAnchor(getMessageRoots());
    if (anchor) {
      show(anchor);
      return;
    }
    // ChatGPT often collapses the native selection when its own toolbar mounts.
    // If we already captured an anchor, keep the floating button visible.
    if (pending && document.getElementById(ASK_BUTTON_ID)) {
      return;
    }
    if (pending && document.getElementById(ASK_BUTTON_INJECTED)) {
      placeFloating(pending);
      return;
    }
    const overAsk = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ai-helper-ask='1']")
    );
    if (overAsk.some((el) => el.matches(":hover"))) return;
  };

  const scheduleRefresh = (delayMs: number) => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      refreshFromSelection();
    }, delayMs);
  };

  const onMouseUp = () => scheduleRefresh(40);
  const onTouchEnd = () => scheduleRefresh(60);
  const onKeyUp = (e: KeyboardEvent) => {
    if (
      e.key === "Shift" ||
      e.key.startsWith("Arrow") ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      scheduleRefresh(40);
    }
  };
  const onSelectionChange = () => scheduleRefresh(80);

  const onPointerDown = (e: Event) => {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (
      t instanceof Element &&
      (t.closest("[data-ai-helper-ask='1']") ||
        t.closest(`#${ASK_BUTTON_ID}`) ||
        t.closest(`#${ASK_BUTTON_INJECTED}`))
    ) {
      return;
    }
    // Click elsewhere dismisses our button (and pending).
    if (pending) {
      // Defer so a click on Ask still sees pending in mousedown/click handlers.
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        hide();
      }, 0);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && pending) hide();
  };

  /** Keep the Ask button while scrolling; only hide if the anchor is gone. */
  const onScroll = () => {
    if (!pending) return;
    if (!pending.messageRoot.isConnected) {
      hide();
      return;
    }
    const live = getSelectionAnchor(getMessageRoots());
    const rect =
      live && live.messageRoot === pending.messageRoot
        ? live.rect
        : getAnchorRect(pending);
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      document.getElementById(ASK_BUTTON_ID)?.remove();
      if (button?.id === ASK_BUTTON_ID) button = null;
      return;
    }
    if (live) pending = live;
    else pending = { ...pending, rect };
    placeFloating(pending);
    tryInjectIntoToolbar();
  };

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("touchend", onTouchEnd, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("scroll", onScroll, true);

  return () => {
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("touchend", onTouchEnd, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("scroll", onScroll, true);
    if (selectionTimer) clearTimeout(selectionTimer);
    hide();
  };
}

/** Remove previously injected highlight marks without deleting their text. */
export function unwrapHighlights(root: HTMLElement): void {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>("mark[data-thread-id]")
  );
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  root.normalize();
}

/**
 * Wrap plain-text character ranges with <mark> inside the existing DOM,
 * preserving headers, lists, and other ChatGPT formatting.
 */
export function wrapHighlightsInPlace(
  root: HTMLElement,
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[]
): void {
  unwrapHighlights(root);

  const textLen = getPlainText(root).length;
  const kept = filterNonOverlapping(threads, textLen);
  // Apply from the end so earlier offsets stay valid while splitting nodes.
  const ordered = [...kept].sort((a, b) => b.anchorStart - a.anchorStart);

  for (const t of ordered) {
    wrapTextRange(root, t.anchorStart, t.anchorEnd, t.id);
  }
}

function wrapTextRange(
  root: HTMLElement,
  start: number,
  end: number,
  threadId: string
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  const segments: { node: Text; from: number; to: number }[] = [];

  let current: Node | null = walker.nextNode();
  while (current) {
    const node = current as Text;
    // Skip text inside marks we just added (shouldn't happen when applying end→start).
    if (node.parentElement?.closest("mark[data-thread-id]")) {
      offset += node.data.length;
      current = walker.nextNode();
      continue;
    }

    const len = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    const from = Math.max(0, start - nodeStart);
    const to = Math.min(len, end - nodeStart);
    if (from < to) {
      segments.push({ node, from, to });
    }
    offset = nodeEnd;
    if (offset >= end) break;
    current = walker.nextNode();
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    wrapTextNodePortion(seg.node, seg.from, seg.to, threadId);
  }
}

function wrapTextNodePortion(
  node: Text,
  from: number,
  to: number,
  threadId: string
): void {
  const parent = node.parentNode;
  if (!parent) return;

  const text = node.data;
  const before = text.slice(0, from);
  const mid = text.slice(from, to);
  const after = text.slice(to);
  if (!mid) return;

  const mark = document.createElement("mark");
  mark.dataset.threadId = threadId;
  mark.textContent = mid;
  mark.style.background = "rgba(201, 162, 39, 0.45)";
  mark.style.borderRadius = "2px";
  mark.style.cursor = "pointer";

  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  frag.appendChild(mark);
  if (after) frag.appendChild(document.createTextNode(after));
  parent.replaceChild(frag, node);
}

/**
 * Apply highlight marks to a message element from stored thread offsets.
 * Preserves the host page's DOM structure (lists, headings, etc.).
 */
export function applyHighlightsToElement(
  el: HTMLElement,
  threads: Thread[]
): void {
  const relevant = threads.filter((t) => t.anchorEnd > t.anchorStart);

  const rawText = getPlainText(el);
  if (!rawText) {
    return;
  }

  if (!el.dataset.aiHelperRaw) {
    el.dataset.aiHelperRaw = rawText;
  }

  wrapHighlightsInPlace(el, relevant);
}
