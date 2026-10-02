/**
 * gemini.google.com unofficial session client. Runs in the content script so
 * Google cookies are same-origin. Every request sets Gemini's temporary-chat
 * flag, so side chats never appear in Recent chats.
 */
import {
  cleanGeminiText,
  createGeminiStreamState,
  feedGeminiStream,
  finishGeminiStream,
} from "../core/gemini-parse";
import { createLogger } from "../core/log";
import { buildFollowUpPrompt } from "../core/prompt";
import type { AskFollowUpRequest, AskFollowUpResponse } from "../core/types";

const log = createLogger("gemini-session");
const STREAM_PATH =
  "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
/** Zero-based index of the temporary-chat flag in the inner request array. */
const TEMPORARY_CHAT_INDEX = 45;
const INNER_LENGTH = 99;
/**
 * Fixed fields the Gemini web app sends with every prompt. Without them the
 * model answers with a canned "I encountered an error" reply (HTTP 200).
 */
const UI_FIELDS: Record<number, unknown> = {
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
  98: 1,
};
const SESSION_HELP =
  "Gemini session unavailable — reload gemini.google.com (and sign in if needed), then try again.";

interface PageTokens {
  /** SNlM0e — only present when signed in. */
  at: string;
  /** cfb2h build label. */
  bl: string;
  /** FdrFJe session id. */
  sid: string;
  /** Multi-account prefix such as "/u/1", or "". */
  prefix: string;
}

function pickToken(source: string, key: string): string {
  const match = source.match(
    new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`)
  );
  if (!match) return "";
  try {
    return JSON.parse(match[1]!);
  } catch {
    return "";
  }
}

function tokensFrom(source: string, prefix: string): PageTokens | null {
  const bl = pickToken(source, "cfb2h");
  if (!bl) return null;
  return {
    at: pickToken(source, "SNlM0e"),
    bl,
    sid: pickToken(source, "FdrFJe"),
    prefix,
  };
}

async function getPageTokens(signal?: AbortSignal): Promise<PageTokens> {
  const prefix = location.pathname.match(/^\/u\/\d+/)?.[0] ?? "";
  for (const script of Array.from(document.scripts)) {
    const text = script.textContent ?? "";
    if (!text.includes("cfb2h")) continue;
    const tokens = tokensFrom(text, prefix);
    if (tokens) return tokens;
  }
  // Page scripts can be replaced after hydration; the app shell still has them.
  const res = await fetch(`${prefix}/app`, {
    credentials: "include",
    signal,
  });
  const tokens = res.ok ? tokensFrom(await res.text(), prefix) : null;
  if (!tokens) throw new Error(SESSION_HELP);
  return tokens;
}

type Continuation = [string, string, string] | [string, string];

async function streamGenerate(
  prompt: string,
  continuation: Continuation | null,
  onPartial?: (text: string) => void
): Promise<{
  reply: string;
  conversationId?: string;
  responseId?: string;
  candidateId?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    return await streamGenerateWithSignal(
      prompt,
      continuation,
      controller.signal,
      onPartial
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        "Gemini did not finish replying within 60 seconds. Reload Gemini and try again."
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function streamGenerateWithSignal(
  prompt: string,
  continuation: Continuation | null,
  signal: AbortSignal,
  onPartial?: (text: string) => void
): Promise<{
  reply: string;
  conversationId?: string;
  responseId?: string;
  candidateId?: string;
}> {
  const tokens = await getPageTokens(signal);
  const lang = navigator.language || "en-US";

  const inner: unknown[] = new Array(INNER_LENGTH).fill(null);
  for (const [index, value] of Object.entries(UI_FIELDS)) {
    inner[Number(index)] = value;
  }
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = [lang];
  if (continuation) inner[2] = continuation;
  inner[TEMPORARY_CHAT_INDEX] = 1;
  inner[59] = crypto.randomUUID().toUpperCase();

  const body = new URLSearchParams({
    "f.req": JSON.stringify([null, JSON.stringify(inner)]),
  });
  if (tokens.at) body.set("at", tokens.at);

  const query = new URLSearchParams({
    bl: tokens.bl,
    "f.sid": tokens.sid,
    hl: document.documentElement.lang || lang,
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: "c",
  });

  const res = await fetch(`${tokens.prefix}${STREAM_PATH}?${query}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "X-Same-Domain": "1",
    },
    body,
    signal,
  });
  if (!res.ok) {
    log.error(`StreamGenerate → HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new Error(SESSION_HELP);
    if (res.status === 429) {
      throw new Error("Gemini usage limit reached for now — try again later.");
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
  if (!reply) {
    throw new Error(
      "Gemini returned no readable reply. Its web request or response format may have changed; report this error with extension version 0.2.4."
    );
  }
  log.debug(`Reply received (${reply.length} chars)`);
  return {
    reply,
    conversationId: state.conversationId,
    responseId: state.responseId,
    candidateId: state.candidateId,
  };
}

export async function completeViaGeminiSession(
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  try {
    const promptArgs = {
      quotedText: req.quotedText,
      surroundingContext: req.surroundingContext,
      conversationExcerpt: req.conversationExcerpt,
      question: req.question,
      siteName: "Gemini",
    };

    const toResponse = (r: Awaited<ReturnType<typeof streamGenerate>>) => ({
      ok: true,
      reply: r.reply,
      sideConversationId: r.conversationId,
      sideParentMessageId: r.responseId,
      sideMeta: r.candidateId ? { candidateId: r.candidateId } : undefined,
    });

    if (req.sideConversationId && req.sideParentMessageId) {
      const continuation: Continuation = req.sideMeta?.candidateId
        ? [req.sideConversationId, req.sideParentMessageId, req.sideMeta.candidateId]
        : [req.sideConversationId, req.sideParentMessageId];
      try {
        return toResponse(
          await streamGenerate(buildFollowUpPrompt(promptArgs), continuation, onPartial)
        );
      } catch (err) {
        if (
          err instanceof Error &&
          /within 60 seconds/.test(err.message)
        ) {
          throw err;
        }
        log.debug("Could not continue side chat; starting a fresh one", err);
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
    log.error("complete failed:", message);
    return { ok: false, error: message };
  }
}
