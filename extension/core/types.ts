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
  /** Hidden ChatGPT conversation used only by this highlight thread. */
  sideConversationId?: string;
  /** Leaf message id in the side conversation (for parent_message_id). */
  sideParentMessageId?: string;
}

/** Site-specific hooks so the core engine stays agnostic of host DOM. */
export interface SiteAdapter {
  siteId: string;
  getConversationId(): string;
  getMessageContainers(): HTMLElement[];
  getMessageId(el: HTMLElement): string;
  isMessageComplete(el: HTMLElement): boolean;
  onNewMessage(cb: (el: HTMLElement) => void): void;
  /** Optional: budgeted excerpt of the visible parent chat for follow-ups. */
  getConversationExcerpt?(maxChars: number): string;
}

/** Message sent from the sidebar to the background service worker. */
export interface AskFollowUpRequest {
  type: "ask-follow-up";
  siteId: string;
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
  messageId: string;
  threadId: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
}

/** Response returned by the background service worker. */
export interface AskFollowUpResponse {
  ok: boolean;
  reply?: string;
  error?: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
}

/** Content-script ↔ service-worker session credential request. */
export interface GetAccessTokenRequest {
  type: "get-chatgpt-access-token";
}

export interface GetAccessTokenResponse {
  ok: boolean;
  accessToken?: string;
  userAgent?: string;
  error?: string;
}

/** SW asks the content script to run the ChatGPT session completion (cookies). */
export interface ChatGptCompleteRequest {
  type: "chatgpt-complete";
  payload: Omit<AskFollowUpRequest, "type">;
}

export type ContentScriptRequest =
  | GetAccessTokenRequest
  | ChatGptCompleteRequest;
