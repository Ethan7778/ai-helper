/**
 * ChatGPT unofficial session client (sentinel + conversation).
 * PoW algorithm adapted from lanqian528/chat2api / pi-gpt (MIT-licensed ports).
 */
import { sha3_512 } from "js-sha3";
import { buildFollowUpPrompt } from "../core/prompt";
import { createLogger } from "../core/log";
import { parseConversationSseText } from "../core/sse-parse";
import { cleanChatGptText } from "../core/text-clean";
import type { AskFollowUpRequest, AskFollowUpResponse } from "../core/types";

const log = createLogger("chatgpt-session");
const REQUIREMENTS_URL =
  "https://chatgpt.com/backend-api/sentinel/chat-requirements";
const CONVERSATION_URLS = [
  "https://chatgpt.com/backend-api/f/conversation",
  "https://chatgpt.com/backend-api/conversation",
];
const MODELS_URL = "https://chatgpt.com/backend-api/models";

export interface SessionCredentials {
  accessToken: string;
  userAgent: string;
}

export interface CompleteResult {
  reply: string;
  conversationId: string;
  parentMessageId: string;
  model: string;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function compact(arr: unknown[], start = 0, end = arr.length): string {
  return JSON.stringify(arr.slice(start, end)).slice(1, -1);
}

function browserLanguage(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** PoW fingerprint from the real browser (screen, local time zone, locale, cores). */
function buildConfig(userAgent: string): unknown[] {
  const perf =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Math.random() * 1000;
  const screenSum =
    typeof screen !== "undefined" && screen.width
      ? screen.width + screen.height
      : 1920 + 1080;
  const language = browserLanguage();
  const languages =
    typeof navigator !== "undefined" && navigator.languages?.length
      ? navigator.languages.join(",")
      : language;
  const cores =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;
  return [
    screenSum,
    new Date().toString(),
    4294705152,
    0,
    userAgent,
    "",
    "",
    language,
    languages,
    0,
    "webdriver−false",
    "location",
    "window",
    perf,
    uuid(),
    "",
    cores,
    Date.now() - perf,
  ];
}

function generateAnswer(
  seed: string,
  diff: string,
  config: unknown[]
): [string, boolean] {
  const target = bytesFromHex(diff);
  const seedEncoded = utf8(seed);
  const part1 = utf8(`[${compact(config, 0, 3)},`);
  const part2 = utf8(`,${compact(config, 4, 9)},`);
  const part3 = utf8(`,${compact(config, 10)}]`);

  for (let i = 0; i < 500_000; i++) {
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

  const fallback =
    "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + toBase64(utf8(`"${seed}"`));
  return [fallback, false];
}

function solvePow(seed: string, difficulty: string, userAgent: string): string {
  const config = buildConfig(userAgent);
  const [answer] = generateAnswer(seed, difficulty, config);
  return `gAAAAAB${answer}`;
}

function getRequirementsToken(userAgent: string): string {
  const config = buildConfig(userAgent);
  const [require] = generateAnswer(String(Math.random()), "0fffff", config);
  return `gAAAAAC${require}`;
}

async function fetchSentinelTokens(
  accessToken: string,
  userAgent: string
): Promise<{ chatRequirements: string; proof?: string }> {
  const p = getRequirementsToken(userAgent);
  const res = await fetch(REQUIREMENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({ p }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error(
      `chat-requirements failed: HTTP ${res.status}`,
      body.slice(0, 300)
    );
    throw new Error(
      `ChatGPT session gate failed (chat-requirements HTTP ${res.status}). Reload chatgpt.com and try again.`
    );
  }

  const data = (await res.json()) as {
    token?: string;
    proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
  };

  if (!data.token) {
    log.error(`chat-requirements response missing token`);
    throw new Error("ChatGPT session gate returned no token.");
  }

  const out: { chatRequirements: string; proof?: string } = {
    chatRequirements: data.token,
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

async function resolveModel(
  accessToken: string,
  userAgent: string
): Promise<string> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": userAgent,
      },
    });
    if (!res.ok) {
      log.warn(`models fetch HTTP ${res.status}; using auto`);
      return "auto";
    }
    const data = (await res.json()) as {
      models?: Array<{ slug?: string; title?: string }>;
    };
    const slug = data.models?.[0]?.slug;
    if (slug) {
      log.debug(`Using model "${slug}"`);
      return slug;
    }
  } catch (err) {
    log.warn(`models fetch failed; using auto`, err);
  }
  log.debug(`Using model "auto"`);
  return "auto";
}

async function getChatGptWebSocketUrl(
  accessToken: string,
  userAgent: string
): Promise<string> {
  const res = await fetch("https://chatgpt.com/backend-api/celsius/ws/user", {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
      "User-Agent": userAgent,
    },
  });
  if (!res.ok) {
    throw new Error(`celsius/ws/user HTTP ${res.status}`);
  }
  const data = (await res.json()) as { websocket_url?: string };
  if (!data.websocket_url) {
    throw new Error("celsius/ws/user returned no websocket_url");
  }
  return data.websocket_url;
}

