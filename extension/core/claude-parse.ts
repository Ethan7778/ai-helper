/**
 * Incremental parser for claude.ai's completion SSE stream
 * (message_start / content_block_* / message_delta / message_stop / error).
 */
export interface ClaudeStreamState {
  buffer: string;
  text: string;
  /** Assistant message uuid — the parent for the next turn. */
  assistantUuid?: string;
  error?: string;
  done: boolean;
  /** Index of the text block currently being appended to. */
  textBlock?: number;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return { buffer: "", text: "", done: false };
}

interface ClaudeEvent {
  type?: string;
  index?: number;
  message?: { uuid?: string; id?: string };
  content_block?: { type?: string; text?: string };
  delta?: { type?: string; text?: string };
  completion?: string;
  error?: { type?: string; message?: string };
}

/** Feed raw stream text; returns true if the reply text changed. */
export function feedClaudeStream(state: ClaudeStreamState, chunk: string): boolean {
  // Normalize the whole buffer: a CRLF can be split across two chunks.
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

/** Flush a final event that wasn't followed by a blank line. */
export function finishClaudeStream(state: ClaudeStreamState): void {
  if (state.buffer.trim()) handleBlock(state, state.buffer);
  state.buffer = "";
}

function handleBlock(state: ClaudeStreamState, block: string): void {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;

  let ev: ClaudeEvent;
  try {
    ev = JSON.parse(data) as ClaudeEvent;
  } catch {
    return;
  }

  switch (ev.type) {
    case "message_start":
      state.assistantUuid = ev.message?.uuid ?? state.assistantUuid;
      break;
    case "content_block_start":
      if (ev.content_block?.type === "text") {
        // Separate text blocks split by tool use so words don't run together.
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
      // Legacy (pre-Messages) stream shape.
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
