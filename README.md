# AI Helper — Highlight to Thread

Chrome extension (Manifest V3) that lets you highlight text in an AI reply, open a sidebar thread about just that snippet, and keep highlights two-way linked with thread cards. Threads persist per conversation via `chrome.storage.local`.

## Share with a friend (no npm)

Download the prebuilt zip from the repo:

- [`releases/ai-helper-v0.1.0.zip`](./releases/ai-helper-v0.1.0.zip)

Then:

1. Unzip — you should see `manifest.json`, `content.js`, and `service-worker.js`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the unzipped folder
5. Open/refresh [chatgpt.com](https://chatgpt.com) while logged in

When a new zip is published, replace the folder contents, click **Reload** on the extension card, and refresh ChatGPT.

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

After rebuilding, reload both the extension card **and** any open `chatgpt.com` tabs.

## Offset harness (no ChatGPT required)

Open `tests/anchor-harness.html` in a browser. Select text in the fake message, click **Ask about this**, and confirm marks are re-rendered from stored character offsets.

## Architecture

- `extension/core/` — site-agnostic engine (anchors, sidebar Shadow DOM, storage)
- `extension/adapters/` — per-site DOM hooks (ChatGPT first)
- `extension/content-scripts/inject.ts` — picks adapter by hostname, boots the engine, answers session-token requests
- `extension/background/service-worker.ts` — handles `ask-follow-up` and talks to ChatGPT via the unofficial session client

Follow-up calls enter the service worker, then run in the content script (same-origin cookies). After ChatGPT’s stream handoff, the extension recovers the answer over the turn WebSocket (with conversation polling as fallback).

## Unofficial ChatGPT session (current follow-up path)

Sidebar questions use **your logged-in ChatGPT session**, not an OpenAI API key:

- Each highlight thread gets its own side conversation (main chat UI is not injected into).
- Side conversations are **persisted** (needed for handoff recovery) and may appear in ChatGPT history.
- This is **unofficial / ToS-grey**. Endpoints, auth, and the sentinel/proof-of-work gate change without notice — expect breakage.
- Failures should surface in the sidebar and as `[ai-helper][chatgpt-session]` logs in DevTools.
- Local SSE fixture tests: `npm run test:sse`
- Not a substitute for an official API if you later ship this to paying customers at scale.
