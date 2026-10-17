import assert from 'node:assert/strict';
import test from 'node:test';
import { publishExtension } from '../scripts/publish-extension.mjs';

function harness(responses, version = '0.2.6') {
  const calls = [];
  const messages = [];
  const run = () => publishExtension({
    token: 'test-token', version,
    readZip: () => Buffer.from('test zip'),
    sleep: async () => {},
    report: message => messages.push(message),
    request: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length, 'Unexpected API request');
      const next = responses.shift();
      return { ok: !next.error, status: next.error ?? 200, json: async () => next.body ?? next };
    },
  });
  return { run, calls, messages };
}

const published = version => ({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: version }] } });

test('uploads the zip and requests automatic publication after review', async () => {
  const h = harness([published('0.2.5'), { uploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  assert.equal(await h.run(), 'submitted');
  assert.match(h.calls[1].url, /\/upload\/v2\/publishers\/38cbcfb3-234f-4337-a439-cbedbae55013\/items\/anafheflkkjibeckbafcmikiecgnpmdj:upload$/);
  assert.equal(h.calls[1].headers['Content-Type'], 'application/zip');
  assert.equal(h.calls[1].headers.Authorization, 'Bearer test-token');
  assert.equal(h.calls[1].body.toString(), 'test zip');
  assert.deepEqual(JSON.parse(h.calls[2].body), { publishType: 'DEFAULT_PUBLISH' });
});

test('polls asynchronous upload processing before submitting', async () => {
  const h = harness([published('0.2.5'), { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  assert.equal(await h.run(), 'submitted');
  assert.equal(h.calls.length, 5);
  assert.match(h.calls[3].url, /:fetchStatus$/);
  assert.match(h.calls[4].url, /:publish$/);
});

test('compares numeric version components and skips already published versions', async () => {
  for (const [store, local] of [['0.2.6', '0.2.6'], ['0.2.10', '0.2.9'], ['0.2.6.0', '0.2.6']]) {
    const h = harness([published(store)], local);
    assert.equal(await h.run(), 'skipped');
    assert.equal(h.calls.length, 1);
  }
});

test('skips a version already in review without uploading again', async () => {
  const h = harness([{ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.2.6' }] } }]);
  assert.equal(await h.run(), 'skipped');
  assert.equal(h.calls.length, 1);
});

test('protects a different pending review or staged submission', async () => {
  for (const state of ['PENDING_REVIEW', 'STAGED']) {
    const h = harness([{ submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: '0.2.5' }] } }]);
    await assert.rejects(h.run, /existing submission/);
    assert.equal(h.calls.length, 1);
  }
});

test('failed or unknown uploads are never submitted', async () => {
  for (const state of ['FAILED', undefined]) {
    const h = harness([{}, { uploadState: state }]);
    await assert.rejects(h.run, /Upload did not succeed/);
    assert.equal(h.calls.length, 2);
  }
});

test('stops polling after the upload processing timeout', async () => {
  const h = harness([{}, { uploadState: 'IN_PROGRESS' }, ...Array.from({ length: 30 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
  await assert.rejects(h.run, /timed out/);
  assert.equal(h.calls.filter(call => call.url.endsWith(':publish')).length, 0);
});

test('reports API errors without continuing', async () => {
  const h = harness([{ error: 403, body: { error: { message: 'Permission denied' } } }]);
  await assert.rejects(h.run, /403.*Permission denied/);
  assert.equal(h.calls.length, 1);
});

test('rejects invalid versions before making requests', async () => {
  for (const version of ['0.0.0', '0.2.65536', '01.2.3', '0.2.6-beta']) {
    const h = harness([], version);
    await assert.rejects(h.run, /Invalid Chrome version/);
    assert.equal(h.calls.length, 0);
  }
});
