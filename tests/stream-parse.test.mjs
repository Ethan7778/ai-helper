import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const dir = mkdtempSync(join(tmpdir(), "ai-helper-stream-parse-"));

async function load(entry, name) {
  const outfile = join(dir, `${name}.mjs`);
  buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    outfile,
    platform: "neutral",
  });
  return import(pathToFileURL(outfile).href);
}

const claude = await load("extension/core/claude-parse.ts", "claude-parse");
const gemini = await load("extension/core/gemini-parse.ts", "gemini-parse");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Feed text in small uneven slices to exercise buffering across chunks. */
function feedInPieces(feed, state, text, size = 7) {
  let changes = 0;
  for (let i = 0; i < text.length; i += size) {
    if (feed(state, text.slice(i, i + size))) changes++;
  }
  return changes;
}

// --- Claude ---------------------------------------------------------------

const sse = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

const claudeStream =
  sse("message_start", {
    type: "message_start",
    message: { id: "chatcompl_1", uuid: "01a0f0ae-e4b0-7b3d-96f4-c196d63ad6c3", role: "assistant" },
  }) +
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Rayleigh " } }) +
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "scattering." } }) +
  sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
  sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "web_search" } }) +
  sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }) +
  sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "KIWI7" } }) +
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  sse("message_limit", { type: "message_limit", message_limit: { type: "within_limit" } }) +
  "event: ping\r\ndata: not-json\r\n\r\n" +
  `event: message_stop\r\ndata: {"type":"message_stop"}`;

{
  const state = claude.createClaudeStreamState();
  const changes = feedInPieces(claude.feedClaudeStream, state, claudeStream);
  claude.finishClaudeStream(state);
  assert(changes >= 2, `Claude: expected streaming updates, got ${changes}`);
  assert(
    state.text === "Rayleigh scattering.\n\nKIWI7",
    `Claude: unexpected text ${JSON.stringify(state.text)}`
  );
  assert(state.assistantUuid === "01a0f0ae-e4b0-7b3d-96f4-c196d63ad6c3", "Claude: assistant uuid");
  assert(state.done, "Claude: message_stop in the final unterminated block");
  assert(!state.error, "Claude: no error expected");
}

{
  const state = claude.createClaudeStreamState();
  claude.feedClaudeStream(
    state,
    sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
  );
  assert(state.error === "Overloaded", `Claude: error message, got ${state.error}`);
}

{
  const state = claude.createClaudeStreamState();
  claude.feedClaudeStream(state, sse("completion", { type: "completion", completion: "legacy text" }));
  assert(state.text === "legacy text", "Claude: legacy completion events");
}

// --- Gemini ---------------------------------------------------------------

function geminiFrame(text, { cid = "c_405e1d39ff488d1c", rid = "r_4568cf3993e9297b", rcid = "rc_5b403b8f12e7397c" } = {}) {
  const payload = [null, [cid, rid], null, null, [[rcid, [text], null, null]]];
  const line = JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]]);
  return `${line.length}\n${line}\n`;
}

const geminiStream =
  ")]}'\n\n" +
  geminiFrame("Rayleigh scattering is") +
  geminiFrame("Rayleigh scattering is the process [cite_start]by which light scatters.[cite: 1]") +
  `25\n[["di",123],["af.httprm",123,"x",1]]\n` +
  // A trailing metadata frame without reply text must not wipe the reply.
  `${JSON.stringify([["wrb.fr", null, JSON.stringify([null, ["c_405e1d39ff488d1c", "r_4568cf3993e9297b"]])]])}`;

{
  const state = gemini.createGeminiStreamState();
  const changes = feedInPieces(gemini.feedGeminiStream, state, geminiStream, 11);
  gemini.finishGeminiStream(state);
  assert(changes === 2, `Gemini: expected 2 text updates, got ${changes}`);
  assert(state.conversationId === "c_405e1d39ff488d1c", "Gemini: conversation id");
  assert(state.responseId === "r_4568cf3993e9297b", "Gemini: response id");
  assert(state.candidateId === "rc_5b403b8f12e7397c", "Gemini: candidate id");
  const cleaned = gemini.cleanGeminiText(state.text);
  assert(
    cleaned === "Rayleigh scattering is the process by which light scatters.",
    `Gemini: unexpected text ${JSON.stringify(cleaned)}`
  );
  assert(!state.error, "Gemini: no error expected");
}

{
  const state = gemini.createGeminiStreamState();
  const errorLine = JSON.stringify([
    ["wrb.fr", null, null, null, null, [8, null, [["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo", [1037]]]]],
  ]);
  gemini.feedGeminiStream(state, `)]}'\n\n${errorLine.length}\n${errorLine}\n`);
  assert(/usage limit/.test(state.error ?? ""), `Gemini: error code mapping, got ${state.error}`);
}

{
  const cleaned = gemini.cleanGeminiText(
    "Here is a chart http://googleusercontent.com/image_generation_content/0 \nDone."
  );
  assert(cleaned === "Here is a chart\nDone.", `Gemini: media placeholder, got ${JSON.stringify(cleaned)}`);
}

rmSync(dir, { recursive: true, force: true });
console.log("stream-parse tests passed");
