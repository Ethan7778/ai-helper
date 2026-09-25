/**
 * Pure ChatGPT SSE / conversation helpers (no Chrome APIs).
 * Unit-tested against handoff fixtures.
 */

export interface SseParseResult {
  reply: string;
  conversationId?: string;
  messageId?: string;
  /** Present when ChatGPT hands the turn off to WS / resume SSE. */
  topicId?: string;
  resumeToken?: string;
  /** True when the stream only handed off (WS/topic) and had no inline text. */
  handedOff: boolean;
  eventTypes: string[];
}

export function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p): p is string => typeof p === "string").join("");
}

/**
 * Parse ChatGPT conversation SSE: classic envelopes, delta v1 patches,
 * and stream-handoff metadata (resume_conversation_token / stream_handoff).
 */
export function parseConversationSseText(text: string): SseParseResult {
  let reply = "";
  let conversationId: string | undefined;
  let messageId: string | undefined;
  let topicId: string | undefined;
  let resumeToken: string | undefined;
  let lastPath = "";
  let lastOp = "append";
  let handedOff = false;
  const eventTypes: string[] = [];

  const applyAssistantMessage = (msg: {
    id?: string;
    author?: { role?: string };
    content?: { parts?: unknown[] };
  }) => {
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

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof event.type === "string") {
      eventTypes.push(event.type);
    }

    if (typeof event.conversation_id === "string") {
      conversationId = event.conversation_id;
    }

    // Modern ChatGPT: answer streams elsewhere; SSE only hands off a token.
    if (
      event.type === "resume_conversation_token" ||
      event.type === "stream_handoff"
    ) {
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
          const o = opt as { type?: string; topic_id?: string };
          if (
            (o.type === "subscribe_ws_topic" ||
              o.type === "resume_sse_endpoint") &&
            typeof o.topic_id === "string"
          ) {
            topicId = o.topic_id;
            break;
          }
        }
      }
      continue;
    }

    // Ignore other typed control events (markers, metadata, etc.)
    if (typeof event.type === "string") {
      continue;
    }

    if (event.message && typeof event.message === "object") {
      applyAssistantMessage(
        event.message as {
          id?: string;
          author?: { role?: string };
          content?: { parts?: unknown[] };
        }
      );
    }

    const v = event.v;
    const p = typeof event.p === "string" ? event.p : undefined;
    const o = typeof event.o === "string" ? event.o : undefined;
    if (p !== undefined) lastPath = p;
    if (o !== undefined) lastOp = o;

    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = v as {
        conversation_id?: string;
        message?: {
          id?: string;
          author?: { role?: string };
          content?: { parts?: unknown[] };
        };
      };
      if (typeof nested.conversation_id === "string") {
        conversationId = nested.conversation_id;
      }
      if (nested.message) applyAssistantMessage(nested.message);
    }

    if (typeof v === "string") {
      const path = p ?? lastPath;
      const op = o ?? lastOp;
      const isParts =
        !path || path.includes("/parts/") || path.endsWith("/parts/0");
      if (isParts) {
        if (op === "append" || (!o && !p)) reply += v;
        else if (op === "replace" || op === "add") reply = v;
      }
    }

    if (o === "patch" && Array.isArray(v)) {
      for (const sub of v) {
        if (!sub || typeof sub !== "object") continue;
        const sp = sub as { p?: string; o?: string; v?: unknown };
        if (typeof sp.v === "string" && (sp.p || "").includes("parts")) {
          if (sp.o === "append") reply += sp.v;
          else if (sp.o === "replace" || sp.o === "add") reply = sp.v;
        }
        if (
          sp.v &&
          typeof sp.v === "object" &&
          (sp.v as { message?: unknown }).message
        ) {
          applyAssistantMessage(
            (
              sp.v as {
                message: {
                  id?: string;
                  author?: { role?: string };
                  content?: { parts?: unknown[] };
                };
              }
            ).message
          );
        }
      }
    }
  }

  // Fallback: scrape conversation_id / topic_id from anywhere in the stream.
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
    eventTypes,
  };
}

function topicIdFromJwt(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    const json = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { turn_topic_id?: string };
    return typeof payload.turn_topic_id === "string"
      ? payload.turn_topic_id
      : undefined;
  } catch {
    return undefined;
  }
}

/** Pull the latest finished assistant turn from a conversation detail JSON. */
export function extractLatestAssistantFromConversation(data: unknown): {
  text: string;
  messageId?: string;
  status?: string;
} | null {
  if (!data || typeof data !== "object") return null;
  const mapping = (data as { mapping?: Record<string, unknown> }).mapping;
  if (!mapping || typeof mapping !== "object") return null;

  let best: {
    text: string;
    messageId?: string;
    status?: string;
    time: number;
  } | null = null;

  for (const node of Object.values(mapping)) {
    if (!node || typeof node !== "object") continue;
    const msg = (node as { message?: unknown }).message;
    if (!msg || typeof msg !== "object") continue;
    const message = msg as {
      id?: string;
      author?: { role?: string };
      status?: string;
      create_time?: number;
      content?: unknown;
    };
    if (message.author?.role !== "assistant") continue;
    const text = extractTextFromMessage(message);
    if (!text.trim()) continue;
    const time =
      typeof message.create_time === "number" ? message.create_time : 0;
    if (!best || time >= best.time) {
      best = {
        text,
        messageId: message.id,
        status: message.status,
        time,
      };
    }
  }

  return best
    ? { text: best.text, messageId: best.messageId, status: best.status }
    : null;
}
