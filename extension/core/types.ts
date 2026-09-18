/** A single turn inside a highlight thread. */
export interface Reply {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** A highlight-anchored follow-up thread, persisted by character offsets. */
export interface Thread {
  id: string;
  messageId: string;
  anchorStart: number;
  anchorEnd: number;
  quotedText: string;
  replies: Reply[];
}

/** Site-specific hooks so the core engine stays agnostic of host DOM. */
export interface SiteAdapter {
  siteId: string;
  getConversationId(): string;
  getMessageContainers(): HTMLElement[];
  getMessageId(el: HTMLElement): string;
  isMessageComplete(el: HTMLElement): boolean;
  onNewMessage(cb: (el: HTMLElement) => void): void;
}

/** Message sent from the sidebar to the background service worker. */
export interface AskFollowUpRequest {
  type: "ask-follow-up";
  quotedText: string;
  surroundingContext: string;
  question: string;
  messageId: string;
  threadId: string;
}

/** Response returned by the background service worker. */
export interface AskFollowUpResponse {
  ok: boolean;
  reply?: string;
  error?: string;
}
