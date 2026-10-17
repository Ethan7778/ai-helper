/** How highlight marks are drawn on the host page. */
export type HighlightStyle = "classic" | "underline";

/** Preferred amount of detail for new sidebar answers. */
export type AnswerLength = "short" | "medium" | "detailed";
export const DEFAULT_ANSWER_LENGTH: AnswerLength = "short";

export function normalizeAnswerLength(raw: unknown): AnswerLength {
  return raw === "short" || raw === "medium" || raw === "detailed"
    ? raw
    : DEFAULT_ANSWER_LENGTH;
}

/** User-tunable sidebar / highlight appearance (persisted in extension storage). */
export interface UiAppearance {
  /** CSS hex color for highlight marks and sidebar accents, e.g. `#c9a227`. */
  highlightColor: string;
  highlightStyle: HighlightStyle;
}

export const DEFAULT_UI_APPEARANCE: UiAppearance = {
  highlightColor: "#c9a227",
  highlightStyle: "classic",
};

/** A single turn inside a highlight thread. */
export interface Reply {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** Optional takeaways, generated with a sufficiently long assistant reply. */
  summary?: string[];
}

/** A highlight-anchored follow-up thread, persisted by character offsets. */
export interface Thread {
  id: string;
  messageId: string;
  anchorStart: number;
  anchorEnd: number;
  quotedText: string;
  replies: Reply[];
  /** Hidden (temporary) side conversation used only by this highlight thread. */
  sideConversationId?: string;
  /** Leaf message id in the side conversation (for parent_message_id). */
  sideParentMessageId?: string;
  /** Extra per-site continuation state (e.g. Claude org id, Gemini candidate id). */
  sideMeta?: Record<string, string>;
}

/** How the Ask button captures a highlight on this site. */
export type SelectionStrategy = "native" | "native-sticky" | "pointer";

/** Site-specific hooks so the core engine stays agnostic of host DOM. */
export interface SiteAdapter {
  siteId: string;
  /**
   * ChatGPT's selected-text overlay can replace the browser selection with a
   * tiny fragment; use `"pointer"` there. Other sites keep `"native"`.
   */
  selectionStrategy?: SelectionStrategy;
  /** Optional: extra page CSS so the site's fixed chrome respects the docked sidebar. */
  dockFixups?: readonly string[];
  getConversationId(): string;
  getMessageContainers(): HTMLElement[];
  getMessageId(el: HTMLElement): string;
  isMessageComplete(el: HTMLElement): boolean;
  /** Report existing and future message roots. Returns a cleanup function. */
  onNewMessage(cb: (el: HTMLElement) => void): () => void;
  /** Optional: budgeted excerpt of the visible parent chat for follow-ups. */
  getConversationExcerpt?(maxChars: number): string;
  /** Optional: message root containing `node`, for selections outside known roots. */
  getMessageRootForNode?(node: Node): HTMLElement | null;
  /** Optional: re-attach observers after SPA navigation or host DOM replacement. */
  reconcile?(): void;
  /** Optional: selector hit counts etc. for the diagnostics report. */
  describeDom?(): Record<string, unknown>;
}

/** Message sent from the sidebar to the background service worker. */
export interface AskFollowUpRequest {
  type: "ask-follow-up";
  siteId: string;
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
  answerLength?: AnswerLength;
  summaryEnabled?: boolean;
  messageId: string;
  threadId: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
  sideMeta?: Record<string, string>;
  /** Earlier Q&A in this thread, resent only when the side chat can't be continued. */
  priorTurns?: Pick<Reply, "role" | "text">[];
}

/** Result of a follow-up, from an in-page session client or the service worker. */
export interface AskFollowUpResponse {
  ok: boolean;
  reply?: string;
  error?: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
  sideMeta?: Record<string, string>;
}
