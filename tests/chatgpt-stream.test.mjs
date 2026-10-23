import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { outputFiles } = buildSync({
  entryPoints: ['extension/background/chatgpt-session.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false,
});
const module = { exports: {} };
let scenario;
let sockets = 0;
class FakeWebSocket {
  constructor() {
    sockets++;
    queueMicrotask(() => this.onopen?.());
  }
  send() { scenario(this); }
  close() { this.closed = true; }
  receive(frame) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) }); }
  disconnect() { if (!this.closed) this.onclose?.({ code: 1006, reason: 'test disconnect' }); }
}
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, TextDecoder, TextEncoder, Uint8Array, Buffer,
  URL, atob, btoa, WebSocket: FakeWebSocket,
  fetch: async () => ({ ok: true, json: async () => ({ websocket_url: 'wss://example.test/stream' }) }),
});
const { recoverViaWebSocket, parseConversationStream } = module.exports;
const message = (text, status = 'in_progress') => ({
  message: { id: 'assistant-1', author: { role: 'assistant' }, channel: 'final', status,
    content: { content_type: 'text', parts: [text] } },
});
const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const recover = (onPartial, timeout = 1000, initial = '') => recoverViaWebSocket('test-token', 'test-agent', 'test-topic', onPartial, timeout, initial);
async function test(name, fn) {
  try { await fn(); console.log(`ok — ${name}`); }
  catch (error) { console.error(`FAIL — ${name}`, error); process.exitCode = 1; }
}

await test('final channel is not completion: wait for the full finished message', async () => {
  scenario = socket => {
    socket.receive(message('The answer starts'));
    setTimeout(() => socket.receive(message('The answer starts and ends completely.', 'finished_successfully')), 5);
  };
  const result = await recover();
  assert.equal(result.reply, 'The answer starts and ends completely.');
});

await test('direct status-only completion keeps all preceding text', async () => {
  scenario = socket => {
    socket.receive(message('Full answer.'));
    socket.receive(message('', 'finished_successfully'));
  };
  assert.equal((await recover()).reply, 'Full answer.');
});

await test('a finished snapshot can correct a longer draft', async () => {
  scenario = socket => {
    socket.receive(message('A long draft that needs correction.'));
    socket.receive(message('Correct answer.', 'finished_successfully'));
  };
  assert.equal((await recover()).reply, 'Correct answer.');
});

await test('a dropped connection must not turn partial text into a successful answer', async () => {
  scenario = socket => { socket.receive(message('Half a sentence')); socket.disconnect(); };
  await assert.rejects(recover(), /interrupted before it finished/);
});

await test('an idle timeout must not turn partial text into success', async () => {
  scenario = socket => socket.receive(message('Half a sentence'));
  await assert.rejects(recover(undefined, 15), /interrupted before it finished/);
});

await test('active long replies extend the idle deadline', async () => {
  scenario = socket => {
    for (let i = 0; i < 5; i++) setTimeout(() => socket.receive(message('Word '.repeat(i + 1), i === 4 ? 'finished_successfully' : 'in_progress')), i * 15);
  };
  assert.equal((await recover(undefined, 40)).reply, 'Word '.repeat(5));
});

await test('WebSocket append deltas preserve the HTTP prefix and catchups apply once', async () => {
  const initial = sse(message('Hello')) + sse({ type: 'stream_handoff' }) + 'data: [DONE]\n\n';
  scenario = socket => {
    socket.receive({ type: 'reply', reply: { catchups: [{ encoded_item: sse({ p: '/message/content/parts/0', o: 'append', v: ' there' }) }] } });
    socket.receive({ encoded_item: sse({ type: 'message_stream_complete' }) });
  };
  assert.equal((await recover(undefined, 1000, initial)).reply, 'Hello there');
});

await test('encoded status patches finish without requiring a separate DONE marker', async () => {
  scenario = socket => socket.receive({ encoded_item: sse(message('Complete answer.')) + sse({ p: '/message/status', o: 'replace', v: 'finished_successfully' }) });
  assert.equal((await recover()).reply, 'Complete answer.');
});

await test('encoded appends can continue a direct message snapshot', async () => {
  scenario = socket => {
    socket.receive(message('Hello'));
    socket.receive({ encoded_item: sse({ p: '/message/content/parts/0', o: 'append', v: ' world.' }) + 'data: [DONE]\n\n' });
  };
  assert.equal((await recover()).reply, 'Hello world.');
});

const response = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
await test('failed handoff recovery never falls back to a buffered HTTP partial', async () => {
  scenario = socket => socket.disconnect();
  const raw = sse(message('Just a partial')) + sse({ type: 'stream_handoff', options: [{ type: 'subscribe_ws_topic', topic_id: 'test-topic' }] }) + 'data: [DONE]\n\n';
  await assert.rejects(parseConversationStream(response(raw), 'token', 'agent'), /Handoff recovery failed/);
});

await test('missing handoff topic never presents a partial as complete', async () => {
  const before = sockets;
  const raw = sse(message('Just a partial')) + sse({ type: 'stream_handoff' }) + 'data: [DONE]\n\n';
  await assert.rejects(parseConversationStream(response(raw), 'token', 'agent'), /without a topic id/);
  assert.equal(sockets, before);
});

await test('an unexpectedly ended HTTP stream is an interruption', async () => {
  await assert.rejects(parseConversationStream(response(sse(message('Just a partial'))), 'token', 'agent'), /interrupted before it finished/);
});

await test('completed inline answer survives a handoff without a topic', async () => {
  const before = sockets;
  const raw = sse(message('Complete answer.', 'finished_successfully')) +
    sse({ type: 'stream_handoff' }) + 'data: [DONE]\n\n';
  const result = await parseConversationStream(response(raw), 'token', 'agent');
  assert.equal(result.reply, 'Complete answer.');
  assert.equal(sockets, before);
});

await test('reasoning completion cannot authorize a topicless partial answer', async () => {
  const raw = sse(message('Partial answer')) + sse({ message: {
    id: 'reasoning', author: { role: 'assistant' }, channel: 'analysis',
    content: { parts: ['Thinking'] },
  } }) + sse({ p: '/message/status', o: 'replace', v: 'finished_successfully' }) +
    sse({ type: 'stream_handoff' }) + 'data: [DONE]\n\n';
  await assert.rejects(parseConversationStream(response(raw), 'token', 'agent'), /without a topic id/);
});

await test('normal completed HTTP streams still return the full answer', async () => {
  const result = await parseConversationStream(response(sse(message('Complete answer.')) + 'data: [DONE]\n\n'), 'token', 'agent');
  assert.equal(result.reply, 'Complete answer.');
});