function collectEncodedSseFromWsFrame(frame: unknown): string[] {
  const out: string[] = [];
  if (!frame || typeof frame !== "object") return out;
  const f = frame as Record<string, unknown>;

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.encoded_item === "string" && obj.encoded_item) {
      out.push(obj.encoded_item);
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") walk(value);
    }
  };

  // Prefer catchups on reply frames.
  if (f.type === "reply" && f.reply && typeof f.reply === "object") {
    const reply = f.reply as { catchups?: unknown[] };
    if (Array.isArray(reply.catchups)) {
      for (const cu of reply.catchups) walk(cu);
    }
  }
  walk(f);
  return out;
}

/**
 * Subscribe to the turn topic over ChatGPT's user WebSocket and reassemble
 * the assistant reply from encoded SSE items.
 */
async function recoverViaWebSocket(
  accessToken: string,
  userAgent: string,
  topicId: string,
  onPartial?: (text: string) => void,
  timeoutMs = 90_000
): Promise<{ reply: string; messageId?: string; conversationId?: string }> {
  const wsUrl = await getChatGptWebSocketUrl(accessToken, userAgent);
  let host = wsUrl;
  try {
    host = new URL(wsUrl).host;
  } catch {
    // keep raw
  }
  log.debug(
    `Opening handoff WebSocket host=${host} topic=${topicId}`
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let reply = "";
    let messageId: string | undefined;
    let conversationId: string | undefined;
    let sseBuffer = "";
    let cmdId = 4;
    let framesSeen = 0;
    let encodedSeen = 0;

    const emit = (text: string) => {
      if (!text.trim()) return;
      onPartial?.(cleanChatGptText(text));
    };

    const finish = (ok: boolean, err?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (ok && reply.trim()) {
        log.debug(
          `WebSocket recovered reply (${reply.length} chars, frames=${framesSeen}, encoded=${encodedSeen})`
        );
        resolve({ reply, messageId, conversationId });
      } else {
        reject(
          new Error(
            err ||
              `WebSocket handoff produced no reply (frames=${framesSeen}, encoded=${encodedSeen})`
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
      log.debug(`WebSocket open — subscribing to ${topicId}`);
      ws.send(
        JSON.stringify([
          {
            id: 1,
            command: {
              type: "connect",
              presence: { type: "presence", state: "background" },
            },
          },
          { id: 2, command: { type: "subscribe", topic_id: "calpico-chatgpt" } },
          { id: 3, command: { type: "subscribe", topic_id: "conversations" } },
          {
            id: ++cmdId,
            command: { type: "subscribe", topic_id: topicId, offset: "0" },
          },
        ])
      );
    };

    ws.onerror = () => {
      log.warn(`WebSocket error event`);
      finish(false, "WebSocket handoff connection error");
    };

    ws.onclose = (ev) => {
      log.debug(
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
      let frames: unknown[] = [];
      try {
        const parsed = JSON.parse(String(ev.data));
        frames = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        log.warn(
          `WebSocket non-JSON frame len=${String(ev.data).length}`
        );
        return;
      }

      for (const frame of frames) {
        framesSeen += 1;
        const fType =
          frame && typeof frame === "object"
            ? String((frame as { type?: unknown }).type || "unknown")
            : typeof frame;
        if (framesSeen <= 10) {
          log.debug(`WS frame#${framesSeen} type=${fType}`);
        }

        const encodedChunks = collectEncodedSseFromWsFrame(frame);
        for (const encoded of encodedChunks) {
          encodedSeen += 1;
          sseBuffer += `${encoded}\n`;
          const parsed = parseConversationSseText(sseBuffer);
          if (parsed.conversationId) conversationId = parsed.conversationId;
          if (parsed.messageId) messageId = parsed.messageId;
          if (parsed.reply) {
            reply = parsed.reply;
            emit(reply);
          }
          if (
            (encoded.includes("[DONE]") ||
              parsed.eventTypes.includes("message_stream_complete")) &&
            reply.trim()
          ) {
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

function extractAssistantFromUnknownFrame(
  frame: unknown
): { text: string; messageId?: string; finished?: boolean } | null {
  if (!frame || typeof frame !== "object") return null;
  const stack: unknown[] = [frame];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (obj.message && typeof obj.message === "object") {
      const msg = obj.message as {
        id?: string;
        author?: { role?: string };
        status?: string;
        content?: unknown;
        channel?: string;
      };
      if (msg.author?.role === "assistant") {
        const text = (() => {
          const content = msg.content;
          if (!content || typeof content !== "object") return "";
          const parts = (content as { parts?: unknown }).parts;
          if (!Array.isArray(parts)) return "";
          return parts
            .filter((p): p is string => typeof p === "string")
            .join("");
        })();
        if (text.trim()) {
          return {
            text,
            messageId: msg.id,
            finished:
              msg.status === "finished_successfully" || msg.channel === "final",
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

async function parseConversationStream(
  res: Response,
  accessToken: string,
  userAgent: string,
  onPartial?: (text: string) => void
): Promise<{ reply: string; conversationId?: string; messageId?: string }> {
  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = await res.json();
    log.error(`Unexpected JSON response (not SSE)`, data);
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : "ChatGPT returned JSON instead of a stream. Session may be blocked."
    );
  }

  const emit = (text: string) => {
    if (!text.trim()) return;
    onPartial?.(cleanChatGptText(text));
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

  log.debug(
    `SSE events=[${parsed.eventTypes.join(",") || "none"}] ` +
      `handedOff=${parsed.handedOff} replyLen=${parsed.reply.length} ` +
      `conversationId=${parsed.conversationId || "none"} ` +
      `topicId=${parsed.topicId || "none"}`
  );

  if (parsed.reply.trim()) {
    emit(parsed.reply);
    return {
      reply: parsed.reply,
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
    };
  }

  // Temporary side chats never show up on GET /conversation, so the
  // WebSocket turn topic is the only way to recover a handed-off stream.
  if (!parsed.topicId) {
    log.error(
      `Empty SSE with no topic to resume; head=${text.slice(0, 400)}`
    );
    throw new Error(
      "ChatGPT handed off the stream without a topic id. Reload and try again."
    );
  }

  log.debug("Recovering handoff via websocket");
  try {
    const recovered = await recoverViaWebSocket(
      accessToken,
      userAgent,
      parsed.topicId,
      onPartial
    );
    log.debug("Handoff recovered via websocket");
    emit(recovered.reply);
    return {
      reply: recovered.reply,
      conversationId: recovered.conversationId || parsed.conversationId,
      messageId: recovered.messageId || parsed.messageId,
    };
  } catch (err) {
    throw new Error(
      `Handoff recovery failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function postConversation(
  accessToken: string,
  userAgent: string,
  sentinel: { chatRequirements: string; proof?: string },
  prompt: string,
  model: string,
  sideConversationId?: string,
  sideParentMessageId?: string,
  onPartial?: (text: string) => void
): Promise<CompleteResult> {
  const messageId = uuid();
  const parentMessageId =
    (sideParentMessageId && sideParentMessageId.trim()) ||
    "client-created-root";

  const body: Record<string, unknown> = {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [prompt] },
        metadata: {},
      },
    ],
    parent_message_id: parentMessageId,
    model,
    timezone_offset_min: new Date().getTimezoneOffset(),
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
      app_name: "chatgpt.com",
    },
  };

  if (sideConversationId) {
    body.conversation_id = sideConversationId;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": userAgent,
    "OAI-Language": browserLanguage(),
    "Openai-Sentinel-Chat-Requirements-Token": sentinel.chatRequirements,
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
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log.error(
        `conversation POST ${url} → HTTP ${res.status}`,
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
      model,
    };
  }

  throw new Error(lastError);
}

/**
 * Ask ChatGPT via the logged-in session. Streams partial text via onPartial when provided.
 */
export async function completeViaChatGptSession(
  creds: SessionCredentials,
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  try {
    const prompt = buildFollowUpPrompt({
      quotedText: req.quotedText,
      surroundingContext: req.surroundingContext,
      conversationExcerpt: req.conversationExcerpt,
      question: req.question,
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
      log.warn(
        `Reply ok but conversation_id missing; follow-ups in this thread may start a new side chat.`
      );
    }

    return {
      ok: true,
      reply: cleanChatGptText(result.reply),
      sideConversationId: result.conversationId || undefined,
      sideParentMessageId: result.parentMessageId || undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`complete failed:`, message);
    return { ok: false, error: message };
  }
}
