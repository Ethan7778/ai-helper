import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const item = 'publishers/38cbcfb3-234f-4337-a439-cbedbae55013/items/anafheflkkjibeckbafcmikiecgnpmdj';
const api = `https://chromewebstore.googleapis.com/v2/${item}`;

function versionParts(version) {
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) {
    throw new Error(`Invalid Chrome version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) {
    throw new Error(`Invalid Chrome version: ${version}`);
  }
  return Array.from({ length: 4 }, (_, i) => parts[i] ?? 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

export async function publishExtension({
  token,
  version,
  readZip,
  request = fetch,
  sleep = setTimeout,
  report = console.log,
}) {
  if (!token) throw new Error('CWS_ACCESS_TOKEN is required. Run this through GitHub Actions.');
  versionParts(version);

  async function call(url, options = {}) {
    const response = await request(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Chrome Web Store API (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  const status = await call(`${api}:fetchStatus`);
  const published = status.publishedItemRevisionStatus?.distributionChannels ?? [];
  if (published.some(channel => compareVersions(channel.crxVersion, version) >= 0)) {
    report(`Skipped: version ${version} is already published or older than the store version. Run npm run release:bump before your next release.`);
    return 'skipped';
  }

  const submitted = status.submittedItemRevisionStatus;
  if (submitted?.state === 'PENDING_REVIEW' || submitted?.state === 'STAGED') {
    const sameVersion = submitted.distributionChannels?.some(channel => compareVersions(channel.crxVersion, version) === 0);
    if (submitted.state === 'PENDING_REVIEW' && sameVersion) {
      report(`Skipped: version ${version} is already awaiting review.`);
      return 'skipped';
    }
    throw new Error(`An existing submission is ${submitted.state}. Resolve it in the Developer Dashboard before submitting another update.`);
  }

  const upload = await call(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: readZip(),
  });
  let uploadState = upload.uploadState;
  for (let attempt = 0; uploadState === 'IN_PROGRESS' || uploadState === 'UPLOAD_IN_PROGRESS'; attempt++) {
    if (attempt >= 30) throw new Error('Upload processing timed out. Check the Developer Dashboard before retrying.');
    await sleep(10_000);
    const processing = await call(`${api}:fetchStatus`);
    uploadState = processing.lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`Upload did not succeed: ${uploadState ?? 'missing upload state'}. Check the Developer Dashboard.`);
  }

  const result = await call(`${api}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(result.state)) {
    throw new Error(`Unexpected submission result: ${JSON.stringify(result)}`);
  }
  report(`Version ${version} submitted. Store state: ${result.state}. It will publish automatically after approval.`);
  if (result.warningInfo) report(`Store warnings: ${JSON.stringify(result.warningInfo)}`);
  return 'submitted';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version } = JSON.parse(readFileSync('extension/dist/manifest.json', 'utf8'));
    await publishExtension({
      token: process.env.CWS_ACCESS_TOKEN,
      version,
      readZip: () => {
        if (!process.env.CWS_ZIP_PATH) throw new Error('CWS_ZIP_PATH is required.');
        return readFileSync(process.env.CWS_ZIP_PATH);
      },
      report: message => {
        console.log(message);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
      },
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
