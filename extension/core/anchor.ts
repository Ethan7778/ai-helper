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

  // Fallback: if the node isn't a direct text child of root's tree, try
  // walking up / measuring via Range when possible.
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
 * Overlaps are rejected (later starts that collide with a kept interval
 * are skipped). TODO: replace with a real interval-based renderer that
 * can split/merge overlapping highlights cleanly.
 */
export function renderWithHighlights(
  rawText: string,
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[]
): string {
  const sorted = [...threads].sort((a, b) => a.anchorStart - b.anchorStart);
  const kept: typeof sorted = [];
  let lastEnd = -1;

  for (const t of sorted) {
    if (t.anchorStart < 0 || t.anchorEnd > rawText.length || t.anchorStart >= t.anchorEnd) {
      continue;
    }
    if (t.anchorStart < lastEnd) {
      // Overlap with a previously kept interval — skip for now.
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
 */
export function getSelectionAnchor(
  messageRoots: HTMLElement[]
): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const { startContainer, startOffset, endContainer, endOffset } = range;

  const messageRoot = messageRoots.find(
    (root) =>
      root.contains(startContainer) && root.contains(endContainer)
  );
  if (!messageRoot) {
    return null;
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

  return {
    messageRoot,
    start,
    end,
    quotedText,
    rect: range.getBoundingClientRect(),
  };
}

const ASK_BUTTON_ID = "ai-helper-ask-btn";

export type AskButtonHandler = (anchor: SelectionAnchor) => void;

/**
 * Position a floating "Ask about this" button at the selection's bounding
 * rect. Returns a dispose function that removes the button and listener.
 */
export function attachSelectionHandler(
  getMessageRoots: () => HTMLElement[],
  onAsk: AskButtonHandler
): () => void {
  let button: HTMLButtonElement | null = null;
  let pending: SelectionAnchor | null = null;

  const hide = () => {
    button?.remove();
    button = null;
    pending = null;
  };

  const show = (anchor: SelectionAnchor) => {
    hide();
    pending = anchor;
    button = document.createElement("button");
    button.id = ASK_BUTTON_ID;
    button.type = "button";
    button.textContent = "Ask about this";
    Object.assign(button.style, {
      position: "fixed",
      zIndex: "2147483646",
      top: `${Math.max(8, anchor.rect.top - 36)}px`,
      left: `${Math.max(8, anchor.rect.left)}px`,
      padding: "6px 10px",
      fontSize: "12px",
      fontFamily: "system-ui, sans-serif",
      lineHeight: "1.2",
      border: "1px solid #ccc",
      borderRadius: "6px",
      background: "#fff",
      color: "#111",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      cursor: "pointer",
    } as CSSStyleDeclaration);
    button.addEventListener("mousedown", (e) => {
      // Prevent clearing the selection before click fires.
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pending) {
        onAsk(pending);
      }
      hide();
      window.getSelection()?.removeAllRanges();
    });
    document.body.appendChild(button);
  };

  const onMouseUp = () => {
    // Defer so the browser finishes updating the selection.
    setTimeout(() => {
      const anchor = getSelectionAnchor(getMessageRoots());
      if (anchor) {
        show(anchor);
      } else if (!button?.matches(":hover")) {
        hide();
      }
    }, 10);
  };

  const onScroll = () => hide();

  document.addEventListener("mouseup", onMouseUp);
  window.addEventListener("scroll", onScroll, true);

  return () => {
    document.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("scroll", onScroll, true);
    hide();
  };
}

/**
 * Apply highlight marks to a message element from stored thread offsets.
 * Replaces the element's text content structure with highlighted HTML.
 * Callers should only do this when the message is complete / stable.
 */
export function applyHighlightsToElement(
  el: HTMLElement,
  threads: Thread[]
): void {
  const relevant = threads.filter((t) => {
    // Caller may already filter by messageId; keep all passed threads.
    return t.anchorEnd > t.anchorStart;
  });

  // Prefer the element's current plain text as the source of truth so
  // offsets stay aligned with what getTextOffset measured.
  const rawText = getPlainText(el);
  if (!rawText) {
    return;
  }

  // Preserve a data attribute so we can restore / re-apply later.
  if (!el.dataset.aiHelperRaw) {
    el.dataset.aiHelperRaw = rawText;
  }

  const source = el.dataset.aiHelperRaw || rawText;
  el.innerHTML = renderWithHighlights(source, relevant);
}
