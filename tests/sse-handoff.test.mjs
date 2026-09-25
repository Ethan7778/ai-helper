/**
 * Node tests for ChatGPT SSE handoff parsing (no Chrome required).
 *
 * Run: npm run test:sse
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "..", "extension", "core", "sse-parse.ts");
const source = readFileSync(srcPath, "utf8");
const { code } = transformSync(source, {
  loader: "ts",
  format: "cjs",
  target: "node18",
});
const require = createRequire(import.meta.url);
const modulePath = join(__dirname, ".sse-parse.generated.cjs");
writeFileSync(modulePath, code);
const {
  parseConversationSseText,
  extractLatestAssistantFromConversation,
} = require(modulePath);
unlinkSync(modulePath);

function test(name, fn) {
  try {
    fn();
    console.log(`ok — ${name}`);
  } catch (err) {
    console.error(`FAIL — ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test("detects resume_conversation_token handoff and conversation id", () => {
  // Mirrors the empty-reply log the extension hits on chatgpt.com today.
  const raw = [
    "event: delta_encoding",
    'data: "v1"',
    "",
    'data: {"type":"resume_conversation_token","kind":"topic","token":"eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0dXJuX3RvcGljX2lkIjoiY29udmVyc2F0aW9uLXR1cm4tYWJjMTIzIn0.sig","conversation_id":"conv-123"}',
    "",
    'data: {"type":"stream_handoff","conversation_id":"conv-123","options":[{"type":"subscribe_ws_topic","topic_id":"conversation-turn-abc123"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseConversationSseText(raw);
  assert.equal(parsed.reply, "");
  assert.equal(parsed.conversationId, "conv-123");
  assert.equal(parsed.handedOff, true);
  assert.equal(parsed.topicId, "conversation-turn-abc123");
  assert.ok(parsed.eventTypes.includes("resume_conversation_token"));
  assert.ok(parsed.eventTypes.includes("stream_handoff"));
});

test("still parses classic assistant message envelopes", () => {
  const raw = [
    'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello"]}},"conversation_id":"c1"}',
    "data: [DONE]",
  ].join("\n");
  const parsed = parseConversationSseText(raw);
  assert.equal(parsed.reply, "Hello");
  assert.equal(parsed.conversationId, "c1");
  assert.equal(parsed.handedOff, false);
});

test("parses delta v1 append patches", () => {
  const raw = [
    'data: {"v":{"message":{"id":"m2","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hi"]}}}}',
    'data: {"p":"/message/content/parts/0","o":"append","v":" there"}',
    'data: {"v":"!"}',
    "data: [DONE]",
  ].join("\n");
  const parsed = parseConversationSseText(raw);
  assert.equal(parsed.reply, "Hi there!");
});

test("extracts finished assistant from conversation mapping", () => {
  const detail = {
    mapping: {
      a: {
        message: {
          id: "u1",
          author: { role: "user" },
          create_time: 1,
          content: { parts: ["q"] },
        },
      },
      b: {
        message: {
          id: "a1",
          author: { role: "assistant" },
          status: "finished_successfully",
          create_time: 2,
          content: { content_type: "text", parts: ["Final answer"] },
        },
      },
    },
  };
  const found = extractLatestAssistantFromConversation(detail);
  assert.ok(found);
  assert.equal(found.text, "Final answer");
  assert.equal(found.messageId, "a1");
  assert.equal(found.status, "finished_successfully");
});

if (!process.exitCode) {
  console.log("\nAll SSE handoff tests passed.");
} else {
  console.log("\nSSE handoff tests finished with failures.");
}
