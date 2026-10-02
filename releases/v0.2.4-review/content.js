"use strict";
(() => {
  // extension/core/dom.ts
  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function waitForElement(selectors, timeoutMs) {
    const found = queryFirst(selectors);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      let done = false;
      const finish = (el) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      };
      const observer = new MutationObserver(() => {
        const el = queryFirst(selectors);
        if (el) finish(el);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }
  function rafThrottle(fn) {
    let frame = 0;
    let lastArgs = null;
    const throttled = (...args) => {
      lastArgs = args;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (lastArgs) fn(...lastArgs);
      });
    };
    throttled.cancel = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    return throttled;
  }

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
  var BUILD_TIME = true ? "pointer-selection-v0.2.4-2026-10-02" : "dev";
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

  // extension/adapters/dom-adapter.ts
  var CHAT_ROOT_TIMEOUT_MS = 1e4;
  var MUTATION_QUIET_MS = 500;
  function simpleHash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }
  function queryInnermost(selectors) {
    if (selectors.length === 0) return [];
    const all = Array.from(
      document.querySelectorAll(selectors.join(", "))
    );
    return all.filter(
      (el) => !all.some((other) => other !== el && el.contains(other))
    );
  }
  function describeElement(el) {
    if (!el) return "none";
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;
  }
  function createDomAdapter(config) {
    const log10 = createLogger(`${config.siteId}-adapter`);
    const allAssistantSelector = [
      ...config.assistantSelectors,
      ...config.assistantFallbackSelectors
    ].join(", ");
    let warnedEmpty = false;
    let warnedEmptyExcerpt = false;
    let lastMatchSummary = "";
    let observedRoot = null;
    let reconcileImpl = () => {
    };
    const contentRootOf = (turn) => turn.querySelector(config.contentSelector) ?? turn;
    const findAssistantTurns = () => {
      const stable = queryInnermost(config.assistantSelectors);
      const turns = stable.length > 0 ? stable : queryInnermost(config.assistantFallbackSelectors);
      const summary = stable.length > 0 ? `attribute selectors matched ${stable.length}` : `fallback selectors matched ${turns.length}`;
      if (summary !== lastMatchSummary) {
        lastMatchSummary = summary;
        log10.debug(`Assistant turns: ${summary}`);
      }
      return turns;
    };
    const adapter = {
      siteId: config.siteId,
      selectionStrategy: config.selectionStrategy,
      getConversationId() {
        return config.conversationIdFromPath(location.pathname) ?? `anon-${location.pathname || "root"}`;
      },
      getConversationExcerpt(maxChars) {
        const turns = config.excerptTurns();
        if (turns.length === 0) {
          return "";
        }
        warnedEmptyExcerpt = false;
        const chunks = [];
        for (const { role, el } of turns) {
          const text = (contentRootOf(el).innerText || "").replace(/\s+/g, " ").trim();
          if (!text) continue;
          chunks.push(`${role.toUpperCase()}: ${text}`);
        }
        if (chunks.length === 0) {
          if (!warnedEmptyExcerpt) {
            log10.warn("Conversation excerpt: turns present but no usable text.");
            warnedEmptyExcerpt = true;
          }
          return "";
        }
        let excerpt = "";
        for (let i = chunks.length - 1; i >= 0; i--) {
          const next = excerpt ? `${chunks[i]}

${excerpt}` : chunks[i];
          if (next.length > maxChars) {
            if (!excerpt) {
              excerpt = chunks[i].slice(-maxChars);
            }
            break;
          }
          excerpt = next;
        }
        return excerpt;
      },
      getMessageContainers() {
        const turns = findAssistantTurns();
        if (turns.length === 0) {
          if (!warnedEmpty && queryFirst(config.userSelectors)) {
            log10.warn(
              `Found user turns but no assistant messages (tried: ${allAssistantSelector}). The site DOM may have changed.`
            );
            warnedEmpty = true;
          }
          return [];
        }
        warnedEmpty = false;
        return Array.from(new Set(turns.map(contentRootOf)));
      },
      getMessageRootForNode(node) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const turn = el?.closest(allAssistantSelector);
        return turn ? contentRootOf(turn) : null;
      },
      getMessageId(el) {
        const turn = el.closest(allAssistantSelector) ?? el;
        const fromSite = config.messageIdFor(turn);
        if (fromSite) return fromSite;
        const containers = adapter.getMessageContainers();
        const index = containers.indexOf(el);
        const prefix = (el.innerText || "").slice(0, 80).replace(/\s+/g, " ");
        return `hash-${simpleHash(`${index}:${prefix}`)}`;
      },
      isMessageComplete(el) {
        for (const sel of config.streamingSelectors) {
          if (el.closest(sel) || el.querySelector(sel)) return false;
        }
        const containers = adapter.getMessageContainers();
        if (containers[containers.length - 1] !== el) return true;
        return !queryFirst(config.stopButtonSelectors);
      },
      onNewMessage(cb) {
        const seen = /* @__PURE__ */ new WeakSet();
        let observer = null;
        let quietTimer = null;
        let lastHref = location.href;
        let disposed = false;
        const reportExisting = () => {
          for (const el of adapter.getMessageContainers()) {
            if (seen.has(el)) continue;
            seen.add(el);
            cb(el);
          }
        };
        const attach = (root) => {
          observer?.disconnect();
          observedRoot = root;
          observer = new MutationObserver(() => {
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(reportExisting, MUTATION_QUIET_MS);
          });
          observer.observe(root, { childList: true, subtree: true });
          log10.debug(`Observing chat root ${describeElement(root)}`);
        };
        reportExisting();
        void waitForElement(config.chatRootSelectors, CHAT_ROOT_TIMEOUT_MS).then(
          (root) => {
            if (disposed) return;
            if (!root) {
              log10.warn(
                `Chat container (${config.chatRootSelectors.join(", ")}) not found after ${CHAT_ROOT_TIMEOUT_MS / 1e3}s; observing <body> instead.`
              );
            }
            attach(root ?? document.body);
            reportExisting();
          }
        );
        reconcileImpl = () => {
          if (disposed) return;
          let changed = false;
          if (observedRoot && !observedRoot.isConnected) {
            log10.debug("Chat root was replaced by the page; re-attaching observer");
            attach(queryFirst(config.chatRootSelectors) ?? document.body);
            changed = true;
          }
          if (location.href !== lastHref) {
            lastHref = location.href;
            warnedEmpty = false;
            changed = true;
          }
          if (changed) reportExisting();
        };
        return () => {
          disposed = true;
          observer?.disconnect();
          observer = null;
          observedRoot = null;
          if (quietTimer) clearTimeout(quietTimer);
          reconcileImpl = () => {
          };
        };
      },
      reconcile() {
        reconcileImpl();
      },
      describeDom() {
        const selectorHits = {};
        for (const sel of [
          ...config.assistantSelectors,
          ...config.assistantFallbackSelectors,
          ...config.userSelectors,
          ...config.streamingSelectors,
          ...config.stopButtonSelectors
        ]) {
          selectorHits[sel] = document.querySelectorAll(sel).length;
        }
        const turns = findAssistantTurns();
        return {
          chatRoot: describeElement(queryFirst(config.chatRootSelectors)),
          observedRoot: observedRoot ? `${describeElement(observedRoot)} connected=${observedRoot.isConnected}` : "none",
          assistantTurns: turns.length,
          turnsWithMarkdownBody: turns.filter(
            (t) => t.querySelector(config.contentSelector) !== null
          ).length,
          selectorHits
        };
      }
    };
    return adapter;
  }

  // extension/adapters/chatgpt.ts
  var MODERN_ASSISTANT_SELECTOR = '[data-markdown-text-style="assistant-message"]';
  var MODERN_USER_SELECTORS = [
    '[data-content-search-unit-key$=":user"]',
    '[data-chatgpt-search-unit-key$=":user"]'
  ];
  var ROLE_SELECTOR = [
    "[data-message-author-role]",
    "[data-turn]",
    "[data-turn-role]",
    '[data-content-search-unit-key$=":assistant"]',
    '[data-content-search-unit-key$=":user"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":user"]'
  ].join(", ");
  function roleFor(el) {
    const legacyRole = el.getAttribute("data-message-author-role") || el.getAttribute("data-turn") || el.getAttribute("data-turn-role");
    if (legacyRole === "user" || legacyRole === "assistant") {
      return legacyRole;
    }
    const searchKey = el.getAttribute("data-content-search-unit-key") || el.getAttribute("data-chatgpt-search-unit-key");
    if (searchKey?.endsWith(":assistant")) return "assistant";
    if (searchKey?.endsWith(":user")) return "user";
    return null;
  }
  function createChatGptAdapter() {
    return createDomAdapter({
      siteId: "chatgpt",
      selectionStrategy: "pointer",
      assistantSelectors: [
        MODERN_ASSISTANT_SELECTOR,
        '[data-message-author-role="assistant"]',
        '[data-turn="assistant"]',
        'article[data-turn-role="assistant"]',
        '[data-testid="assistant-message"]'
      ],
      assistantFallbackSelectors: [".agent-turn"],
      userSelectors: [
        ...MODERN_USER_SELECTORS,
        '[data-message-author-role="user"]',
        '[data-turn="user"]',
        'article[data-turn-role="user"]'
      ],
      contentSelector: '[data-markdown-text-style="assistant-message"], .markdown, .prose, [class*="markdown" i], [class*="prose" i], .whitespace-pre-wrap',
      streamingSelectors: ['[data-is-streaming="true"]', ".result-streaming"],
      // data-testid is language-independent; aria-labels are English-only fallbacks.
      stopButtonSelectors: [
        '[data-testid="stop-button"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Stop streaming"]'
      ],
      chatRootSelectors: ['[data-thread-find-target="conversation"]', "main", '[role="main"]'],
      conversationIdFromPath: (pathname) => pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/)?.[2] ?? null,
      messageIdFor: (turn) => turn.closest('[data-chatgpt-selection-message-id]')?.getAttribute("data-chatgpt-selection-message-id") || turn.getAttribute("data-message-id") || turn.getAttribute("data-testid") || turn.id || null,
      excerptTurns: () => Array.from(document.querySelectorAll(ROLE_SELECTOR)).flatMap(
        (el) => {
          const role = roleFor(el);
          return role ? [{ role, el }] : [];
        }
      )
    });
  }

  // extension/adapters/claude.ts
  var ASSISTANT = '[data-testid="assistant-message"]';
  var USER = '[data-testid="user-message"]';
  function createClaudeAdapter() {
    return createDomAdapter({
      siteId: "claude",
      assistantSelectors: [ASSISTANT],
      assistantFallbackSelectors: [".font-claude-response", ".font-claude-message"],
      userSelectors: [USER],
      contentSelector: ".font-claude-response, .font-claude-message",
      streamingSelectors: ['[data-is-streaming="true"]'],
      stopButtonSelectors: [],
      // The transcript is virtualized; rows mount/unmount inside this list.
      chatRootSelectors: [
        '[data-testid="transcript-list"]',
        '[data-testid="chat-column"]',
        "main"
      ],
      conversationIdFromPath: (pathname) => pathname.match(/\/chat\/([0-9a-f-]{8,})/i)?.[1] ?? null,
      messageIdFor: (turn) => {
        const index = turn.closest('[data-testid="transcript-row"]')?.getAttribute("data-index");
        return index != null ? `row-${index}` : null;
      },
      excerptTurns: () => Array.from(
        document.querySelectorAll(`${USER}, ${ASSISTANT}`)
      ).map((el) => ({
        role: el.matches(USER) ? "user" : "assistant",
        el
      }))
    });
  }

  // extension/adapters/gemini.ts
  function createGeminiAdapter() {
    return createDomAdapter({
      siteId: "gemini",
      // Angular custom elements; far more stable than Gemini's generated classes.
      assistantSelectors: ["model-response"],
      assistantFallbackSelectors: [".model-response-text"],
      userSelectors: ["user-query"],
      // The answer body; `model-thoughts` sits before it and must not win.
      contentSelector: "message-content .markdown",
      streamingSelectors: ['[aria-busy="true"]'],
      stopButtonSelectors: [],
      chatRootSelectors: [
        '[data-test-id="chat-history-container"]',
        "infinite-scroller.chat-history",
        "chat-window",
        "main"
      ],
      conversationIdFromPath: (pathname) => pathname.match(/\/(?:app|gem\/[^/]+)\/([0-9a-f]{8,})/i)?.[1] ?? null,
      messageIdFor: (turn) => {
        const id = turn.querySelector("message-content[id]")?.id;
        return id ? id.replace(/^message-content-id-/, "") : null;
      },
      excerptTurns: () => Array.from(
        document.querySelectorAll("user-query, model-response")
      ).map((el) => ({
        role: el.tagName.toLowerCase() === "user-query" ? "user" : "assistant",
        el
      }))
    });
  }

  // extension/core/anchor.ts
  var log = createLogger("anchor");
  function getTextOffset(root, node, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let current = walker.nextNode();
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
  function getPlainText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    let current = walker.nextNode();
    while (current) {
      text += current.textContent ?? "";
      current = walker.nextNode();
    }
    return text;
  }
  function filterNonOverlapping(threads, textLen) {
    const sorted = [...threads].sort((a, b) => a.anchorStart - b.anchorStart);
    const kept = [];
    let lastEnd = -1;
    for (const t of sorted) {
      if (t.anchorStart < 0 || t.anchorEnd > textLen || t.anchorStart >= t.anchorEnd) {
        continue;
      }
      if (t.anchorStart < lastEnd) {
        log.warn(
          "Skipping overlapping highlight",
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
  function usableRect(rect) {
    return (rect.width > 0 || rect.height > 0) && Number.isFinite(rect.top);
  }
  function rangeRect(range) {
    let rect = range.getBoundingClientRect();
    if (!usableRect(rect)) {
      const rects = range.getClientRects();
      if (rects.length > 0) rect = rects[0];
    }
    return rect;
  }
  function rangePlacementRect(range) {
    const rects = range.getClientRects();
    for (let i = rects.length - 1; i >= 0; i--) {
      const rect = rects[i];
      if (usableRect(rect)) return rect;
    }
    return rangeRect(range);
  }
  function selectionPlacementRect(sel, range) {
    if (sel.focusNode) {
      try {
        const caret = document.createRange();
        caret.setStart(sel.focusNode, sel.focusOffset);
        caret.collapse(true);
        const caretRect = caret.getBoundingClientRect();
        if (usableRect(caretRect)) return caretRect;
      } catch {
      }
    }
    const rects = range.getClientRects();
    if (rects.length > 0) {
      const focusIsStart = sel.focusNode === range.startContainer && sel.focusOffset === range.startOffset;
      const rect = focusIsStart ? rects[0] : rects[rects.length - 1];
      if (usableRect(rect)) return rect;
    }
    return rangeRect(range);
  }
  function normalizeWhitespaceWithMap(text) {
    let out = "";
    const starts = [];
    const ends = [];
    for (let i = 0; i < text.length; ) {
      if (/\s/.test(text[i])) {
        const start = i;
        while (i < text.length && /\s/.test(text[i])) i++;
        out += " ";
        starts.push(start);
        ends.push(i);
      } else {
        out += text[i];
        starts.push(i);
        ends.push(i + 1);
        i++;
      }
    }
    return { text: out, starts, ends };
  }
  function recoverSelectionAnchor(messageRoots, quotedText, selectionRect) {
    const wanted = normalizeWhitespaceWithMap(quotedText).text.trim();
    if (!wanted) return null;
    const sx = selectionRect.left + selectionRect.width / 2;
    const sy = selectionRect.top + selectionRect.height / 2;
    let best = null;
    for (const root of messageRoots) {
      const raw = getPlainText(root);
      if (!raw) continue;
      const mapped = normalizeWhitespaceWithMap(raw);
      let from = 0;
      while (from <= mapped.text.length - wanted.length) {
        const at = mapped.text.indexOf(wanted, from);
        if (at < 0) break;
        const last = at + wanted.length - 1;
        const start = mapped.starts[at];
        const end = mapped.ends[last];
        if (start == null || end == null || start >= end) {
          from = at + 1;
          continue;
        }
        const candidateRange = rangeFromOffsets(root, start, end);
        const candidateRect = candidateRange?.getBoundingClientRect();
        const rect = candidateRect && usableRect(candidateRect) ? candidateRect : root.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const rootRect = root.getBoundingClientRect();
        const overlapsRoot = usableRect(selectionRect) && selectionRect.right >= rootRect.left && selectionRect.left <= rootRect.right && selectionRect.bottom >= rootRect.top && selectionRect.top <= rootRect.bottom;
        const score = Math.hypot(cx - sx, cy - sy) + (overlapsRoot ? 0 : 1e4);
        const anchor = {
          messageRoot: root,
          start,
          end,
          quotedText,
          rect,
          placementRect: candidateRange ? rangePlacementRect(candidateRange) : rect
        };
        if (!best || score < best.score) best = { anchor, score };
        from = at + 1;
      }
    }
    return best?.anchor ?? null;
  }
  function getSelectionAnchor(messageRoots, findRootForNode) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return null;
    }
    const range = sel.getRangeAt(0);
    const { startContainer, endContainer } = range;
    const startOffset = range.startOffset;
    const endOffset = range.endOffset;
    const quotedText = range.toString();
    if (!quotedText.trim()) return null;
    const rect = rangeRect(range);
    const placementRect = selectionPlacementRect(sel, range);
    let messageRoot = messageRoots.find(
      (root) => root.contains(startContainer) && root.contains(endContainer)
    ) ?? null;
    if (!messageRoot) {
      messageRoot = findRootForNode?.(startContainer) ?? null;
      if (!messageRoot || !messageRoot.contains(startContainer) || !messageRoot.contains(endContainer)) {
        return recoverSelectionAnchor(messageRoots, quotedText, rect);
      }
    }
    const start = getTextOffset(messageRoot, startContainer, startOffset);
    const end = getTextOffset(messageRoot, endContainer, endOffset);
    if (start < 0 || end < 0 || start >= end) {
      return recoverSelectionAnchor(messageRoots, quotedText, rect);
    }
    return { messageRoot, start, end, quotedText, rect, placementRect };
  }
  function getAnchorRect(anchor) {
    if (!anchor.messageRoot.isConnected) return null;
    const range = rangeFromOffsets(anchor.messageRoot, anchor.start, anchor.end);
    return range ? rangeRect(range) : null;
  }
  function getAnchorPlacementRect(anchor) {
    if (!anchor.messageRoot.isConnected) return null;
    const range = rangeFromOffsets(anchor.messageRoot, anchor.start, anchor.end);
    return range ? rangePlacementRect(range) : null;
  }
  function rangeFromOffsets(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null;
    let startOff = 0;
    let endNode = null;
    let endOff = 0;
    let current = walker.nextNode();
    while (current) {
      const node = current;
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
  var ASK_BUTTON_ID = "ai-helper-ask-btn";
  function styleAskButton(button) {
    Object.assign(button.style, {
      position: "fixed",
      zIndex: "2147483646",
      margin: "0",
      padding: "7px 14px",
      fontSize: "13px",
      fontWeight: "500",
      fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Helvetica, Arial, sans-serif',
      lineHeight: "1.2",
      letterSpacing: "0.01em",
      // Light hairline keeps the black pill visible in ChatGPT's dark theme too.
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "9999px",
      background: ASK_BG,
      color: "#fff",
      boxShadow: "0 4px 16px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.18)",
      cursor: "pointer",
      whiteSpace: "nowrap",
      flexShrink: "0",
      transition: "background-color 120ms ease, transform 120ms ease"
    });
    button.addEventListener("mouseenter", () => {
      button.style.background = ASK_BG_HOVER;
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = ASK_BG;
      button.style.transform = "";
    });
    button.addEventListener("mousedown", () => {
      button.style.transform = "scale(0.97)";
    });
  }
  var ASK_BG = "#0d0d0d";
  var ASK_BG_HOVER = "#2f2f2f";
  function createAskButton(getPending, onAsk, hide) {
    const button = document.createElement("button");
    button.id = ASK_BUTTON_ID;
    button.type = "button";
    button.textContent = "Ask about this";
    button.dataset.aiHelperAsk = "1";
    styleAskButton(button);
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
  function selectionSpan(anchor) {
      return Math.max(0, anchor.end - anchor.start);
  }
  /**
   * ChatGPT occasionally replaces a just-finished selection with a tiny portal
   * fragment (observed as "et"). Keep a much better drag snapshot instead of
   * accepting that host-generated truncation.
   */
  function chooseReleasedAnchor(current, bestDrag) {
      if (!current)
          return bestDrag;
      if (!bestDrag || current.messageRoot !== bestDrag.messageRoot)
          return current;
      const currentSpan = selectionSpan(current);
      const bestSpan = selectionSpan(bestDrag);
      const tinyHostFragment = bestSpan >= 8 && currentSpan < bestSpan && currentSpan <= 4;
      return tinyHostFragment ? bestDrag : current;
  }
  /** Chrome exposes caretRangeFromPoint; caretPositionFromPoint is the standards path. */
  function caretPointFromClient(x, y) {
      const doc = document;
      try {
          const pos = doc.caretPositionFromPoint?.(x, y);
          if (pos?.offsetNode) {
              return { node: pos.offsetNode, offset: pos.offset };
          }
      }
      catch {
          // Fall through to Chrome's legacy API.
      }
      try {
          const range = doc.caretRangeFromPoint?.(x, y);
          if (range) {
              return { node: range.startContainer, offset: range.startOffset };
          }
      }
      catch {
          // A host overlay may briefly make a point non-resolvable.
      }
      return null;
  }
  function messageRootForNode(messageRoots, node, findRootForNode) {
      return (messageRoots.find((root) => root.contains(node)) ??
          findRootForNode?.(node) ??
          null);
  }
  function compareCaretPoints(a, b) {
      const ar = document.createRange();
      const br = document.createRange();
      try {
          ar.setStart(a.node, a.offset);
          ar.collapse(true);
          br.setStart(b.node, b.offset);
          br.collapse(true);
          return ar.compareBoundaryPoints(Range.START_TO_START, br);
      }
      catch {
          return 0;
      }
  }
  function rangeBetweenCarets(a, b) {
      const range = document.createRange();
      try {
          if (compareCaretPoints(a, b) <= 0) {
              range.setStart(a.node, a.offset);
              range.setEnd(b.node, b.offset);
          }
          else {
              range.setStart(b.node, b.offset);
              range.setEnd(a.node, a.offset);
          }
          return range;
      }
      catch {
          return null;
      }
  }
  function pointPlacementRect(x, y) {
      return new DOMRect(x, y, 1, 1);
  }
  /**
   * Build an anchor from pointer coordinates without consulting window.getSelection().
   * This is intentionally used by ChatGPT only: its selected-text overlay can replace
   * the browser selection with a tiny fragment even while the user's drag is intact.
   */
  function getPointerSelectionAnchor(start, x, y, messageRoots, findRootForNode) {
      const endPoint = caretPointFromClient(x, y);
      if (!endPoint)
          return null;
      const endRoot = messageRootForNode(messageRoots, endPoint.node, findRootForNode);
      if (!endRoot || endRoot !== start.messageRoot)
          return null;
      const range = rangeBetweenCarets(start, endPoint);
      if (!range || range.collapsed)
          return null;
      const quotedText = range.toString();
      if (!quotedText.trim())
          return null;
      const startOffset = getTextOffset(start.messageRoot, range.startContainer, range.startOffset);
      const endOffset = getTextOffset(start.messageRoot, range.endContainer, range.endOffset);
      if (startOffset < 0 || endOffset < 0 || startOffset >= endOffset) {
          return null;
      }
      return {
          messageRoot: start.messageRoot,
          start: startOffset,
          end: endOffset,
          quotedText,
          rect: rangeRect(range),
          placementRect: pointPlacementRect(x, y),
      };
  }
  function attachSelectionHandler(getMessageRoots, onAsk, findRootForNode, selectionStrategy = "native") {
      let pending = null;
      let selectionTimer = null;
      let pointerSelecting = false;
      let bestDragAnchor = null;
      let pointerReleaseLocked = false;
      let pointerSelectionStart = null;
      const hide = () => {
          document
              .querySelectorAll("[data-ai-helper-ask='1']")
              .forEach((el) => el.remove());
          pending = null;
      };
      const positionFloating = (el, rect) => {
          const top = Math.min(window.innerHeight - 40, Math.max(8, rect.bottom + 8));
          const left = Math.min(window.innerWidth - 160, Math.max(8, rect.left));
          el.style.top = `${top}px`;
          el.style.left = `${left}px`;
      };
      const placeFloating = (anchor) => {
          const existing = document.getElementById(ASK_BUTTON_ID);
          if (existing) {
              positionFloating(existing, anchor.placementRect);
              return;
          }
          const button = createAskButton(() => pending, onAsk, hide);
          positionFloating(button, anchor.placementRect);
          document.body.appendChild(button);
          log.debug("Ask button shown");
      };
      const show = (anchor) => {
          pending = anchor;
          placeFloating(anchor);
      };
      const refreshFromSelection = (allowHostMutation = true) => {
          const anchor = getSelectionAnchor(getMessageRoots(), findRootForNode);
          if (anchor) {
              if (pointerSelecting) {
                  if (!bestDragAnchor ||
                      bestDragAnchor.messageRoot !== anchor.messageRoot ||
                      selectionSpan(anchor) >= selectionSpan(bestDragAnchor)) {
                      bestDragAnchor = anchor;
                  }
                  show(anchor);
                  return;
              }
              // Immediately after pointer release, ChatGPT may swap the real range for
              // a tiny overlay fragment. Do not let that overwrite the captured quote.
              if (!allowHostMutation || pointerReleaseLocked) {
                  if (pending)
                      placeFloating(pending);
                  return;
              }
              show(anchor);
              return;
          }
          // ChatGPT often collapses the native selection when its own toolbar mounts.
          // If we already captured an anchor, keep the floating button visible.
          if (pending && document.getElementById(ASK_BUTTON_ID)) {
              return;
          }
          if (pending) {
              placeFloating(pending);
              return;
          }
      };
      const scheduleRefresh = (delayMs) => {
          if (selectionTimer)
              clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => {
              selectionTimer = null;
              refreshFromSelection();
          }, delayMs);
      };
      // Capture during the event, before the host's selection toolbar can clear
      // the native range. A delayed-only read loses it on ChatGPT.
      const onMouseUp = () => {
          if (selectionStrategy === "pointer")
              return;
          refreshFromSelection(!pointerReleaseLocked);
          if (!pointerReleaseLocked)
              scheduleRefresh(40);
      };
      const onTouchEnd = () => {
          if (selectionStrategy === "pointer")
              return;
          refreshFromSelection(!pointerReleaseLocked);
          if (!pointerReleaseLocked)
              scheduleRefresh(60);
      };
      const onKeyUp = (e) => {
          if (e.key === "Shift" ||
              e.key.startsWith("Arrow") ||
              e.key === "Home" ||
              e.key === "End") {
              pointerReleaseLocked = false;
              refreshFromSelection();
              scheduleRefresh(40);
          }
      };
      const onSelectionChange = () => {
          if (selectionStrategy === "pointer")
              return;
          refreshFromSelection(!pointerReleaseLocked);
          if (!pointerReleaseLocked)
              scheduleRefresh(80);
      };
      const captureDragSelection = rafThrottle(() => refreshFromSelection());
      const onPointerDown = (e) => {
          const t = e.target;
          if (!(t instanceof Node))
              return;
          if (t instanceof Element && t.closest("[data-ai-helper-ask='1']")) {
              return;
          }
          bestDragAnchor = null;
          pointerReleaseLocked = false;
          pointerSelectionStart = null;
          if (selectionTimer)
              clearTimeout(selectionTimer);
          selectionTimer = null;
          if (e.button !== 0) {
              pointerSelecting = false;
              return;
          }
          if (selectionStrategy === "pointer") {
              const roots = getMessageRoots();
              const caret = caretPointFromClient(e.clientX, e.clientY);
              const rootFromTarget = messageRootForNode(roots, t, findRootForNode);
              const rootFromCaret = caret
                  ? messageRootForNode(roots, caret.node, findRootForNode)
                  : null;
              const messageRoot = caret && rootFromTarget?.contains(caret.node)
                  ? rootFromTarget
                  : rootFromCaret;
              if (!caret || !messageRoot || !messageRoot.contains(caret.node)) {
                  pointerSelecting = false;
                  return;
              }
              pointerSelecting = true;
              pointerSelectionStart = { ...caret, messageRoot };
              hide();
              return;
          }
          pointerSelecting = true;
          // A new interaction invalidates the old quote, even if the host keeps its
          // old native selection. Clicks on Ask itself were excluded above.
          hide();
      };
      const onPointerMove = (e) => {
          if (!pointerSelecting || (e.buttons & 1) === 0)
              return;
          if (selectionStrategy === "pointer") {
              if (!pointerSelectionStart)
                  return;
              const anchor = getPointerSelectionAnchor(pointerSelectionStart, e.clientX, e.clientY, getMessageRoots(), findRootForNode);
              if (!anchor)
                  return;
              bestDragAnchor = anchor;
              show(anchor);
              return;
          }
          // Native strategy: snapshot continuously during the drag. Some hosts move
          // the selection into a portal before mouseup/selectionchange reaches us.
          captureDragSelection();
      };
      const onPointerUp = (e) => {
          if (!pointerSelecting)
              return;
          if (selectionStrategy === "pointer") {
              const released = pointerSelectionStart
                  ? getPointerSelectionAnchor(pointerSelectionStart, e.clientX, e.clientY, getMessageRoots(), findRootForNode) ?? bestDragAnchor
                  : bestDragAnchor;
              pointerSelecting = false;
              pointerSelectionStart = null;
              bestDragAnchor = null;
              if (released)
                  show(released);
              else
                  hide();
              pointerReleaseLocked = true;
              return;
          }
          captureDragSelection.cancel();
          const current = getSelectionAnchor(getMessageRoots(), findRootForNode);
          const released = chooseReleasedAnchor(current, bestDragAnchor);
          pointerSelecting = false;
          bestDragAnchor = null;
          if (released)
              show(released);
          // Freeze the released quote until the next real pointer/keyboard selection
          // interaction. Host-generated selectionchange events must not shrink it.
          pointerReleaseLocked = true;
      };
      const onKeyDown = (e) => {
          if (e.key === "Escape" && pending)
              hide();
      };
      /** Keep the Ask button while scrolling; only hide if the anchor is gone. */
      const onScroll = rafThrottle(() => {
          if (!pending)
              return;
          if (!pending.messageRoot.isConnected) {
              hide();
              return;
          }
          const rect = getAnchorRect(pending);
          const placementRect = getAnchorPlacementRect(pending);
          if (!rect ||
              !placementRect ||
              (rect.width === 0 && rect.height === 0)) {
              document.getElementById(ASK_BUTTON_ID)?.remove();
              return;
          }
          pending = { ...pending, rect, placementRect };
          placeFloating(pending);
      });
      document.addEventListener("mouseup", onMouseUp, true);
      document.addEventListener("touchend", onTouchEnd, true);
      document.addEventListener("keyup", onKeyUp, true);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("pointerup", onPointerUp, true);
      document.addEventListener("selectionchange", onSelectionChange);
      window.addEventListener("scroll", onScroll, true);
      return () => {
          document.removeEventListener("mouseup", onMouseUp, true);
          document.removeEventListener("touchend", onTouchEnd, true);
          document.removeEventListener("keyup", onKeyUp, true);
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("pointermove", onPointerMove, true);
          document.removeEventListener("pointerup", onPointerUp, true);
          document.removeEventListener("selectionchange", onSelectionChange);
          window.removeEventListener("scroll", onScroll, true);
          captureDragSelection.cancel();
          onScroll.cancel();
          if (selectionTimer)
              clearTimeout(selectionTimer);
          hide();
      };
  }
  function unwrapHighlights(root) {
    const marks = Array.from(
      root.querySelectorAll("mark[data-thread-id]")
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
  function wrapHighlightsInPlace(root, threads) {
    unwrapHighlights(root);
    const textLen = getPlainText(root).length;
    const kept = filterNonOverlapping(threads, textLen);
    const ordered = [...kept].sort((a, b) => b.anchorStart - a.anchorStart);
    for (const t of ordered) {
      wrapTextRange(root, t.anchorStart, t.anchorEnd, t.id);
    }
  }
  function wrapTextRange(root, start, end, threadId) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    const segments = [];
    let current = walker.nextNode();
    while (current) {
      const node = current;
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
      const seg = segments[i];
      wrapTextNodePortion(seg.node, seg.from, seg.to, threadId);
    }
  }
  function wrapTextNodePortion(node, from, to, threadId) {
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
  function applyHighlightsToElement(el, threads) {
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

  // extension/core/text-clean.ts
  function cleanChatGptText(text) {
    if (!text) return "";
    let out = text;
    out = out.replace(
      /\uE200entity\uE202(\[[\s\S]*?\])\uE201/g,
      (_m, json) => {
        try {
          const arr = JSON.parse(json);
          if (Array.isArray(arr)) {
            const name = arr[1] ?? arr[0];
            return typeof name === "string" ? name : "";
          }
        } catch {
        }
        return "";
      }
    );
    out = out.replace(/\uE200\w+\uE202[\s\S]*?\uE201/g, "");
    out = stripNamedJsonWidgets(out);
    out = out.replace(/[\uE000-\uF8FF]/g, "");
    out = out.replace(/[^\S\n]+/g, " ");
    out = out.replace(/ *\n */g, "\n");
    out = out.replace(/\n{3,}/g, "\n\n");
    return out.trim();
  }
  function stripNamedJsonWidgets(text) {
    const names = "image_group|image|cite|entity|product|navlist|finance|sports|weather|map|file|snippet|search|products";
    const nameRe = new RegExp(`(?:^|\\s)(${names})(?=[\\{\\[])`, "gi");
    let out = text;
    let guard = 0;
    while (guard++ < 50) {
      nameRe.lastIndex = 0;
      const m = nameRe.exec(out);
      if (!m || m.index == null) break;
      const start = m.index + (m[0].startsWith(" ") || m[0].startsWith("\n") ? 1 : 0);
      const openIdx = start + m[1].length;
      const open = out[openIdx];
      if (open !== "{" && open !== "[") break;
      const close = open === "{" ? "}" : "]";
      const end = findMatching(out, openIdx, open, close);
      if (end < 0) {
        out = out.slice(0, start) + out.slice(openIdx).replace(/^[^\n]*/, "");
        continue;
      }
      out = out.slice(0, start) + out.slice(end + 1);
    }
    out = out.replace(
      new RegExp(`\\b(?:${names})\\s*(?:\\{[^\\n]*|\\[[^\\n]*)`, "gi"),
      ""
    );
    return out;
  }
  function findMatching(s, openIdx, open, close) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  function formatReplyHtml(text) {
    const cleaned = cleanChatGptText(text);
    let html = escapeHtml(cleaned);
    html = html.replace(/(^|\n)#{1,6}\s+/g, "$1");
    html = html.replace(/(^|\n)&gt;\s?/g, "$1");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
    html = html.replace(/(^|\n)(?:-|\*) (.+)/g, "$1\u2022 $2");
    html = html.replace(/\n/g, "<br>");
    html = html.replace(/\*\*/g, "");
    return html;
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // extension/core/chatgpt-auth.ts
  var log2 = createLogger("chatgpt-auth");
  var SESSION_URL = "https://chatgpt.com/api/auth/session";
  async function fetchAccessTokenFromPage() {
    const res = await fetch(SESSION_URL, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (res.status === 401 || res.status === 403) {
      log2.error(`/api/auth/session HTTP ${res.status}`);
      throw new Error(
        "ChatGPT session unavailable \u2014 reload the page or re-login, then try again."
      );
    }
    if (!res.ok) {
      log2.error(`/api/auth/session HTTP ${res.status}`);
      throw new Error(`Failed to read ChatGPT session (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (!data.accessToken) {
      log2.error(`session JSON missing accessToken`);
      throw new Error(
        "No ChatGPT access token found. Make sure you are logged in on chatgpt.com."
      );
    }
    return {
      accessToken: data.accessToken,
      userAgent: navigator.userAgent
    };
  }

  // node_modules/js-sha3/build/sha3.mjs
  var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
  function getDefaultExportFromCjs(x) {
    return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
  }
  var sha3$1 = { exports: {} };
  (function(module) {
    (function() {
      var INPUT_ERROR = "input is invalid type";
      var FINALIZE_ERROR = "finalize already called";
      var TUPLE_ACTIVE_ERROR = "no active tuple input";
      var TUPLE_INCOMPLETE_ERROR = "tuple input is incomplete";
      var TUPLE_LENGTH_ERROR = "tuple input exceeds declared length";
      var TUPLE_BYTE_LENGTH_ERROR = "tuple input byte length is invalid";
      var BLOCK_SIZE_ERROR = "block size is invalid";
      var WINDOW = typeof window === "object";
      var root = WINDOW ? window : {};
      if (root.JS_SHA3_NO_WINDOW) {
        WINDOW = false;
      }
      var WEB_WORKER = !WINDOW && typeof self === "object";
      var NODE_JS = !root.JS_SHA3_NO_NODE_JS && typeof process === "object" && process.versions && process.versions.node;
      if (NODE_JS) {
        root = commonjsGlobal;
      } else if (WEB_WORKER) {
        root = self;
      }
      var COMMON_JS = !root.JS_SHA3_NO_COMMON_JS && true && module.exports;
      var ARRAY_BUFFER = !root.JS_SHA3_NO_ARRAY_BUFFER && typeof ArrayBuffer !== "undefined";
      var HEX_CHARS = "0123456789abcdef".split("");
      var SHAKE_PADDING = [31, 7936, 2031616, 520093696];
      var CSHAKE_PADDING = [4, 1024, 262144, 67108864];
      var KECCAK_PADDING = [1, 256, 65536, 16777216];
      var PADDING = [6, 1536, 393216, 100663296];
      var SHIFT = [0, 8, 16, 24];
      var RC = [
        1,
        0,
        32898,
        0,
        32906,
        2147483648,
        2147516416,
        2147483648,
        32907,
        0,
        2147483649,
        0,
        2147516545,
        2147483648,
        32777,
        2147483648,
        138,
        0,
        136,
        0,
        2147516425,
        0,
        2147483658,
        0,
        2147516555,
        0,
        139,
        2147483648,
        32905,
        2147483648,
        32771,
        2147483648,
        32770,
        2147483648,
        128,
        2147483648,
        32778,
        0,
        2147483658,
        2147483648,
        2147516545,
        2147483648,
        32896,
        2147483648,
        2147483649,
        0,
        2147516424,
        2147483648
      ];
      var BITS = [224, 256, 384, 512];
      var SHAKE_BITS = [128, 256];
      var OUTPUT_TYPES = ["hex", "buffer", "arrayBuffer", "array", "digest"];
      var CSHAKE_BYTEPAD = {
        "128": 168,
        "256": 136
      };
      var isArray = root.JS_SHA3_NO_NODE_JS || !Array.isArray ? function(obj) {
        return Object.prototype.toString.call(obj) === "[object Array]";
      } : Array.isArray;
      var isView = ARRAY_BUFFER && (root.JS_SHA3_NO_ARRAY_BUFFER_IS_VIEW || !ArrayBuffer.isView) ? function(obj) {
        return typeof obj === "object" && obj.buffer && obj.buffer.constructor === ArrayBuffer;
      } : ArrayBuffer.isView;
      var formatMessage = function(message) {
        var type = typeof message;
        if (type === "string") {
          return [message, true];
        }
        if (type !== "object" || message === null) {
          throw new Error(INPUT_ERROR);
        }
        if (ARRAY_BUFFER && message.constructor === ArrayBuffer) {
          return [new Uint8Array(message), false];
        }
        if (!isArray(message) && !isView(message)) {
          throw new Error(INPUT_ERROR);
        }
        return [message, false];
      };
      var empty = function(message) {
        return formatMessage(message)[0].length === 0;
      };
      var cloneArray = function(array) {
        var newArray = [];
        for (var i2 = 0; i2 < array.length; ++i2) {
          newArray[i2] = array[i2];
        }
        return newArray;
      };
      var createOutputMethod = function(bits2, padding, outputType) {
        return function(message) {
          return new Keccak(bits2, padding, bits2).update(message)[outputType]();
        };
      };
      var createShakeOutputMethod = function(bits2, padding, outputType) {
        return function(message, outputBits) {
          return new Keccak(bits2, padding, outputBits).update(message)[outputType]();
        };
      };
      var createCshakeOutputMethod = function(bits2, padding, outputType) {
        return function(message, outputBits, n, s) {
          return methods["cshake" + bits2].update(message, outputBits, n, s)[outputType]();
        };
      };
      var createKmacOutputMethod = function(bits2, padding, xof, outputType) {
        return function(key, message, outputBits, s) {
          return methods[(xof ? "kmacxof" : "kmac") + bits2].update(key, message, outputBits, s)[outputType]();
        };
      };
      var createTupleHashOutputMethod = function(bits2, padding, xof, outputType) {
        return function(inputs, outputBits, s) {
          return methods[(xof ? "tuplehashxof" : "tuplehash") + bits2].update(inputs, outputBits, s)[outputType]();
        };
      };
      var createParallelHashOutputMethod = function(bits2, padding, xof, outputType) {
        return function(message, blockSize, outputBits, s) {
          return methods[(xof ? "parallelhashxof" : "parallelhash") + bits2].update(message, blockSize, outputBits, s)[outputType]();
        };
      };
      var createOutputMethods = function(method, createMethod2, bits2, padding) {
        for (var i2 = 0; i2 < OUTPUT_TYPES.length; ++i2) {
          var type = OUTPUT_TYPES[i2];
          method[type] = createMethod2(bits2, padding, type);
        }
        return method;
      };
      var createMethod = function(bits2, padding) {
        var method = createOutputMethod(bits2, padding, "hex");
        method.create = function() {
          return new Keccak(bits2, padding, bits2);
        };
        method.update = function(message) {
          return method.create().update(message);
        };
        return createOutputMethods(method, createOutputMethod, bits2, padding);
      };
      var createShakeMethod = function(bits2, padding) {
        var method = createShakeOutputMethod(bits2, padding, "hex");
        method.create = function(outputBits) {
          return new Keccak(bits2, padding, outputBits);
        };
        method.update = function(message, outputBits) {
          return method.create(outputBits).update(message);
        };
        return createOutputMethods(method, createShakeOutputMethod, bits2, padding);
      };
      var createCshakeMethod = function(bits2, padding) {
        var w = CSHAKE_BYTEPAD[bits2];
        var method = createCshakeOutputMethod(bits2, padding, "hex");
        method.create = function(outputBits, n, s) {
          if (empty(n) && empty(s)) {
            return methods["shake" + bits2].create(outputBits);
          } else {
            return new Keccak(bits2, padding, outputBits).bytepad([n, s], w);
          }
        };
        method.update = function(message, outputBits, n, s) {
          return method.create(outputBits, n, s).update(message);
        };
        return createOutputMethods(method, createCshakeOutputMethod, bits2, padding);
      };
      var createKmacMethod = function(bits2, padding, xof) {
        var w = CSHAKE_BYTEPAD[bits2];
        var method = createKmacOutputMethod(bits2, padding, xof, "hex");
        method.create = function(key, outputBits, s) {
          return new Kmac(bits2, padding, outputBits, xof).bytepad(["KMAC", s], w).bytepad([key], w);
        };
        method.update = function(key, message, outputBits, s) {
          return method.create(key, outputBits, s).update(message);
        };
        return createOutputMethods(method, function(b, p, outputType) {
          return createKmacOutputMethod(b, p, xof, outputType);
        }, bits2, padding);
      };
      var createTupleHashMethod = function(bits2, padding, xof) {
        var w = CSHAKE_BYTEPAD[bits2];
        var method = createTupleHashOutputMethod(bits2, padding, xof, "hex");
        method.create = function(outputBits, s) {
          return new TupleHash(bits2, padding, outputBits, xof).bytepad(["TupleHash", s], w);
        };
        method.update = function(inputs, outputBits, s) {
          if (!isArray(inputs)) {
            throw new Error(INPUT_ERROR);
          }
          var hash = method.create(outputBits, s);
          for (var i2 = 0; i2 < inputs.length; ++i2) {
            hash.update(inputs[i2]);
          }
          return hash;
        };
        return createOutputMethods(method, function(b, p, outputType) {
          return createTupleHashOutputMethod(b, p, xof, outputType);
        }, bits2, padding);
      };
      var createParallelHashMethod = function(bits2, padding, xof) {
        var w = CSHAKE_BYTEPAD[bits2];
        var method = createParallelHashOutputMethod(bits2, padding, xof, "hex");
        method.create = function(blockSize, outputBits, s) {
          if (typeof blockSize !== "number" || !isFinite(blockSize) || blockSize < 1 || Math.floor(blockSize) !== blockSize || blockSize > 268435455) {
            throw new Error(BLOCK_SIZE_ERROR);
          }
          var hash = new ParallelHash(bits2, padding, outputBits, xof, blockSize).bytepad(["ParallelHash", s], w);
          hash.encode(blockSize, false);
          return hash;
        };
        method.update = function(message, blockSize, outputBits, s) {
          return method.create(blockSize, outputBits, s).update(message);
        };
        return createOutputMethods(method, function(b, p, outputType) {
          return createParallelHashOutputMethod(b, p, xof, outputType);
        }, bits2, padding);
      };
      var algorithms = [
        { name: "keccak", padding: KECCAK_PADDING, bits: BITS, createMethod },
        { name: "sha3", padding: PADDING, bits: BITS, createMethod },
        { name: "shake", padding: SHAKE_PADDING, bits: SHAKE_BITS, createMethod: createShakeMethod },
        { name: "cshake", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: createCshakeMethod },
        { name: "kmac", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createKmacMethod(bits2, padding, false);
        } },
        { name: "kmacxof", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createKmacMethod(bits2, padding, true);
        } },
        { name: "tuplehash", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createTupleHashMethod(bits2, padding, false);
        } },
        { name: "tuplehashxof", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createTupleHashMethod(bits2, padding, true);
        } },
        { name: "parallelhash", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createParallelHashMethod(bits2, padding, false);
        } },
        { name: "parallelhashxof", padding: CSHAKE_PADDING, bits: SHAKE_BITS, createMethod: function(bits2, padding) {
          return createParallelHashMethod(bits2, padding, true);
        } }
      ];
      var methods = {}, methodNames = [];
      for (var i = 0; i < algorithms.length; ++i) {
        var algorithm = algorithms[i];
        var bits = algorithm.bits;
        for (var j = 0; j < bits.length; ++j) {
          var methodName = algorithm.name + "_" + bits[j];
          methodNames.push(methodName);
          methods[methodName] = algorithm.createMethod(bits[j], algorithm.padding);
          if (algorithm.name !== "sha3") {
            var newMethodName = algorithm.name + bits[j];
            methodNames.push(newMethodName);
            methods[newMethodName] = methods[methodName];
          }
        }
      }
      function Keccak(bits2, padding, outputBits) {
        this.blocks = [];
        this.s = [];
        this.padding = padding;
        this.outputBits = outputBits;
        this.reset = true;
        this.finalized = false;
        this.block = 0;
        this.start = 0;
        this.blockCount = 1600 - (bits2 << 1) >> 5;
        this.byteCount = this.blockCount << 2;
        this.outputBlocks = outputBits >> 5;
        this.extraBytes = (outputBits & 31) >> 3;
        for (var i2 = 0; i2 < 50; ++i2) {
          this.s[i2] = 0;
        }
      }
      Keccak.prototype.update = function(message) {
        if (this.finalized) {
          throw new Error(FINALIZE_ERROR);
        }
        var result = formatMessage(message);
        message = result[0];
        var isString = result[1];
        var blocks = this.blocks, byteCount = this.byteCount, length = message.length, blockCount = this.blockCount, index = 0, s = this.s, i2, code;
        while (index < length) {
          if (this.reset) {
            this.reset = false;
            blocks[0] = this.block;
            for (i2 = 1; i2 < blockCount + 1; ++i2) {
              blocks[i2] = 0;
            }
          }
          if (isString) {
            for (i2 = this.start; index < length && i2 < byteCount; ++index) {
              code = message.charCodeAt(index);
              if (code < 128) {
                blocks[i2 >> 2] |= code << SHIFT[i2++ & 3];
              } else if (code < 2048) {
                blocks[i2 >> 2] |= (192 | code >> 6) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code & 63) << SHIFT[i2++ & 3];
              } else if (code < 55296 || code >= 57344) {
                blocks[i2 >> 2] |= (224 | code >> 12) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code >> 6 & 63) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code & 63) << SHIFT[i2++ & 3];
              } else {
                code = 65536 + ((code & 1023) << 10 | message.charCodeAt(++index) & 1023);
                blocks[i2 >> 2] |= (240 | code >> 18) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code >> 12 & 63) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code >> 6 & 63) << SHIFT[i2++ & 3];
                blocks[i2 >> 2] |= (128 | code & 63) << SHIFT[i2++ & 3];
              }
            }
          } else {
            for (i2 = this.start; index < length && i2 < byteCount; ++index) {
              blocks[i2 >> 2] |= message[index] << SHIFT[i2++ & 3];
            }
          }
          this.lastByteIndex = i2;
          if (i2 >= byteCount) {
            this.start = i2 - byteCount;
            this.block = blocks[blockCount];
            for (i2 = 0; i2 < blockCount; ++i2) {
              s[i2] ^= blocks[i2];
            }
            f(s);
            this.reset = true;
          } else {
            this.start = i2;
          }
        }
        return this;
      };
      Keccak.prototype.encode = function(x, right) {
        var o = x & 255, n = 1;
        var bytes = [o];
        x = x >> 8;
        o = x & 255;
        while (o > 0) {
          bytes.unshift(o);
          x = x >> 8;
          o = x & 255;
          ++n;
        }
        if (right) {
          bytes.push(n);
        } else {
          bytes.unshift(n);
        }
        Keccak.prototype.update.call(this, bytes);
        return bytes.length;
      };
      Keccak.prototype.encodeString = function(str) {
        var result = formatMessage(str);
        str = result[0];
        var isString = result[1];
        var bytes = 0, length = str.length;
        if (isString) {
          for (var i2 = 0; i2 < str.length; ++i2) {
            var code = str.charCodeAt(i2);
            if (code < 128) {
              bytes += 1;
            } else if (code < 2048) {
              bytes += 2;
            } else if (code < 55296 || code >= 57344) {
              bytes += 3;
            } else {
              code = 65536 + ((code & 1023) << 10 | str.charCodeAt(++i2) & 1023);
              bytes += 4;
            }
          }
        } else {
          bytes = length;
        }
        bytes += this.encode(bytes * 8);
        Keccak.prototype.update.call(this, str);
        return bytes;
      };
      Keccak.prototype.bytepad = function(strs, w) {
        var bytes = this.encode(w);
        for (var i2 = 0; i2 < strs.length; ++i2) {
          bytes += this.encodeString(strs[i2]);
        }
        var paddingBytes = (w - bytes % w) % w;
        var zeros = [];
        zeros.length = paddingBytes;
        Keccak.prototype.update.call(this, zeros);
        return this;
      };
      Keccak.prototype.finalize = function() {
        if (this.finalized) {
          return;
        }
        this.finalized = true;
        var blocks = this.blocks, i2 = this.lastByteIndex, blockCount = this.blockCount, s = this.s;
        blocks[i2 >> 2] |= this.padding[i2 & 3];
        if (this.lastByteIndex === this.byteCount) {
          blocks[0] = blocks[blockCount];
          for (i2 = 1; i2 < blockCount + 1; ++i2) {
            blocks[i2] = 0;
          }
        }
        blocks[blockCount - 1] |= 2147483648;
        for (i2 = 0; i2 < blockCount; ++i2) {
          s[i2] ^= blocks[i2];
        }
        f(s);
      };
      Keccak.prototype.toString = Keccak.prototype.hex = function() {
        this.finalize();
        var blockCount = this.blockCount, s = this.s, outputBlocks = this.outputBlocks, extraBytes = this.extraBytes, i2 = 0, j2 = 0;
        var hex = "", block;
        while (j2 < outputBlocks) {
          for (i2 = 0; i2 < blockCount && j2 < outputBlocks; ++i2, ++j2) {
            block = s[i2];
            hex += HEX_CHARS[block >> 4 & 15] + HEX_CHARS[block & 15] + HEX_CHARS[block >> 12 & 15] + HEX_CHARS[block >> 8 & 15] + HEX_CHARS[block >> 20 & 15] + HEX_CHARS[block >> 16 & 15] + HEX_CHARS[block >> 28 & 15] + HEX_CHARS[block >> 24 & 15];
          }
          if (j2 % blockCount === 0) {
            s = cloneArray(s);
            f(s);
            i2 = 0;
          }
        }
        if (extraBytes) {
          block = s[i2];
          hex += HEX_CHARS[block >> 4 & 15] + HEX_CHARS[block & 15];
          if (extraBytes > 1) {
            hex += HEX_CHARS[block >> 12 & 15] + HEX_CHARS[block >> 8 & 15];
          }
          if (extraBytes > 2) {
            hex += HEX_CHARS[block >> 20 & 15] + HEX_CHARS[block >> 16 & 15];
          }
        }
        return hex;
      };
      Keccak.prototype.arrayBuffer = function() {
        this.finalize();
        var blockCount = this.blockCount, s = this.s, outputBlocks = this.outputBlocks, extraBytes = this.extraBytes, i2 = 0, j2 = 0;
        var bytes = this.outputBits >> 3;
        var buffer;
        if (extraBytes) {
          buffer = new ArrayBuffer(outputBlocks + 1 << 2);
        } else {
          buffer = new ArrayBuffer(bytes);
        }
        var array = new Uint32Array(buffer);
        while (j2 < outputBlocks) {
          for (i2 = 0; i2 < blockCount && j2 < outputBlocks; ++i2, ++j2) {
            array[j2] = s[i2];
          }
          if (j2 % blockCount === 0) {
            s = cloneArray(s);
            f(s);
          }
        }
        if (extraBytes) {
          array[j2] = s[i2];
          buffer = buffer.slice(0, bytes);
        }
        return buffer;
      };
      Keccak.prototype.buffer = Keccak.prototype.arrayBuffer;
      Keccak.prototype.digest = Keccak.prototype.array = function() {
        this.finalize();
        var blockCount = this.blockCount, s = this.s, outputBlocks = this.outputBlocks, extraBytes = this.extraBytes, i2 = 0, j2 = 0;
        var array = [], offset, block;
        while (j2 < outputBlocks) {
          for (i2 = 0; i2 < blockCount && j2 < outputBlocks; ++i2, ++j2) {
            offset = j2 << 2;
            block = s[i2];
            array[offset] = block & 255;
            array[offset + 1] = block >> 8 & 255;
            array[offset + 2] = block >> 16 & 255;
            array[offset + 3] = block >> 24 & 255;
          }
          if (j2 % blockCount === 0) {
            s = cloneArray(s);
            f(s);
          }
        }
        if (extraBytes) {
          offset = j2 << 2;
          block = s[i2];
          array[offset] = block & 255;
          if (extraBytes > 1) {
            array[offset + 1] = block >> 8 & 255;
          }
          if (extraBytes > 2) {
            array[offset + 2] = block >> 16 & 255;
          }
        }
        return array;
      };
      function Kmac(bits2, padding, outputBits, xof) {
        Keccak.call(this, bits2, padding, outputBits);
        this.xof = xof;
      }
      Kmac.prototype = new Keccak();
      Kmac.prototype.finalize = function() {
        if (!this.finalized) {
          this.encode(this.xof ? 0 : this.outputBits, true);
        }
        return Keccak.prototype.finalize.call(this);
      };
      function TupleHash(bits2, padding, outputBits, xof) {
        Kmac.call(this, bits2, padding, outputBits, xof);
        this.inputActive = false;
        this.inputBytesRemaining = 0;
      }
      TupleHash.prototype = new Kmac();
      TupleHash.prototype.getMessageByteLength = function(message) {
        var result = formatMessage(message);
        message = result[0];
        if (!result[1]) {
          return message.length;
        }
        var bytes = 0;
        for (var i2 = 0; i2 < message.length; ++i2) {
          var code = message.charCodeAt(i2);
          if (code < 128) {
            bytes += 1;
          } else if (code < 2048) {
            bytes += 2;
          } else if (code < 55296 || code >= 57344) {
            bytes += 3;
          } else {
            ++i2;
            bytes += 4;
          }
        }
        return bytes;
      };
      TupleHash.prototype.beginInput = function(byteLength) {
        if (this.inputActive) {
          throw new Error(TUPLE_INCOMPLETE_ERROR);
        }
        if (typeof byteLength !== "number" || !isFinite(byteLength) || byteLength < 0 || Math.floor(byteLength) !== byteLength || byteLength > 268435455) {
          throw new Error(TUPLE_BYTE_LENGTH_ERROR);
        }
        this.encode(byteLength * 8, false);
        if (byteLength !== 0) {
          this.inputActive = true;
          this.inputBytesRemaining = byteLength;
        }
        return this;
      };
      TupleHash.prototype._updateChunk = function(message, byteLength) {
        Kmac.prototype.update.call(this, message);
        this.inputBytesRemaining -= byteLength;
        if (this.inputBytesRemaining === 0) {
          this.inputActive = false;
        }
        return this;
      };
      TupleHash.prototype.updateChunk = function(message) {
        if (!this.inputActive) {
          throw new Error(TUPLE_ACTIVE_ERROR);
        }
        var byteLength = this.getMessageByteLength(message);
        if (byteLength > this.inputBytesRemaining) {
          throw new Error(TUPLE_LENGTH_ERROR);
        }
        return this._updateChunk(message, byteLength);
      };
      TupleHash.prototype.update = function(message) {
        var byteLength = this.getMessageByteLength(message);
        this.beginInput(byteLength);
        return this._updateChunk(message, byteLength);
      };
      TupleHash.prototype.finalize = function() {
        if (this.inputActive) {
          throw new Error(TUPLE_INCOMPLETE_ERROR);
        }
        return Kmac.prototype.finalize.call(this);
      };
      function ParallelHash(bits2, padding, outputBits, xof, blockSize) {
        Kmac.call(this, bits2, padding, outputBits, xof);
        this.bits = bits2;
        this.blockSize = blockSize;
        this.inner = null;
        this.innerBytes = 0;
        this.blockNumber = 0;
      }
      ParallelHash.prototype = new Kmac();
      ParallelHash.prototype._finishInner = function() {
        Kmac.prototype.update.call(this, this.inner.array());
        this.inner = null;
        this.innerBytes = 0;
        ++this.blockNumber;
      };
      ParallelHash.prototype._updateBytes = function(message) {
        var length = message.length;
        if (!length) {
          return;
        }
        var slice = message.subarray || message.slice;
        var blockSize = this.blockSize;
        var index = 0;
        while (index < length) {
          if (!this.inner) {
            this.inner = new Keccak(this.bits, SHAKE_PADDING, this.bits << 1);
          }
          var take = blockSize - this.innerBytes;
          if (length - index < take) {
            take = length - index;
          }
          this.inner.update(slice.call(message, index, index + take));
          this.innerBytes += take;
          index += take;
          if (this.innerBytes === blockSize) {
            this._finishInner();
          }
        }
      };
      ParallelHash.prototype.update = function(message) {
        if (this.finalized) {
          throw new Error(FINALIZE_ERROR);
        }
        var result = formatMessage(message);
        message = result[0];
        if (result[1]) {
          var bytes = [], length = message.length, index = 0, code, i2;
          for (i2 = 0; i2 < length; ++i2) {
            code = message.charCodeAt(i2);
            if (code < 128) {
              bytes[index++] = code;
            } else if (code < 2048) {
              bytes[index++] = 192 | code >>> 6;
              bytes[index++] = 128 | code & 63;
            } else if (code < 55296 || code >= 57344) {
              bytes[index++] = 224 | code >>> 12;
              bytes[index++] = 128 | code >>> 6 & 63;
              bytes[index++] = 128 | code & 63;
            } else {
              code = 65536 + ((code & 1023) << 10 | message.charCodeAt(++i2) & 1023);
              bytes[index++] = 240 | code >>> 18;
              bytes[index++] = 128 | code >>> 12 & 63;
              bytes[index++] = 128 | code >>> 6 & 63;
              bytes[index++] = 128 | code & 63;
            }
          }
          message = bytes;
        }
        this._updateBytes(message);
        return this;
      };
      ParallelHash.prototype.finalize = function() {
        if (!this.finalized) {
          if (this.inner) {
            this._finishInner();
          }
          this.encode(this.blockNumber, true);
        }
        return Kmac.prototype.finalize.call(this);
      };
      var f = function(s) {
        var h, l, n, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17, b18, b19, b20, b21, b22, b23, b24, b25, b26, b27, b28, b29, b30, b31, b32, b33, b34, b35, b36, b37, b38, b39, b40, b41, b42, b43, b44, b45, b46, b47, b48, b49;
        for (n = 0; n < 48; n += 2) {
          c0 = s[0] ^ s[10] ^ s[20] ^ s[30] ^ s[40];
          c1 = s[1] ^ s[11] ^ s[21] ^ s[31] ^ s[41];
          c2 = s[2] ^ s[12] ^ s[22] ^ s[32] ^ s[42];
          c3 = s[3] ^ s[13] ^ s[23] ^ s[33] ^ s[43];
          c4 = s[4] ^ s[14] ^ s[24] ^ s[34] ^ s[44];
          c5 = s[5] ^ s[15] ^ s[25] ^ s[35] ^ s[45];
          c6 = s[6] ^ s[16] ^ s[26] ^ s[36] ^ s[46];
          c7 = s[7] ^ s[17] ^ s[27] ^ s[37] ^ s[47];
          c8 = s[8] ^ s[18] ^ s[28] ^ s[38] ^ s[48];
          c9 = s[9] ^ s[19] ^ s[29] ^ s[39] ^ s[49];
          h = c8 ^ (c2 << 1 | c3 >>> 31);
          l = c9 ^ (c3 << 1 | c2 >>> 31);
          s[0] ^= h;
          s[1] ^= l;
          s[10] ^= h;
          s[11] ^= l;
          s[20] ^= h;
          s[21] ^= l;
          s[30] ^= h;
          s[31] ^= l;
          s[40] ^= h;
          s[41] ^= l;
          h = c0 ^ (c4 << 1 | c5 >>> 31);
          l = c1 ^ (c5 << 1 | c4 >>> 31);
          s[2] ^= h;
          s[3] ^= l;
          s[12] ^= h;
          s[13] ^= l;
          s[22] ^= h;
          s[23] ^= l;
          s[32] ^= h;
          s[33] ^= l;
          s[42] ^= h;
          s[43] ^= l;
          h = c2 ^ (c6 << 1 | c7 >>> 31);
          l = c3 ^ (c7 << 1 | c6 >>> 31);
          s[4] ^= h;
          s[5] ^= l;
          s[14] ^= h;
          s[15] ^= l;
          s[24] ^= h;
          s[25] ^= l;
          s[34] ^= h;
          s[35] ^= l;
          s[44] ^= h;
          s[45] ^= l;
          h = c4 ^ (c8 << 1 | c9 >>> 31);
          l = c5 ^ (c9 << 1 | c8 >>> 31);
          s[6] ^= h;
          s[7] ^= l;
          s[16] ^= h;
          s[17] ^= l;
          s[26] ^= h;
          s[27] ^= l;
          s[36] ^= h;
          s[37] ^= l;
          s[46] ^= h;
          s[47] ^= l;
          h = c6 ^ (c0 << 1 | c1 >>> 31);
          l = c7 ^ (c1 << 1 | c0 >>> 31);
          s[8] ^= h;
          s[9] ^= l;
          s[18] ^= h;
          s[19] ^= l;
          s[28] ^= h;
          s[29] ^= l;
          s[38] ^= h;
          s[39] ^= l;
          s[48] ^= h;
          s[49] ^= l;
          b0 = s[0];
          b1 = s[1];
          b32 = s[11] << 4 | s[10] >>> 28;
          b33 = s[10] << 4 | s[11] >>> 28;
          b14 = s[20] << 3 | s[21] >>> 29;
          b15 = s[21] << 3 | s[20] >>> 29;
          b46 = s[31] << 9 | s[30] >>> 23;
          b47 = s[30] << 9 | s[31] >>> 23;
          b28 = s[40] << 18 | s[41] >>> 14;
          b29 = s[41] << 18 | s[40] >>> 14;
          b20 = s[2] << 1 | s[3] >>> 31;
          b21 = s[3] << 1 | s[2] >>> 31;
          b2 = s[13] << 12 | s[12] >>> 20;
          b3 = s[12] << 12 | s[13] >>> 20;
          b34 = s[22] << 10 | s[23] >>> 22;
          b35 = s[23] << 10 | s[22] >>> 22;
          b16 = s[33] << 13 | s[32] >>> 19;
          b17 = s[32] << 13 | s[33] >>> 19;
          b48 = s[42] << 2 | s[43] >>> 30;
          b49 = s[43] << 2 | s[42] >>> 30;
          b40 = s[5] << 30 | s[4] >>> 2;
          b41 = s[4] << 30 | s[5] >>> 2;
          b22 = s[14] << 6 | s[15] >>> 26;
          b23 = s[15] << 6 | s[14] >>> 26;
          b4 = s[25] << 11 | s[24] >>> 21;
          b5 = s[24] << 11 | s[25] >>> 21;
          b36 = s[34] << 15 | s[35] >>> 17;
          b37 = s[35] << 15 | s[34] >>> 17;
          b18 = s[45] << 29 | s[44] >>> 3;
          b19 = s[44] << 29 | s[45] >>> 3;
          b10 = s[6] << 28 | s[7] >>> 4;
          b11 = s[7] << 28 | s[6] >>> 4;
          b42 = s[17] << 23 | s[16] >>> 9;
          b43 = s[16] << 23 | s[17] >>> 9;
          b24 = s[26] << 25 | s[27] >>> 7;
          b25 = s[27] << 25 | s[26] >>> 7;
          b6 = s[36] << 21 | s[37] >>> 11;
          b7 = s[37] << 21 | s[36] >>> 11;
          b38 = s[47] << 24 | s[46] >>> 8;
          b39 = s[46] << 24 | s[47] >>> 8;
          b30 = s[8] << 27 | s[9] >>> 5;
          b31 = s[9] << 27 | s[8] >>> 5;
          b12 = s[18] << 20 | s[19] >>> 12;
          b13 = s[19] << 20 | s[18] >>> 12;
          b44 = s[29] << 7 | s[28] >>> 25;
          b45 = s[28] << 7 | s[29] >>> 25;
          b26 = s[38] << 8 | s[39] >>> 24;
          b27 = s[39] << 8 | s[38] >>> 24;
          b8 = s[48] << 14 | s[49] >>> 18;
          b9 = s[49] << 14 | s[48] >>> 18;
          s[0] = b0 ^ ~b2 & b4;
          s[1] = b1 ^ ~b3 & b5;
          s[10] = b10 ^ ~b12 & b14;
          s[11] = b11 ^ ~b13 & b15;
          s[20] = b20 ^ ~b22 & b24;
          s[21] = b21 ^ ~b23 & b25;
          s[30] = b30 ^ ~b32 & b34;
          s[31] = b31 ^ ~b33 & b35;
          s[40] = b40 ^ ~b42 & b44;
          s[41] = b41 ^ ~b43 & b45;
          s[2] = b2 ^ ~b4 & b6;
          s[3] = b3 ^ ~b5 & b7;
          s[12] = b12 ^ ~b14 & b16;
          s[13] = b13 ^ ~b15 & b17;
          s[22] = b22 ^ ~b24 & b26;
          s[23] = b23 ^ ~b25 & b27;
          s[32] = b32 ^ ~b34 & b36;
          s[33] = b33 ^ ~b35 & b37;
          s[42] = b42 ^ ~b44 & b46;
          s[43] = b43 ^ ~b45 & b47;
          s[4] = b4 ^ ~b6 & b8;
          s[5] = b5 ^ ~b7 & b9;
          s[14] = b14 ^ ~b16 & b18;
          s[15] = b15 ^ ~b17 & b19;
          s[24] = b24 ^ ~b26 & b28;
          s[25] = b25 ^ ~b27 & b29;
          s[34] = b34 ^ ~b36 & b38;
          s[35] = b35 ^ ~b37 & b39;
          s[44] = b44 ^ ~b46 & b48;
          s[45] = b45 ^ ~b47 & b49;
          s[6] = b6 ^ ~b8 & b0;
          s[7] = b7 ^ ~b9 & b1;
          s[16] = b16 ^ ~b18 & b10;
          s[17] = b17 ^ ~b19 & b11;
          s[26] = b26 ^ ~b28 & b20;
          s[27] = b27 ^ ~b29 & b21;
          s[36] = b36 ^ ~b38 & b30;
          s[37] = b37 ^ ~b39 & b31;
          s[46] = b46 ^ ~b48 & b40;
          s[47] = b47 ^ ~b49 & b41;
          s[8] = b8 ^ ~b0 & b2;
          s[9] = b9 ^ ~b1 & b3;
          s[18] = b18 ^ ~b10 & b12;
          s[19] = b19 ^ ~b11 & b13;
          s[28] = b28 ^ ~b20 & b22;
          s[29] = b29 ^ ~b21 & b23;
          s[38] = b38 ^ ~b30 & b32;
          s[39] = b39 ^ ~b31 & b33;
          s[48] = b48 ^ ~b40 & b42;
          s[49] = b49 ^ ~b41 & b43;
          s[0] ^= RC[n];
          s[1] ^= RC[n + 1];
        }
      };
      if (COMMON_JS) {
        module.exports = methods;
      } else {
        for (i = 0; i < methodNames.length; ++i) {
          root[methodNames[i]] = methods[methodNames[i]];
        }
      }
    })();
  })(sha3$1);
  var sha3Exports = sha3$1.exports;
  var sha3 = /* @__PURE__ */ getDefaultExportFromCjs(sha3Exports);
  var {
    sha3_224,
    sha3_256,
    sha3_384,
    sha3_512,
    keccak_224,
    keccak_256,
    keccak_384,
    keccak_512,
    keccak224,
    keccak256,
    keccak384,
    keccak512,
    shake_128,
    shake_256,
    shake128,
    shake256,
    cshake_128,
    cshake_256,
    cshake128,
    cshake256,
    kmac_128,
    kmac_256,
    kmac128,
    kmac256,
    kmacxof_128,
    kmacxof_256,
    kmacxof128,
    kmacxof256,
    tuplehash_128,
    tuplehash_256,
    tuplehash128,
    tuplehash256,
    tuplehashxof_128,
    tuplehashxof_256,
    tuplehashxof128,
    tuplehashxof256,
    parallelhash_128,
    parallelhash_256,
    parallelhash128,
    parallelhash256,
    parallelhashxof_128,
    parallelhashxof_256,
    parallelhashxof128,
    parallelhashxof256
  } = sha3;

  // extension/core/prompt.ts
  function buildFollowUpPrompt(args) {
    const parts = [
      `You are answering a follow-up about a highlighted span from a ${args.siteName ?? "ChatGPT"} reply.`,
      "The user should not need the main chat; use only this context.",
      "",
      "## Highlighted span",
      args.quotedText.trim() || "(empty)",
      "",
      "## Surrounding message",
      args.surroundingContext.trim() || "(none)",
      "",
      "## Earlier conversation excerpt",
      args.conversationExcerpt.trim() || "(none)"
    ];
    if (args.priorTurns?.length) {
      parts.push(
        "",
        "## Earlier follow-ups in this thread",
        ...args.priorTurns.map(
          (t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text.trim()}`
        )
      );
    }
    parts.push("", "## Question", args.question.trim());
    return parts.join("\n");
  }

  // extension/core/sse-parse.ts
  function extractTextFromMessage(message) {
    if (!message || typeof message !== "object") return "";
    const content = message.content;
    if (!content || typeof content !== "object") return "";
    const parts = content.parts;
    if (!Array.isArray(parts)) return "";
    return parts.filter((p) => typeof p === "string").join("");
  }
  function parseConversationSseText(text) {
    let reply = "";
    let conversationId;
    let messageId;
    let topicId;
    let resumeToken;
    let lastPath = "";
    let lastOp = "append";
    let handedOff = false;
    const eventTypes = [];
    const applyAssistantMessage = (msg) => {
      if (msg?.author?.role !== "assistant") return;
      const chunk = extractTextFromMessage(msg);
      if (chunk) reply = chunk;
      if (msg.id) messageId = msg.id;
    };
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]" || payload === "v1") continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof event.type === "string") {
        eventTypes.push(event.type);
      }
      if (typeof event.conversation_id === "string") {
        conversationId = event.conversation_id;
      }
      if (event.type === "resume_conversation_token" || event.type === "stream_handoff") {
        handedOff = true;
        if (typeof event.conversation_id === "string") {
          conversationId = event.conversation_id;
        }
        if (event.type === "resume_conversation_token") {
          if (typeof event.token === "string") {
            resumeToken = event.token;
            const fromJwt = topicIdFromJwt(event.token);
            if (fromJwt) topicId = fromJwt;
          }
        }
        if (event.type === "stream_handoff" && Array.isArray(event.options)) {
          for (const opt of event.options) {
            if (!opt || typeof opt !== "object") continue;
            const o2 = opt;
            if ((o2.type === "subscribe_ws_topic" || o2.type === "resume_sse_endpoint") && typeof o2.topic_id === "string") {
              topicId = o2.topic_id;
              break;
            }
          }
        }
        continue;
      }
      if (typeof event.type === "string") {
        continue;
      }
      if (event.message && typeof event.message === "object") {
        applyAssistantMessage(
          event.message
        );
      }
      const v = event.v;
      const p = typeof event.p === "string" ? event.p : void 0;
      const o = typeof event.o === "string" ? event.o : void 0;
      if (p !== void 0) lastPath = p;
      if (o !== void 0) lastOp = o;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = v;
        if (typeof nested.conversation_id === "string") {
          conversationId = nested.conversation_id;
        }
        if (nested.message) applyAssistantMessage(nested.message);
      }
      if (typeof v === "string") {
        const path = p ?? lastPath;
        const op = o ?? lastOp;
        const isParts = !path || path.includes("/parts/") || path.endsWith("/parts/0");
        if (isParts) {
          if (op === "append" || !o && !p) reply += v;
          else if (op === "replace" || op === "add") reply = v;
        }
      }
      if (o === "patch" && Array.isArray(v)) {
        for (const sub of v) {
          if (!sub || typeof sub !== "object") continue;
          const sp = sub;
          if (typeof sp.v === "string" && (sp.p || "").includes("parts")) {
            if (sp.o === "append") reply += sp.v;
            else if (sp.o === "replace" || sp.o === "add") reply = sp.v;
          }
          if (sp.v && typeof sp.v === "object" && sp.v.message) {
            applyAssistantMessage(
              sp.v.message
            );
          }
        }
      }
    }
    if (!conversationId) {
      const match = text.match(/"conversation_id"\s*:\s*"([a-f0-9-]{10,})"/i);
      if (match?.[1]) conversationId = match[1];
    }
    if (!topicId) {
      const match = text.match(
        /"topic_id"\s*:\s*"(conversation-turn-[a-f0-9-]+)"/i
      );
      if (match?.[1]) topicId = match[1];
    }
    return {
      reply,
      conversationId,
      messageId,
      topicId,
      resumeToken,
      handedOff: handedOff && !reply.trim(),
      eventTypes
    };
  }
  function topicIdFromJwt(token) {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return void 0;
      const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(json);
      return typeof payload.turn_topic_id === "string" ? payload.turn_topic_id : void 0;
    } catch {
      return void 0;
    }
  }

  // extension/background/chatgpt-session.ts
  var log3 = createLogger("chatgpt-session");
  var REQUIREMENTS_URL = "https://chatgpt.com/backend-api/sentinel/chat-requirements";
  var CONVERSATION_URLS = [
    "https://chatgpt.com/backend-api/f/conversation",
    "https://chatgpt.com/backend-api/conversation"
  ];
  var MODELS_URL = "https://chatgpt.com/backend-api/models";
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  function bytesFromHex(hex) {
    const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  function utf8(s) {
    return new TextEncoder().encode(s);
  }
  function concatBytes(...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  function compact(arr, start = 0, end = arr.length) {
    return JSON.stringify(arr.slice(start, end)).slice(1, -1);
  }
  function browserLanguage() {
    return typeof navigator !== "undefined" && navigator.language || "en-US";
  }
  function buildConfig(userAgent) {
    const perf = typeof performance !== "undefined" && performance.now ? performance.now() : Math.random() * 1e3;
    const screenSum = typeof screen !== "undefined" && screen.width ? screen.width + screen.height : 1920 + 1080;
    const language = browserLanguage();
    const languages = typeof navigator !== "undefined" && navigator.languages?.length ? navigator.languages.join(",") : language;
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency || 8;
    return [
      screenSum,
      (/* @__PURE__ */ new Date()).toString(),
      4294705152,
      0,
      userAgent,
      "",
      "",
      language,
      languages,
      0,
      "webdriver\u2212false",
      "location",
      "window",
      perf,
      uuid(),
      "",
      cores,
      Date.now() - perf
    ];
  }
  function generateAnswer(seed, diff, config) {
    const target = bytesFromHex(diff);
    const seedEncoded = utf8(seed);
    const part1 = utf8(`[${compact(config, 0, 3)},`);
    const part2 = utf8(`,${compact(config, 4, 9)},`);
    const part3 = utf8(`,${compact(config, 10)}]`);
    for (let i = 0; i < 5e5; i++) {
      const finalBytes = concatBytes(
        part1,
        utf8(String(i)),
        part2,
        utf8(String(i >> 1)),
        part3
      );
      const baseEncoded = toBase64(finalBytes);
      const digest = new Uint8Array(
        sha3_512.array(concatBytes(seedEncoded, utf8(baseEncoded)))
      );
      if (compareBytes(digest.subarray(0, target.length), target) <= 0) {
        return [baseEncoded, true];
      }
    }
    const fallback = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + toBase64(utf8(`"${seed}"`));
    return [fallback, false];
  }
  function solvePow(seed, difficulty, userAgent) {
    const config = buildConfig(userAgent);
    const [answer] = generateAnswer(seed, difficulty, config);
    return `gAAAAAB${answer}`;
  }
  function getRequirementsToken(userAgent) {
    const config = buildConfig(userAgent);
    const [require2] = generateAnswer(String(Math.random()), "0fffff", config);
    return `gAAAAAC${require2}`;
  }
  async function fetchSentinelTokens(accessToken, userAgent) {
    const p = getRequirementsToken(userAgent);
    const res = await fetch(REQUIREMENTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": userAgent
      },
      body: JSON.stringify({ p })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log3.error(
        `chat-requirements failed: HTTP ${res.status}`,
        body.slice(0, 300)
      );
      throw new Error(
        `ChatGPT session gate failed (chat-requirements HTTP ${res.status}). Reload chatgpt.com and try again.`
      );
    }
    const data = await res.json();
    if (!data.token) {
      log3.error(`chat-requirements response missing token`);
      throw new Error("ChatGPT session gate returned no token.");
    }
    const out = {
      chatRequirements: data.token
    };
    const pow = data.proofofwork;
    if (pow?.required) {
      if (!pow.seed || !pow.difficulty) {
        throw new Error("ChatGPT proof-of-work challenge missing seed/difficulty.");
      }
      out.proof = solvePow(pow.seed, pow.difficulty, userAgent);
    }
    return out;
  }
  async function resolveModel(accessToken, userAgent) {
    try {
      const res = await fetch(MODELS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": userAgent
        }
      });
      if (!res.ok) {
        log3.warn(`models fetch HTTP ${res.status}; using auto`);
        return "auto";
      }
      const data = await res.json();
      const slug = data.models?.[0]?.slug;
      if (slug) {
        log3.debug(`Using model "${slug}"`);
        return slug;
      }
    } catch (err) {
      log3.warn(`models fetch failed; using auto`, err);
    }
    log3.debug(`Using model "auto"`);
    return "auto";
  }
  async function getChatGptWebSocketUrl(accessToken, userAgent) {
    const res = await fetch("https://chatgpt.com/backend-api/celsius/ws/user", {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "User-Agent": userAgent
      }
    });
    if (!res.ok) {
      throw new Error(`celsius/ws/user HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.websocket_url) {
      throw new Error("celsius/ws/user returned no websocket_url");
    }
    return data.websocket_url;
  }
  function collectEncodedSseFromWsFrame(frame) {
    const out = [];
    if (!frame || typeof frame !== "object") return out;
    const f = frame;
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const obj = node;
      if (typeof obj.encoded_item === "string" && obj.encoded_item) {
        out.push(obj.encoded_item);
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") walk(value);
      }
    };
    if (f.type === "reply" && f.reply && typeof f.reply === "object") {
      const reply = f.reply;
      if (Array.isArray(reply.catchups)) {
        for (const cu of reply.catchups) walk(cu);
      }
    }
    walk(f);
    return out;
  }
  async function recoverViaWebSocket(accessToken, userAgent, topicId, onPartial, timeoutMs = 9e4) {
    const wsUrl = await getChatGptWebSocketUrl(accessToken, userAgent);
    let host = wsUrl;
    try {
      host = new URL(wsUrl).host;
    } catch {
    }
    log3.debug(
      `Opening handoff WebSocket host=${host} topic=${topicId}`
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let reply = "";
      let messageId;
      let conversationId;
      let sseBuffer = "";
      let cmdId = 4;
      let framesSeen = 0;
      let encodedSeen = 0;
      const emit = (text) => {
        if (!text.trim()) return;
        onPartial?.(cleanChatGptText(text));
      };
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
        }
        if (ok && reply.trim()) {
          log3.debug(
            `WebSocket recovered reply (${reply.length} chars, frames=${framesSeen}, encoded=${encodedSeen})`
          );
          resolve({ reply, messageId, conversationId });
        } else {
          reject(
            new Error(
              err || `WebSocket handoff produced no reply (frames=${framesSeen}, encoded=${encodedSeen})`
            )
          );
        }
      };
      const timer = setTimeout(() => {
        if (reply.trim()) {
          finish(true);
        } else {
          finish(
            false,
            `WebSocket handoff timed out (frames=${framesSeen}, encoded=${encodedSeen})`
          );
        }
      }, timeoutMs);
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        log3.debug(`WebSocket open \u2014 subscribing to ${topicId}`);
        ws.send(
          JSON.stringify([
            {
              id: 1,
              command: {
                type: "connect",
                presence: { type: "presence", state: "background" }
              }
            },
            { id: 2, command: { type: "subscribe", topic_id: "calpico-chatgpt" } },
            { id: 3, command: { type: "subscribe", topic_id: "conversations" } },
            {
              id: ++cmdId,
              command: { type: "subscribe", topic_id: topicId, offset: "0" }
            }
          ])
        );
      };
      ws.onerror = () => {
        log3.warn(`WebSocket error event`);
        finish(false, "WebSocket handoff connection error");
      };
      ws.onclose = (ev) => {
        log3.debug(
          `WebSocket closed code=${ev.code} reason=${ev.reason || "none"} frames=${framesSeen} encoded=${encodedSeen}`
        );
        if (!settled) {
          if (reply.trim()) finish(true);
          else {
            finish(
              false,
              `WebSocket closed before reply (code=${ev.code}, frames=${framesSeen}, encoded=${encodedSeen})`
            );
          }
        }
      };
      ws.onmessage = (ev) => {
        let frames = [];
        try {
          const parsed = JSON.parse(String(ev.data));
          frames = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          log3.warn(
            `WebSocket non-JSON frame len=${String(ev.data).length}`
          );
          return;
        }
        for (const frame of frames) {
          framesSeen += 1;
          const fType = frame && typeof frame === "object" ? String(frame.type || "unknown") : typeof frame;
          if (framesSeen <= 10) {
            log3.debug(`WS frame#${framesSeen} type=${fType}`);
          }
          const encodedChunks = collectEncodedSseFromWsFrame(frame);
          for (const encoded of encodedChunks) {
            encodedSeen += 1;
            sseBuffer += `${encoded}
`;
            const parsed = parseConversationSseText(sseBuffer);
            if (parsed.conversationId) conversationId = parsed.conversationId;
            if (parsed.messageId) messageId = parsed.messageId;
            if (parsed.reply) {
              reply = parsed.reply;
              emit(reply);
            }
            if ((encoded.includes("[DONE]") || parsed.eventTypes.includes("message_stream_complete")) && reply.trim()) {
              finish(true);
              return;
            }
          }
          const direct = extractAssistantFromUnknownFrame(frame);
          if (direct?.text) {
            if (direct.text.length >= reply.length) {
              reply = direct.text;
              emit(reply);
            }
            if (direct.messageId) messageId = direct.messageId;
            if (direct.finished && reply.trim()) {
              finish(true);
              return;
            }
          }
        }
      };
    });
  }
  function extractAssistantFromUnknownFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    const stack = [frame];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        stack.push(...cur);
        continue;
      }
      const obj = cur;
      if (obj.message && typeof obj.message === "object") {
        const msg = obj.message;
        if (msg.author?.role === "assistant") {
          const text = (() => {
            const content = msg.content;
            if (!content || typeof content !== "object") return "";
            const parts = content.parts;
            if (!Array.isArray(parts)) return "";
            return parts.filter((p) => typeof p === "string").join("");
          })();
          if (text.trim()) {
            return {
              text,
              messageId: msg.id,
              finished: msg.status === "finished_successfully" || msg.channel === "final"
            };
          }
        }
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }
  async function parseConversationStream(res, accessToken, userAgent, onPartial) {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      log3.error(`Unexpected JSON response (not SSE)`, data);
      throw new Error(
        typeof data?.detail === "string" ? data.detail : "ChatGPT returned JSON instead of a stream. Session may be blocked."
      );
    }
    const emit = (text2) => {
      if (!text2.trim()) return;
      onPartial?.(cleanChatGptText(text2));
    };
    let text = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lastEmitted = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const live = parseConversationSseText(text);
        if (live.reply && live.reply !== lastEmitted) {
          lastEmitted = live.reply;
          emit(live.reply);
        }
      }
      text += decoder.decode();
    } else {
      text = await res.text();
    }
    const parsed = parseConversationSseText(text);
    log3.debug(
      `SSE events=[${parsed.eventTypes.join(",") || "none"}] handedOff=${parsed.handedOff} replyLen=${parsed.reply.length} conversationId=${parsed.conversationId || "none"} topicId=${parsed.topicId || "none"}`
    );
    if (parsed.reply.trim()) {
      emit(parsed.reply);
      return {
        reply: parsed.reply,
        conversationId: parsed.conversationId,
        messageId: parsed.messageId
      };
    }
    if (!parsed.topicId) {
      log3.error(
        `Empty SSE with no topic to resume; head=${text.slice(0, 400)}`
      );
      throw new Error(
        "ChatGPT handed off the stream without a topic id. Reload and try again."
      );
    }
    log3.debug("Recovering handoff via websocket");
    try {
      const recovered = await recoverViaWebSocket(
        accessToken,
        userAgent,
        parsed.topicId,
        onPartial
      );
      log3.debug("Handoff recovered via websocket");
      emit(recovered.reply);
      return {
        reply: recovered.reply,
        conversationId: recovered.conversationId || parsed.conversationId,
        messageId: recovered.messageId || parsed.messageId
      };
    } catch (err) {
      throw new Error(
        `Handoff recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  async function postConversation(accessToken, userAgent, sentinel, prompt, model, sideConversationId, sideParentMessageId, onPartial) {
    const messageId = uuid();
    const parentMessageId = sideParentMessageId && sideParentMessageId.trim() || "client-created-root";
    const body = {
      action: "next",
      messages: [
        {
          id: messageId,
          author: { role: "user" },
          create_time: Date.now() / 1e3,
          content: { content_type: "text", parts: [prompt] },
          metadata: {}
        }
      ],
      parent_message_id: parentMessageId,
      model,
      timezone_offset_min: (/* @__PURE__ */ new Date()).getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      conversation_mode: { kind: "primary_assistant" },
      // Temporary so helper turns do NOT appear in ChatGPT's main history
      // (users were opening those and adding highlights to the wrong chat).
      // Handoff recovery uses the WebSocket topic; polling often cannot see temps.
      history_and_training_disabled: true,
      force_paragen: false,
      force_rate_limit: false,
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: {
        app_name: "chatgpt.com"
      }
    };
    if (sideConversationId) {
      body.conversation_id = sideConversationId;
    }
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": userAgent,
      "OAI-Language": browserLanguage(),
      "Openai-Sentinel-Chat-Requirements-Token": sentinel.chatRequirements
    };
    if (sentinel.proof) {
      headers["Openai-Sentinel-Proof-Token"] = sentinel.proof;
    }
    let lastError = "ChatGPT conversation request failed.";
    for (const url of CONVERSATION_URLS) {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log3.error(
          `conversation POST ${url} \u2192 HTTP ${res.status}`,
          errText.slice(0, 400)
        );
        lastError = `ChatGPT conversation failed (HTTP ${res.status}). Reload and re-login if needed.`;
        if (res.status === 401 || res.status === 403) {
          throw new Error(
            `ChatGPT session unavailable (HTTP ${res.status}). Reload chatgpt.com / re-login, then try again.`
          );
        }
        continue;
      }
      const parsed = await parseConversationStream(
        res,
        accessToken,
        userAgent,
        onPartial
      );
      return {
        reply: parsed.reply,
        conversationId: parsed.conversationId || sideConversationId || "",
        // Next turn's parent must be the assistant leaf — never the user message we just sent.
        parentMessageId: parsed.messageId || sideParentMessageId || "",
        model
      };
    }
    throw new Error(lastError);
  }
  async function completeViaChatGptSession(creds, req, onPartial) {
    try {
      const prompt = buildFollowUpPrompt({
        quotedText: req.quotedText,
        surroundingContext: req.surroundingContext,
        conversationExcerpt: req.conversationExcerpt,
        question: req.question
      });
      const sentinel = await fetchSentinelTokens(
        creds.accessToken,
        creds.userAgent
      );
      const model = await resolveModel(creds.accessToken, creds.userAgent);
      const result = await postConversation(
        creds.accessToken,
        creds.userAgent,
        sentinel,
        prompt,
        model,
        req.sideConversationId,
        req.sideParentMessageId,
        onPartial
      );
      if (!result.conversationId) {
        log3.warn(
          `Reply ok but conversation_id missing; follow-ups in this thread may start a new side chat.`
        );
      }
      return {
        ok: true,
        reply: cleanChatGptText(result.reply),
        sideConversationId: result.conversationId || void 0,
        sideParentMessageId: result.parentMessageId || void 0
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log3.error(`complete failed:`, message);
      return { ok: false, error: message };
    }
  }

  // extension/core/claude-parse.ts
  function createClaudeStreamState() {
    return { buffer: "", text: "", done: false };
  }
  function feedClaudeStream(state, chunk) {
    state.buffer = (state.buffer + chunk).replace(/\r\n/g, "\n");
    const before = state.text;
    let sep = state.buffer.indexOf("\n\n");
    while (sep >= 0) {
      const block = state.buffer.slice(0, sep);
      state.buffer = state.buffer.slice(sep + 2);
      handleBlock(state, block);
      sep = state.buffer.indexOf("\n\n");
    }
    return state.text !== before;
  }
  function finishClaudeStream(state) {
    if (state.buffer.trim()) handleBlock(state, state.buffer);
    state.buffer = "";
  }
  function handleBlock(state, block) {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case "message_start":
        state.assistantUuid = ev.message?.uuid ?? state.assistantUuid;
        break;
      case "content_block_start":
        if (ev.content_block?.type === "text") {
          if (state.text && !/\s$/.test(state.text)) state.text += "\n\n";
          state.textBlock = ev.index;
          if (ev.content_block.text) state.text += ev.content_block.text;
        }
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          state.text += ev.delta.text;
        }
        break;
      case "completion":
        if (ev.completion) state.text += ev.completion;
        break;
      case "message_stop":
        state.done = true;
        break;
      case "error":
        state.error = ev.error?.message || ev.error?.type || "Claude returned an error.";
        break;
    }
  }

  // extension/background/claude-session.ts
  var log4 = createLogger("claude-session");
  var API = "https://claude.ai/api";
  var SESSION_HELP = "Claude session unavailable \u2014 make sure you're logged in on claude.ai, then try again.";
  var cachedOrgId = null;
  var ClaudeHttpError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  };
  async function claudeFetch(path, init) {
    const res = await fetch(`${API}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers ?? {}
      }
    });
    if (res.ok) return res;
    const detail = await res.text().catch(() => "");
    log4.error(`${init?.method ?? "GET"} ${path} \u2192 HTTP ${res.status}`, detail.slice(0, 300));
    if (res.status === 401 || res.status === 403) {
      throw new ClaudeHttpError(SESSION_HELP, res.status);
    }
    if (res.status === 429) {
      throw new ClaudeHttpError(
        "Claude usage limit reached for now \u2014 try again later.",
        res.status
      );
    }
    throw new ClaudeHttpError(`Claude request failed (HTTP ${res.status}).`, res.status);
  }
  async function getOrgId() {
    if (cachedOrgId) return cachedOrgId;
    const orgs = await (await claudeFetch("/organizations")).json();
    const org = orgs.find((o) => o.capabilities?.includes("chat")) ?? orgs[0];
    if (!org?.uuid) throw new Error(SESSION_HELP);
    cachedOrgId = org.uuid;
    log4.debug(`Using organization ${org.uuid}`);
    return org.uuid;
  }
  async function createTemporaryConversation(orgId) {
    const uuid2 = crypto.randomUUID();
    const res = await claudeFetch(`/organizations/${orgId}/chat_conversations`, {
      method: "POST",
      body: JSON.stringify({ uuid: uuid2, name: "", is_temporary: true })
    });
    const conv = await res.json();
    if (conv.is_temporary === false) {
      log4.warn("Claude created a non-temporary conversation; it may appear in history.");
    }
    return conv.uuid ?? uuid2;
  }
  async function streamCompletion(orgId, conversationId, prompt, parentMessageUuid, onPartial) {
    const body = {
      prompt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      locale: navigator.language || "en-US",
      attachments: [],
      files: [],
      rendering_mode: "messages"
    };
    if (parentMessageUuid) body.parent_message_uuid = parentMessageUuid;
    const res = await claudeFetch(
      `/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: JSON.stringify(body)
      }
    );
    const state = createClaudeStreamState();
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (feedClaudeStream(state, decoder.decode(value, { stream: true }))) {
          onPartial?.(state.text);
        }
      }
      feedClaudeStream(state, decoder.decode());
    } else {
      feedClaudeStream(state, await res.text());
    }
    finishClaudeStream(state);
    if (state.error) throw new Error(`Claude: ${state.error}`);
    if (!state.text.trim()) throw new Error("Claude returned an empty reply.");
    log4.debug(`Reply received (${state.text.length} chars)`);
    return { reply: state.text, assistantUuid: state.assistantUuid };
  }
  async function completeViaClaudeSession(req, onPartial) {
    try {
      const orgId = req.sideMeta?.orgId || await getOrgId();
      const promptArgs = {
        quotedText: req.quotedText,
        surroundingContext: req.surroundingContext,
        conversationExcerpt: req.conversationExcerpt,
        question: req.question,
        siteName: "Claude"
      };
      if (req.sideConversationId && req.sideParentMessageId) {
        try {
          const r2 = await streamCompletion(
            orgId,
            req.sideConversationId,
            buildFollowUpPrompt(promptArgs),
            req.sideParentMessageId,
            onPartial
          );
          return {
            ok: true,
            reply: r2.reply,
            sideConversationId: req.sideConversationId,
            sideParentMessageId: r2.assistantUuid ?? req.sideParentMessageId,
            sideMeta: { orgId }
          };
        } catch (err) {
          if (err instanceof ClaudeHttpError && [401, 403, 429].includes(err.status)) {
            throw err;
          }
          log4.debug("Could not continue side chat; starting a fresh one", err);
        }
      }
      const conversationId = await createTemporaryConversation(orgId);
      const r = await streamCompletion(
        orgId,
        conversationId,
        buildFollowUpPrompt({ ...promptArgs, priorTurns: req.priorTurns }),
        void 0,
        onPartial
      );
      return {
        ok: true,
        reply: r.reply,
        sideConversationId: conversationId,
        sideParentMessageId: r.assistantUuid,
        sideMeta: { orgId }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log4.error("complete failed:", message);
      return { ok: false, error: message };
    }
  }

  // extension/core/gemini-parse.ts
  function createGeminiStreamState() {
    return { buffer: "", text: "" };
  }
  var ERROR_MESSAGES = {
    1013: "Gemini had a temporary error \u2014 try again.",
    1037: "Gemini usage limit reached for now \u2014 try again later.",
    1050: "Gemini rejected the model selection \u2014 reload gemini.google.com and try again.",
    1060: "Gemini temporarily blocked requests from this network \u2014 try again later."
  };
  function feedGeminiStream(state, chunk) {
    state.buffer += chunk;
    const before = state.text;
    let nl = state.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = state.buffer.slice(0, nl).trim();
      state.buffer = state.buffer.slice(nl + 1);
      if (line.startsWith("[")) handleLine(state, line);
      nl = state.buffer.indexOf("\n");
    }
    return state.text !== before;
  }
  function finishGeminiStream(state) {
    const line = state.buffer.trim();
    if (line.startsWith("[")) handleLine(state, line);
    state.buffer = "";
  }
  function handleLine(state, line) {
    let frames;
    try {
      frames = JSON.parse(line);
    } catch {
      return;
    }
    if (!Array.isArray(frames)) return;
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame[0] !== "wrb.fr") continue;
      if (typeof frame[2] !== "string") {
        const code = findErrorCode(frame[5]);
        if (code != null) {
          state.error = ERROR_MESSAGES[code] ?? `Gemini returned error code ${code}.`;
        }
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(frame[2]);
      } catch {
        continue;
      }
      if (!Array.isArray(payload)) continue;
      const ids = payload[1];
      if (Array.isArray(ids)) {
        if (typeof ids[0] === "string") state.conversationId = ids[0];
        if (typeof ids[1] === "string") state.responseId = ids[1];
      }
      const candidate = Array.isArray(payload[4]) ? payload[4][0] : null;
      if (Array.isArray(candidate)) {
        if (typeof candidate[0] === "string") state.candidateId = candidate[0];
        const text = Array.isArray(candidate[1]) ? candidate[1][0] : null;
        if (typeof text === "string" && text.length >= state.text.length) {
          state.text = text;
        }
      }
    }
  }
  function findErrorCode(node, depth = 0) {
    if (depth > 6 || !Array.isArray(node)) return null;
    for (const item of node) {
      if (typeof item === "number" && item >= 1e3 && item < 1e4) return item;
      const nested = findErrorCode(item, depth + 1);
      if (nested != null) return nested;
    }
    return null;
  }
  function cleanGeminiText(text) {
    return text.replace(/\[cite(?:_start|_end)?(?::[^\]]*)?\]/g, "").replace(/https?:\/\/googleusercontent\.com\/\S+/g, "").replace(/[^\S\n]+\n/g, "\n").trim();
  }

  // extension/background/gemini-session.ts
  var log5 = createLogger("gemini-session");
  var STREAM_PATH = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
  var TEMPORARY_CHAT_INDEX = 45;
  var INNER_LENGTH = 99;
  var UI_FIELDS = {
    6: [0],
    7: 1,
    10: 1,
    11: 0,
    17: [[0]],
    18: 0,
    27: 1,
    30: [4, 16],
    41: [2],
    49: 0,
    53: 0,
    61: [],
    68: 1,
    79: 1,
    80: 1,
    91: 0,
    96: 0,
    98: 1
  };
  var SESSION_HELP2 = "Gemini session unavailable \u2014 reload gemini.google.com (and sign in if needed), then try again.";
  function pickToken(source, key) {
    const match = source.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!match) return "";
    try {
      return JSON.parse(match[1]);
    } catch {
      return "";
    }
  }
  function tokensFrom(source, prefix) {
    const bl = pickToken(source, "cfb2h");
    if (!bl) return null;
    return {
      at: pickToken(source, "SNlM0e"),
      bl,
      sid: pickToken(source, "FdrFJe"),
      prefix
    };
  }
  async function getPageTokens(signal) {
    const prefix = location.pathname.match(/^\/u\/\d+/)?.[0] ?? "";
    for (const script of Array.from(document.scripts)) {
      const text = script.textContent ?? "";
      if (!text.includes("cfb2h")) continue;
      const tokens2 = tokensFrom(text, prefix);
      if (tokens2) return tokens2;
    }
    const res = await fetch(`${prefix}/app`, { credentials: "include", signal });
    const tokens = res.ok ? tokensFrom(await res.text(), prefix) : null;
    if (!tokens) throw new Error(SESSION_HELP2);
    return tokens;
  }
  async function streamGenerate(prompt, continuation, onPartial) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6e4);
    try {
      return await streamGenerateWithSignal(prompt, continuation, controller.signal, onPartial);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error("Gemini did not finish replying within 60 seconds. Reload Gemini and try again.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  async function streamGenerateWithSignal(prompt, continuation, signal, onPartial) {
    const tokens = await getPageTokens(signal);
    const lang = navigator.language || "en-US";
    const inner = new Array(INNER_LENGTH).fill(null);
    for (const [index, value] of Object.entries(UI_FIELDS)) {
      inner[Number(index)] = value;
    }
    inner[0] = [prompt, 0, null, null, null, null, 0];
    inner[1] = [lang];
    if (continuation) inner[2] = continuation;
    inner[TEMPORARY_CHAT_INDEX] = 1;
    inner[59] = crypto.randomUUID().toUpperCase();
    const body = new URLSearchParams({
      "f.req": JSON.stringify([null, JSON.stringify(inner)])
    });
    if (tokens.at) body.set("at", tokens.at);
    const query = new URLSearchParams({
      bl: tokens.bl,
      "f.sid": tokens.sid,
      hl: document.documentElement.lang || lang,
      _reqid: String(1e5 + Math.floor(Math.random() * 9e5)),
      rt: "c"
    });
    const res = await fetch(`${tokens.prefix}${STREAM_PATH}?${query}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        "X-Same-Domain": "1"
      },
      body,
      signal
    });
    if (!res.ok) {
      log5.error(`StreamGenerate \u2192 HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) throw new Error(SESSION_HELP2);
      if (res.status === 429) {
        throw new Error("Gemini usage limit reached for now \u2014 try again later.");
      }
      throw new Error(`Gemini request failed (HTTP ${res.status}).`);
    }
    const state = createGeminiStreamState();
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (feedGeminiStream(state, decoder.decode(value, { stream: true }))) {
          onPartial?.(cleanGeminiText(state.text));
        }
      }
      feedGeminiStream(state, decoder.decode());
    } else {
      feedGeminiStream(state, await res.text());
    }
    finishGeminiStream(state);
    if (state.error) throw new Error(state.error);
    const reply = cleanGeminiText(state.text);
    if (!reply) throw new Error("Gemini returned no readable reply. Its web request or response format may have changed; report this error with extension version 0.2.1.");
    log5.debug(`Reply received (${reply.length} chars)`);
    return {
      reply,
      conversationId: state.conversationId,
      responseId: state.responseId,
      candidateId: state.candidateId
    };
  }
  async function completeViaGeminiSession(req, onPartial) {
    try {
      const promptArgs = {
        quotedText: req.quotedText,
        surroundingContext: req.surroundingContext,
        conversationExcerpt: req.conversationExcerpt,
        question: req.question,
        siteName: "Gemini"
      };
      const toResponse = (r) => ({
        ok: true,
        reply: r.reply,
        sideConversationId: r.conversationId,
        sideParentMessageId: r.responseId,
        sideMeta: r.candidateId ? { candidateId: r.candidateId } : void 0
      });
      if (req.sideConversationId && req.sideParentMessageId) {
        const continuation = req.sideMeta?.candidateId ? [req.sideConversationId, req.sideParentMessageId, req.sideMeta.candidateId] : [req.sideConversationId, req.sideParentMessageId];
        try {
          return toResponse(
            await streamGenerate(buildFollowUpPrompt(promptArgs), continuation, onPartial)
          );
        } catch (err) {
          if (err instanceof Error && /within 60 seconds/.test(err.message)) throw err;
          log5.debug("Could not continue side chat; starting a fresh one", err);
        }
      }
      return toResponse(
        await streamGenerate(
          buildFollowUpPrompt({ ...promptArgs, priorTurns: req.priorTurns }),
          null,
          onPartial
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log5.error("complete failed:", message);
      return { ok: false, error: message };
    }
  }

  // extension/core/html.ts
  var policy;
  function getPolicy() {
    if (policy !== void 0) return policy;
    const tt = globalThis.trustedTypes;
    try {
      policy = tt ? tt.createPolicy("ai-helper", { createHTML: (s) => s }) : null;
    } catch {
      policy = null;
    }
    return policy;
  }
  function setHtml(target, html) {
    const p = getPolicy();
    target.innerHTML = p ? p.createHTML(html) : html;
  }

  // extension/core/input-guard.ts
  var SIDEBAR_HOST_ID = "ai-helper-sidebar-host";
  var SIDEBAR_KEY_EVENT = "ai-helper:composer-keydown";
  function installSidebarInputGuard() {
    const guard = (event) => {
      const path = event.composedPath();
      if (!path.some((node) => node instanceof HTMLElement && node.id === SIDEBAR_HOST_ID)) return;
      const target = path[0];
      if (!(target instanceof HTMLTextAreaElement)) return;
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        target.dispatchEvent(new CustomEvent(SIDEBAR_KEY_EVENT, { detail: event }));
      }
    };
    const types = ["keydown", "keypress", "keyup"];
    for (const type of types) window.addEventListener(type, guard, true);
    return () => {
      for (const type of types) window.removeEventListener(type, guard, true);
    };
  }

  // extension/core/sidebar.ts
  var log6 = createLogger("sidebar");
  var HOST_ID = SIDEBAR_HOST_ID;
  var COMPOSER_MAX_HEIGHT = 160;
  var FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  var STYLES = `
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
  font-family: ${FONT_STACK};
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
.fab:hover {
  background: #2f2f2f;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.composer textarea {
  flex: 1;
  min-width: 0;
  border: 1px solid #d0d0cc;
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  line-height: 1.4;
  background: #fff;
  color: #111;
  resize: none;
  overflow-y: hidden;
  max-height: ${COMPOSER_MAX_HEIGHT}px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  var Sidebar = class {
    constructor(callbacks) {
      this.threads = [];
      this.expanded = /* @__PURE__ */ new Set();
      /** Unsent composer text per thread, so re-renders don't wipe it. */
      this.drafts = /* @__PURE__ */ new Map();
      this.sending = /* @__PURE__ */ new Set();
      this.errors = /* @__PURE__ */ new Map();
      this.partials = /* @__PURE__ */ new Map();
      this.activeId = null;
      /** Start collapsed so we don't cover ChatGPT chrome until needed. */
      this.collapsed = true;
      this.callbacks = callbacks;
      let host = document.getElementById(HOST_ID);
      if (!host) {
        host = document.createElement("div");
        host.id = HOST_ID;
        document.body.appendChild(host);
      }
      this.host = host;
      this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "beforeinput", "input", "paste", "cut", "copy", "compositionstart", "compositionend"]) {
        this.shadow.addEventListener(type, (event) => event.stopPropagation());
      }
      this.renderShell();
    }
    /** Re-append the host if the page's own rendering removed it from <body>. */
    ensureMounted() {
      if (this.host.isConnected) return;
      log6.debug("Sidebar host was removed by the page; re-attaching");
      document.body.appendChild(this.host);
    }
    isMounted() {
      return this.host.isConnected;
    }
    setThreads(threads) {
      this.threads = threads;
      this.renderList();
    }
    focusThread(threadId) {
      this.expanded.clear();
      this.expanded.add(threadId);
      this.activeId = threadId;
      this.setCollapsed(false);
      this.renderList();
      const card = this.shadow.querySelector(
        `[data-thread-id="${CSS.escape(threadId)}"]`
      );
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      card?.querySelector("textarea")?.focus({ preventScroll: true });
    }
    /** Accordion: opening a thread closes the others; clicking the open one closes it. */
    toggleThread(threadId) {
      const wasOpen = this.expanded.has(threadId);
      this.expanded.clear();
      if (!wasOpen) {
        this.expanded.add(threadId);
        this.activeId = threadId;
        this.callbacks.onFocusThread(threadId);
      }
      this.renderList();
    }
    /** Update the in-flight assistant bubble without rebuilding the whole list. */
    patchAssistantReply(threadId, text) {
      this.partials.set(threadId, text);
      const card = this.shadow.querySelector(
        `[data-thread-id="${CSS.escape(threadId)}"]`
      );
      if (!card) return;
      const replies = card.querySelector(".replies");
      if (!replies) return;
      let live = replies.querySelector(
        ".reply.assistant.streaming"
      );
      if (!live) {
        live = document.createElement("div");
        live.className = "reply assistant streaming";
        setHtml(live, `<div class="role">assistant</div><div class="body"></div>`);
        replies.appendChild(live);
      }
      const body = live.querySelector(".body");
      if (body) setHtml(body, formatReplyHtml(text) || "&nbsp;");
      replies.scrollTop = replies.scrollHeight;
    }
    setCollapsed(collapsed) {
      this.collapsed = collapsed;
      this.panel.classList.toggle("collapsed", collapsed);
      this.fab.classList.toggle("visible", collapsed);
      this.fab.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    renderShell() {
      this.shadow.replaceChildren();
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
      setHtml(
        this.panel,
        `
      <div class="header">
        <span>Highlight threads</span>
        <button type="button" class="collapse-btn" title="Collapse" aria-label="Collapse">\u203A</button>
      </div>
      <div class="list"></div>
    `
      );
      this.shadow.appendChild(this.panel);
      this.listEl = this.panel.querySelector(".list");
      this.panel.querySelector(".collapse-btn")?.addEventListener("click", () => {
        this.setCollapsed(true);
      });
    }
    renderList() {
      const focused = this.shadow.activeElement;
      const focusState = focused instanceof HTMLTextAreaElement ? {
        id: focused.closest("[data-thread-id]")?.dataset.threadId,
        start: focused.selectionStart,
        end: focused.selectionEnd
      } : null;
      if (this.threads.length === 0) {
        setHtml(
          this.listEl,
          `<div class="empty">Highlight text in a reply and click \u201CAsk about this\u201D to start a thread.</div>`
        );
        return;
      }
      this.listEl.replaceChildren();
      for (const thread of this.threads) {
        this.listEl.appendChild(this.buildCard(thread));
      }
      for (const [id, text] of this.partials) this.patchAssistantReply(id, text);
      if (focusState?.id) {
        const input = this.listEl.querySelector(
          `[data-thread-id="${CSS.escape(focusState.id)}"] textarea`
        );
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(focusState.start, focusState.end);
      }
    }
    buildCard(thread) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.threadId = thread.id;
      if (this.expanded.has(thread.id)) card.classList.add("expanded");
      if (this.activeId === thread.id) card.classList.add("active");
      const header = document.createElement("div");
      header.className = "card-header";
      const main2 = document.createElement("div");
      main2.className = "card-header-main";
      setHtml(
        main2,
        `
      <div class="quote">${escapeHtml2(thread.quotedText)}</div>
      <div class="meta">${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}</div>
    `
      );
      main2.addEventListener("click", () => this.toggleThread(thread.id));
      const collapseBtn = document.createElement("button");
      collapseBtn.type = "button";
      collapseBtn.className = "close-btn";
      const isExpanded = this.expanded.has(thread.id);
      collapseBtn.title = isExpanded ? "Collapse thread" : "Expand thread";
      collapseBtn.setAttribute(
        "aria-label",
        isExpanded ? "Collapse thread" : "Expand thread"
      );
      collapseBtn.textContent = isExpanded ? "\u25BE" : "\u25B8";
      collapseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleThread(thread.id);
      });
      header.appendChild(main2);
      header.appendChild(collapseBtn);
      card.appendChild(header);
      const body = document.createElement("div");
      body.className = "card-body";
      const replies = document.createElement("div");
      replies.className = "replies";
      for (const r of thread.replies) {
        const div = document.createElement("div");
        div.className = `reply ${r.role}`;
        setHtml(
          div,
          `<div class="role">${r.role}</div><div class="body">${r.role === "assistant" ? formatReplyHtml(r.text) : escapeHtml2(r.text)}</div>`
        );
        replies.appendChild(div);
      }
      body.appendChild(replies);
      const composer = document.createElement("div");
      composer.className = "composer";
      const input = document.createElement("textarea");
      input.rows = 1;
      input.placeholder = "Ask about this snippet\u2026";
      input.setAttribute("aria-label", "Ask about this snippet");
      input.readOnly = this.sending.has(thread.id);
      input.value = this.drafts.get(thread.id) ?? "";
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
      });
      if (input.value) requestAnimationFrame(autoGrow);
      const send = document.createElement("button");
      send.type = "button";
      send.textContent = "Send";
      send.disabled = this.sending.has(thread.id);
      const status = document.createElement("div");
      status.className = "status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = this.sending.has(thread.id) ? "Waiting for a reply\u2026" : this.errors.get(thread.id) ?? "";
      const doSend = async () => {
        const question = input.value.trim();
        if (!question || this.sending.has(thread.id)) return;
        this.sending.add(thread.id);
        this.errors.delete(thread.id);
        this.drafts.set(thread.id, question);
        this.renderList();
        const patch = rafThrottle(
          (partial) => this.patchAssistantReply(thread.id, partial)
        );
        try {
          const result = await this.callbacks.onSend(thread, question, patch);
          if (!result.ok) {
            this.errors.set(thread.id, result.error || "Request failed");
          } else {
            this.drafts.delete(thread.id);
          }
        } catch (err) {
          this.errors.set(thread.id, err instanceof Error ? err.message : String(err));
        } finally {
          patch.cancel();
          this.sending.delete(thread.id);
          this.partials.delete(thread.id);
          this.renderList();
        }
      };
      send.addEventListener("click", () => void doSend());
      const onKeyDown = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          void doSend();
        }
      };
      input.addEventListener("keydown", onKeyDown);
      input.addEventListener(SIDEBAR_KEY_EVENT, (event) => {
        onKeyDown(event.detail);
      });
      composer.appendChild(input);
      composer.appendChild(send);
      body.appendChild(composer);
      body.appendChild(status);
      card.appendChild(body);
      return card;
    }
  };
  function escapeHtml2(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var SESSION_COMPLETERS = {
    chatgpt: async (req, onPartial) => completeViaChatGptSession(await fetchAccessTokenFromPage(), req, onPartial),
    claude: completeViaClaudeSession,
    gemini: completeViaGeminiSession
  };
  async function sendAskFollowUp(payload, onPartial) {
    const message = { type: "ask-follow-up", ...payload };
    const complete = SESSION_COMPLETERS[payload.siteId];
    if (complete) {
      try {
        log6.debug(`Completing ${payload.siteId} follow-up in page`);
        return await complete(message, onPartial);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log6.error("Follow-up failed:", error);
        return { ok: false, error };
      }
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }
        resolve(response ?? { ok: false, error: "Empty response" });
      });
    });
  }

  // extension/core/storage.ts
  var log7 = createLogger("storage");
  var EXTENSION_RELOAD_MSG = "Extension was reloaded \u2014 refresh this tab to keep using Highlight threads.";
  function storageKey(siteId, conversationId) {
    return `${siteId}:${conversationId}`;
  }
  function isExtensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }
  function asStorageError(err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/extension context invalidated/i.test(raw) || !isExtensionAlive()) {
      return new Error(EXTENSION_RELOAD_MSG);
    }
    return err instanceof Error ? err : new Error(raw);
  }
  async function loadThreads(siteId, conversationId) {
    if (!isExtensionAlive()) return [];
    const key = storageKey(siteId, conversationId);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError) {
            log7.error("storage load failed:", chrome.runtime.lastError.message);
            resolve([]);
            return;
          }
          const value = result[key];
          const threads = Array.isArray(value) ? value : [];
          log7.debug(`Loaded ${threads.length} thread(s) from "${key}"`);
          resolve(threads);
        });
      } catch (err) {
        log7.error("storage load threw:", asStorageError(err).message);
        resolve([]);
      }
    });
  }
  async function saveThreads(siteId, conversationId, threads) {
    if (!isExtensionAlive()) {
      throw new Error(EXTENSION_RELOAD_MSG);
    }
    const key = storageKey(siteId, conversationId);
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [key]: threads }, () => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || "storage save failed";
            log7.error("storage save failed:", msg);
            reject(asStorageError(new Error(msg)));
            return;
          }
          log7.debug(`Saved ${threads.length} thread(s) to "${key}"`);
          resolve();
        });
      } catch (err) {
        reject(asStorageError(err));
      }
    });
  }
  function removeKeys(keys) {
    if (!isExtensionAlive() || keys.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) {
            log7.warn("storage remove failed:", chrome.runtime.lastError.message);
          }
          resolve();
        });
      } catch (err) {
        log7.warn("storage remove threw:", asStorageError(err).message);
        resolve();
      }
    });
  }
  function removeLegacyKeys(siteId) {
    return removeKeys([`${siteId}:__side_conversation_ids`]);
  }
  async function migrateThreads(siteId, fromConversationId, toConversationId, presentMessageIds) {
    const [from, to] = await Promise.all([
      loadThreads(siteId, fromConversationId),
      loadThreads(siteId, toConversationId)
    ]);
    const moving = from.filter((t) => presentMessageIds.has(t.messageId));
    if (moving.length === 0) return to;
    const known = new Set(to.map((t) => t.id));
    const merged = [...to, ...moving.filter((t) => !known.has(t.id))];
    const remaining = from.filter((t) => !presentMessageIds.has(t.messageId));
    await saveThreads(siteId, toConversationId, merged);
    if (remaining.length) {
      await saveThreads(siteId, fromConversationId, remaining);
    } else {
      await removeKeys([storageKey(siteId, fromConversationId)]);
    }
    log7.debug(
      `Moved ${moving.length} thread(s) from "${fromConversationId}" to "${toConversationId}"`
    );
    return merged;
  }
  async function summarizeStorage(siteId) {
    if (!isExtensionAlive()) return { bytesInUse: null, conversations: [] };
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          const conversations = [];
          for (const [key, value] of Object.entries(all ?? {})) {
            if (!key.startsWith(`${siteId}:`) || !Array.isArray(value)) continue;
            const threads = value;
            conversations.push({
              key,
              threads: threads.length,
              replies: threads.reduce((n, t) => n + (t.replies?.length ?? 0), 0),
              quotes: threads.slice(0, 5).map((t) => (t.quotedText ?? "").slice(0, 40))
            });
          }
          chrome.storage.local.getBytesInUse(null, (bytes) => {
            resolve({
              bytesInUse: chrome.runtime.lastError ? null : bytes,
              conversations
            });
          });
        });
      } catch (err) {
        log7.warn("storage summary failed:", asStorageError(err).message);
        resolve({ bytesInUse: null, conversations: [] });
      }
    });
  }

  // extension/core/diagnostics.ts
  var DIAGNOSTICS_EVENT = "ai-helper:diagnostics";
  async function environment() {
    const uaData = navigator.userAgentData;
    const chromeFromUa = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null;
    let os = uaData?.platform || navigator.platform || "unknown";
    let chromeVersion = chromeFromUa;
    let arch = null;
    try {
      const hi = await uaData?.getHighEntropyValues?.([
        "platform",
        "platformVersion",
        "architecture",
        "fullVersionList"
      ]);
      if (hi) {
        if (hi.platform) {
          os = hi.platformVersion ? `${hi.platform} ${hi.platformVersion}` : hi.platform;
        }
        arch = hi.architecture ?? null;
        const brand = hi.fullVersionList?.find(
          (b) => /Google Chrome|Chromium|Microsoft Edge|Brave/.test(b.brand)
        );
        if (brand) chromeVersion = `${brand.brand} ${brand.version}`;
      }
    } catch {
    }
    return {
      os,
      arch,
      chromeVersion,
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`
    };
  }
  function manifestVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return null;
    }
  }
  async function collect(src) {
    const alive = isExtensionAlive();
    const storage = alive ? await summarizeStorage(src.adapter.siteId) : "extension context invalidated \u2014 refresh the tab";
    return {
      extension: {
        version: manifestVersion(),
        buildTime: BUILD_TIME,
        contextAlive: alive,
        engineStopped: src.isDead(),
        debug: DEBUG,
        debugToggle: `localStorage.setItem("${DEBUG_STORAGE_KEY}", "1") then reload`
      },
      environment: await environment(),
      page: {
        url: location.href,
        readyState: document.readyState,
        siteId: src.adapter.siteId,
        conversationId: src.getConversationId()
      },
      engine: {
        threadsLoaded: src.getThreadCount(),
        messagesRegistered: src.getRegisteredMessageCount(),
        messagesWaitingForStreamEnd: src.getPendingCount(),
        messageRootsFoundNow: src.adapter.getMessageContainers().length
      },
      dom: {
        sidebarHostPresent: Boolean(document.getElementById(HOST_ID)),
        sidebarMounted: src.isSidebarMounted(),
        askButtonVisible: Boolean(document.getElementById(ASK_BUTTON_ID)),
        highlightMarks: document.querySelectorAll("mark[data-thread-id]").length,
        ...src.adapter.describeDom?.() ?? {}
      },
      storage
    };
  }
  function registerDiagnostics(src) {
    const run = async () => {
      const report = await collect(src);
      console.log("[ai-helper] diagnostics\n" + JSON.stringify(report, null, 2));
      return report;
    };
    const onEvent = () => void run();
    document.addEventListener(DIAGNOSTICS_EVENT, onEvent);
    const g = globalThis;
    g.aiHelperDiagnostics = run;
    return () => {
      document.removeEventListener(DIAGNOSTICS_EVENT, onEvent);
      if (g.aiHelperDiagnostics === run) delete g.aiHelperDiagnostics;
    };
  }

  // extension/core/engine.ts
  var log8 = createLogger("engine");
  var EXCERPT_MAX_CHARS = 4e3;
  var TICK_MS = 1e3;
  var READY_TIMEOUT_MS = 10 * 6e4;
  function createId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  async function bootEngine(adapter) {
    let conversationId = adapter.getConversationId();
    let threads = await loadThreads(adapter.siteId, conversationId);
    const messageEls = /* @__PURE__ */ new Map();
    const pendingReady = /* @__PURE__ */ new Map();
    let loadToken = 0;
    let dead = false;
    const markDead = (err) => {
      if (dead) return;
      dead = true;
      const msg = err instanceof Error && /reload this/i.test(err.message) ? err.message : EXTENSION_RELOAD_MSG;
      log8.warn(msg, err instanceof Error ? err.message : err ?? "");
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
    const surroundingContext = (thread) => {
      const el = messageEls.get(thread.messageId);
      if (!el) return thread.quotedText;
      const raw = el.dataset.aiHelperRaw || getPlainText(el);
      const pad = 200;
      const start = Math.max(0, thread.anchorStart - pad);
      const end = Math.min(raw.length, thread.anchorEnd + pad);
      return raw.slice(start, end);
    };
    const conversationExcerpt = () => {
      if (typeof adapter.getConversationExcerpt === "function") {
        return adapter.getConversationExcerpt(EXCERPT_MAX_CHARS);
      }
      return "";
    };
    const bindMarkClicks = (el) => {
      el.querySelectorAll("mark[data-thread-id]").forEach((mark) => {
        if (mark.dataset.aiHelperBound) return;
        mark.dataset.aiHelperBound = "1";
        mark.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = mark.dataset.threadId;
          if (id) sidebar.focusThread(id);
        });
      });
    };
    const applyToMessage = (el, messageId) => {
      if (!el.dataset.aiHelperRaw) {
        el.dataset.aiHelperRaw = getPlainText(el);
      }
      const forMessage = threads.filter((t) => t.messageId === messageId);
      applyHighlightsToElement(el, forMessage);
      bindMarkClicks(el);
    };
    const refreshHighlights = () => {
      for (const [messageId, el] of messageEls) {
        if (!adapter.isMessageComplete(el)) continue;
        applyToMessage(el, messageId);
      }
    };
    const sidebar = new Sidebar({
      onFocusThread: (threadId) => {
        const mark = document.querySelector(
          `mark[data-thread-id="${CSS.escape(threadId)}"]`
        );
        if (mark) {
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
          mark.style.outline = "2px solid #c9a227";
          setTimeout(() => {
            mark.style.outline = "";
          }, 1200);
        }
      },
      onSend: async (thread, question, onPartial) => {
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
            { role: "user", text: question, ts: Date.now() }
          ]
        };
        try {
          await persist();
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
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
            sideMeta: current.sideMeta,
            priorTurns: current.replies.map(({ role, text }) => ({ role, text }))
          },
          onPartial
        );
        if (result.ok && result.reply) {
          const i = threads.findIndex((t) => t.id === thread.id);
          if (i >= 0) {
            threads[i] = {
              ...threads[i],
              sideConversationId: result.sideConversationId ?? threads[i].sideConversationId,
              sideParentMessageId: result.sideParentMessageId ?? threads[i].sideParentMessageId,
              sideMeta: result.sideMeta ?? threads[i].sideMeta,
              replies: [
                ...threads[i].replies,
                { role: "assistant", text: result.reply, ts: Date.now() }
              ]
            };
            try {
              await persist();
            } catch (err) {
              return {
                ok: false,
                error: err instanceof Error ? err.message : String(err)
              };
            }
            sidebar.setThreads(threads);
          }
        }
        return result;
      }
    });
    sidebar.setThreads(threads);
    const registerMessage = (el) => {
      const messageId = adapter.getMessageId(el);
      messageEls.set(messageId, el);
      if (adapter.isMessageComplete(el)) {
        pendingReady.delete(el);
        applyToMessage(el, messageId);
      } else if (!pendingReady.has(el)) {
        pendingReady.set(el, { messageId, since: Date.now() });
      }
    };
    const processPendingReady = () => {
      const now = Date.now();
      for (const [el, { messageId, since }] of pendingReady) {
        if (!el.isConnected) {
          pendingReady.delete(el);
        } else if (adapter.isMessageComplete(el)) {
          pendingReady.delete(el);
          applyToMessage(el, messageId);
        } else if (now - since > READY_TIMEOUT_MS) {
          pendingReady.delete(el);
          log8.warn(
            `Message ${messageId} still looks like it is streaming after ${READY_TIMEOUT_MS / 6e4} min; skipping highlight restore for it.`
          );
        }
      }
    };
    const onAsk = async (anchor) => {
      if (!isExtensionAlive()) {
        markDead();
        log8.warn(EXTENSION_RELOAD_MSG);
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
        (t) => t.messageId === messageId && !(anchor.end <= t.anchorStart || anchor.start >= t.anchorEnd)
      );
      if (overlapping) {
        log8.warn("Selection overlaps an existing highlight; create skipped.");
        return;
      }
      const thread = {
        id: createId(),
        messageId,
        anchorStart: anchor.start,
        anchorEnd: anchor.end,
        quotedText: anchor.quotedText,
        replies: []
      };
      threads = [...threads, thread];
      try {
        await persist();
      } catch (err) {
        threads = threads.filter((t) => t.id !== thread.id);
        log8.warn(
          "could not save new thread:",
          err instanceof Error ? err.message : err
        );
        return;
      }
      sidebar.setThreads(threads);
      sidebar.focusThread(thread.id);
      refreshHighlights();
    };
    const detachSelection = attachSelectionHandler(
      () => adapter.getMessageContainers(),
      (anchor) => {
        void onAsk(anchor);
      },
      adapter.getMessageRootForNode?.bind(adapter),
      adapter.selectionStrategy ?? "native"
    );
    const stopObserving = adapter.onNewMessage((el) => registerMessage(el));
    void removeLegacyKeys(adapter.siteId);
    const onConversationChange = async (next) => {
      log8.debug(`Conversation changed: "${conversationId}" -> "${next}"`);
      const previous = conversationId;
      conversationId = next;
      const token = ++loadToken;
      const loaded = previous.startsWith("anon-") && !next.startsWith("anon-") ? await migrateThreads(
        adapter.siteId,
        previous,
        next,
        new Set(
          adapter.getMessageContainers().map((el) => adapter.getMessageId(el))
        )
      ).catch((err) => {
        log8.warn(
          "Could not move new-chat highlights:",
          err instanceof Error ? err.message : err
        );
        return loadThreads(adapter.siteId, next);
      }) : await loadThreads(adapter.siteId, next);
      if (token !== loadToken || dead) return;
      threads = loaded;
      messageEls.clear();
      pendingReady.clear();
      sidebar.setThreads(threads);
      for (const el of adapter.getMessageContainers()) {
        registerMessage(el);
      }
    };
    const tick = setInterval(() => {
      if (dead || !isExtensionAlive()) {
        markDead();
        clearInterval(tick);
        return;
      }
      adapter.reconcile?.();
      sidebar.ensureMounted();
      const next = adapter.getConversationId();
      if (next !== conversationId) {
        void onConversationChange(next);
      }
      if (pendingReady.size) processPendingReady();
    }, TICK_MS);
    const unregisterDiagnostics = registerDiagnostics({
      adapter,
      getConversationId: () => conversationId,
      getThreadCount: () => threads.length,
      getRegisteredMessageCount: () => messageEls.size,
      getPendingCount: () => pendingReady.size,
      isSidebarMounted: () => sidebar.isMounted(),
      isDead: () => dead
    });
    log8.info(
      `Engine started for site="${adapter.siteId}" conversation="${conversationId}" (${threads.length} threads loaded)`
    );
    return () => {
      detachSelection();
      stopObserving();
      clearInterval(tick);
      unregisterDiagnostics();
    };
  }

  // extension/content-scripts/inject.ts
  installSidebarInputGuard();
  var log9 = createLogger();
  var ADAPTERS = {
    "chatgpt.com": createChatGptAdapter,
    "www.chatgpt.com": createChatGptAdapter,
    "claude.ai": createClaudeAdapter,
    "gemini.google.com": createGeminiAdapter
  };
  function resolveAdapter(hostname) {
    return ADAPTERS[hostname]?.() ?? null;
  }
  async function main() {
    log9.debug(
      `Content script loaded (build ${BUILD_TIME}, DEBUG=${DEBUG}) on ${location.href}`
    );
    const adapter = resolveAdapter(location.hostname);
    if (!adapter) {
      log9.warn(`No adapter for hostname "${location.hostname}". Extension idle.`);
      return;
    }
    try {
      await bootEngine(adapter);
    } catch (err) {
      log9.error("Failed to boot engine:", err);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void main(), { once: true });
  } else {
    void main();
  }
})();
/*! Bundled license information:

js-sha3/build/sha3.mjs:
  (**
   * [js-sha3]{@link https://github.com/emn178/js-sha3}
   *
   * @version 0.13.0
   * @author Chen, Yi-Cyuan [emn178@gmail.com]
   * @copyright Chen, Yi-Cyuan 2015-2026
   * @license MIT
   *)
*/
