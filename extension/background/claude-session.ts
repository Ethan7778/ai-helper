/**
 * claude.ai unofficial session client. Runs in the content script so the
 * user's claude.ai cookies are same-origin. Side chats are created as
 * incognito (`is_temporary`) so they never appear in the Claude sidebar.
 */
import {
  createClaudeStreamState,
  feedClaudeStream,
  finishClaudeStream,
} from "../core/claude-parse";
import { createLogger } from "../core/log";
import { buildFollowUpPrompt } from "../core/prompt";
import type { AskFollowUpRequest, AskFollowUpResponse } from "../core/types";

const log = createLogger("claude-session");
const API = "https://claude.ai/api";
const SESSION_HELP =
  "Claude session unavailable — make sure you're logged in on claude.ai, then try again.";

let cachedOrgId: string | null = null;

class ClaudeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function claudeFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.ok) return res;

  const detail = await res.text().catch(() => "");
  log.error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}`, detail.slice(0, 300));
  if (res.status === 401 || res.status === 403) {
    throw new ClaudeHttpError(SESSION_HELP, res.status);
  }
  if (res.status === 429) {
    throw new ClaudeHttpError(
      "Claude usage limit reached for now — try again later.",
      res.status
    );
  }
  throw new ClaudeHttpError(`Claude request failed (HTTP ${res.status}).`, res.status);
}

async function getOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const orgs = (await (await claudeFetch("/organizations")).json()) as {
    uuid?: string;
    capabilities?: string[];
  }[];
  const org =
    orgs.find((o) => o.capabilities?.includes("chat")) ?? orgs[0];
  if (!org?.uuid) throw new Error(SESSION_HELP);
  cachedOrgId = org.uuid;
  log.debug(`Using organization ${org.uuid}`);
  return org.uuid;
}

async function createTemporaryConversation(orgId: string): Promise<string> {
  const uuid = crypto.randomUUID();
  const res = await claudeFetch(`/organizations/${orgId}/chat_conversations`, {
    method: "POST",
    body: JSON.stringify({ uuid, name: "", is_temporary: true }),
  });
  const conv = (await res.json()) as { uuid?: string; is_temporary?: boolean };
  if (conv.is_temporary === false) {
    log.warn("Claude created a non-temporary conversation; it may appear in history.");
  }
  return conv.uuid ?? uuid;
}

async function streamCompletion(
  orgId: string,
  conversationId: string,
  prompt: string,
  parentMessageUuid: string | undefined,
  onPartial?: (text: string) => void
): Promise<{ reply: string; assistantUuid?: string }> {
  const body: Record<string, unknown> = {
    prompt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    locale: navigator.language || "en-US",
    attachments: [],
    files: [],
    rendering_mode: "messages",
  };
  if (parentMessageUuid) body.parent_message_uuid = parentMessageUuid;

  const res = await claudeFetch(
    `/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
    {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify(body),
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
  log.debug(`Reply received (${state.text.length} chars)`);
  return { reply: state.text, assistantUuid: state.assistantUuid };
}

export async function completeViaClaudeSession(
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  try {
    const orgId = req.sideMeta?.orgId || (await getOrgId());
    const promptArgs = {
      quotedText: req.quotedText,
      surroundingContext: req.surroundingContext,
      conversationExcerpt: req.conversationExcerpt,
      question: req.question,
      siteName: "Claude",
    };

    if (req.sideConversationId && req.sideParentMessageId) {
      try {
        const r = await streamCompletion(
          orgId,
          req.sideConversationId,
          buildFollowUpPrompt(promptArgs),
          req.sideParentMessageId,
          onPartial
        );
        return {
          ok: true,
          reply: r.reply,
          sideConversationId: req.sideConversationId,
          sideParentMessageId: r.assistantUuid ?? req.sideParentMessageId,
          sideMeta: { orgId },
        };
      } catch (err) {
        // Temporary chats expire; auth and rate limits won't be fixed by retrying.
        if (err instanceof ClaudeHttpError && [401, 403, 429].includes(err.status)) {
          throw err;
        }
        log.debug("Could not continue side chat; starting a fresh one", err);
      }
    }

    const conversationId = await createTemporaryConversation(orgId);
    const r = await streamCompletion(
      orgId,
      conversationId,
      buildFollowUpPrompt({ ...promptArgs, priorTurns: req.priorTurns }),
      undefined,
      onPartial
    );
    return {
      ok: true,
      reply: r.reply,
      sideConversationId: conversationId,
      sideParentMessageId: r.assistantUuid,
      sideMeta: { orgId },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("complete failed:", message);
    return { ok: false, error: message };
  }
}
