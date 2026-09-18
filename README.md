# AI Helper — Highlight to Thread

Chrome extension (Manifest V3) that lets you highlight text in an AI reply, open a sidebar thread about just that snippet, and keep highlights two-way linked with thread cards. Threads persist per conversation via `chrome.storage.local`.

## Develop

```bash
npm install
npm run build
```

Load the built extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`

For rebuild-on-change: `npm run watch`, then click Reload on the extension card.

## Offset harness (no ChatGPT required)

Open `tests/anchor-harness.html` in a browser. Select text in the fake message, click **Ask about this**, and confirm marks are re-rendered from stored character offsets.

## Architecture

- `extension/core/` — site-agnostic engine (anchors, sidebar Shadow DOM, storage)
- `extension/adapters/` — per-site DOM hooks (ChatGPT first)
- `extension/content-scripts/inject.ts` — picks adapter by hostname and boots the engine
- `extension/background/service-worker.ts` — receives ask-follow-up messages (stub reply for now)

Follow-up API calls must stay in the service worker, not the content script.
