/**
 * Incremental parser for Gemini's StreamGenerate response:
 * `)]}'` prefix, then length-prefixed lines, each a JSON array like
 * [["wrb.fr", null, "<inner JSON string>"]]. Each frame carries the full
 * reply text so far, not a delta.
 */
export interface GeminiStreamState {
  buffer: string;
  text: string;
  /** Continuation ids for the next turn in the same (temporary) chat. */
  conversationId?: string;
  responseId?: string;
  candidateId?: string;
  error?: string;
}

export function createGeminiStreamState(): GeminiStreamState {
  return { buffer: "", text: "" };
}

const ERROR_MESSAGES: Record<number, string> = {
  1013: "Gemini had a temporary error — try again.",
  1037: "Gemini usage limit reached for now — try again later.",
  1050: "Gemini rejected the model selection — reload gemini.google.com and try again.",
  1060: "Gemini temporarily blocked requests from this network — try again later.",
};

/** Feed raw response text; returns true if the reply text changed. */
export function feedGeminiStream(state: GeminiStreamState, chunk: string): boolean {
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

export function finishGeminiStream(state: GeminiStreamState): void {
  const line = state.buffer.trim();
  if (line.startsWith("[")) handleLine(state, line);
  state.buffer = "";
}

function handleLine(state: GeminiStreamState, line: string): void {
  let frames: unknown;
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

    let payload: unknown;
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

/** Error frames look like [8, null, [["...BardErrorInfo", [1037]]]]. */
function findErrorCode(node: unknown, depth = 0): number | null {
  if (depth > 6 || !Array.isArray(node)) return null;
  for (const item of node) {
    if (typeof item === "number" && item >= 1000 && item < 10000) return item;
    const nested = findErrorCode(item, depth + 1);
    if (nested != null) return nested;
  }
  return null;
}

/** Drop Gemini citation markers and media placeholders from reply text. */
export function cleanGeminiText(text: string): string {
  return text
    .replace(/\[cite(?:_start|_end)?(?::[^\]]*)?\]/g, "")
    .replace(/https?:\/\/googleusercontent\.com\/\S+/g, "")
    .replace(/[^\S\n]+\n/g, "\n")
    .trim();
}
