# AI Helper — Highlight to Thread

Chrome extension (Manifest V3) that lets you highlight text in an AI reply, open a sidebar thread about just that snippet, and keep highlights two-way linked with thread cards. Threads persist per conversation via `chrome.storage.local`.

## Share with a friend (no npm)

Download the prebuilt zip from the repo:

- [`releases/ai-helper-v0.1.1.zip`](./releases/ai-helper-v0.1.1.zip)

Then:

1. Unzip — you should see `manifest.json`, `content.js`, and `service-worker.js`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the unzipped folder
5. Open/refresh [chatgpt.com](https://chatgpt.com) while logged in

When a new zip is published, replace the folder contents, click **Reload** on the extension card, and refresh ChatGPT.

## Install, reload, and debug (any OS)

### Which folder to load

**Load unpacked** must point at the folder that directly contains `manifest.json` **and** `content.js`:

| You have | Load this folder |
| --- | --- |
| The release zip | The unzipped folder (the one with `manifest.json` inside) |
| A clone of the repo | `extension/dist` — after running the build |

Do **not** load `extension/` itself. It has a `manifest.json` but no compiled `content.js`, so Chrome loads it without error and the extension silently does nothing. On macOS, also make sure you picked the inner folder if Archive Utility created `ai-helper-v0.1.1/ai-helper-v0.1.1/`.

The version on the `chrome://extensions` card should match the zip name (e.g. `0.1.1`).

### Build from source

```bash
npm install
npm run build        # outputs extension/dist
```

Requires Node 18+. Works the same on Windows, macOS, and Linux.

### Reload after changes

1. `chrome://extensions` → click the **Reload** (circular arrow) icon on the AI Helper card.
2. Refresh every open `chatgpt.com` tab. Old tabs keep running the previous copy and will log "Extension was reloaded — refresh this ChatGPT tab".

### Turn on debug logging

Debug logs are off by default. To turn them on for chatgpt.com, open DevTools on a ChatGPT tab (**F12** on Windows/Linux, **Cmd + Option + I** on macOS), and run this in the Console:

```js
localStorage.setItem("ai-helper:debug", "1"); location.reload();
```

All extension logs start with `[ai-helper]`, followed by a scope such as `[chatgpt-adapter]`, `[storage]`, or `[chatgpt-session]`. To turn logging off again:

```js
localStorage.removeItem("ai-helper:debug"); location.reload();
```

(For developers: `DEBUG_DEFAULT` in `extension/core/log.ts` forces it on for every build.)

### Run diagnostics

On a ChatGPT tab, run this in the Console:

```js
document.dispatchEvent(new Event("ai-helper:diagnostics"));
```

It prints a JSON report covering:
- extension version and build time
- OS and Chrome version
- current URL and conversation id
- whether the ChatGPT DOM elements the extension depends on were found (per selector)
- whether the sidebar and Ask button are present
- a storage summary: thread counts and 40-character quote previews only, no reply text or tokens

If nothing prints, the content script isn't running. Check which folder was loaded, then reload the extension and the tab.

If you switch the Console's context dropdown from `top` to **AI Helper — Highlight to Thread**, you can call `aiHelperDiagnostics()` directly instead.

## Develop

For rebuild-on-change: `npm run watch`, then click Reload on the extension card and refresh ChatGPT tabs.

Tests:

```bash
npx tsc --noEmit
npm run test:sse
node tests/text-clean.test.mjs
```

## Offset harness (no ChatGPT required)

Open `tests/anchor-harness.html` in a browser. Select text in the fake message, click **Ask about this**, and confirm marks are re-rendered from stored character offsets.

## Architecture

- `extension/core/` — site-agnostic engine (anchors, sidebar Shadow DOM, storage, logging, diagnostics)
- `extension/adapters/` — per-site DOM hooks (ChatGPT first)
- `extension/content-scripts/inject.ts` — picks adapter by hostname and boots the engine
- `extension/background/chatgpt-session.ts` — unofficial ChatGPT session client (runs inside the content script)
- `extension/background/service-worker.ts` — routing point reserved for future non-ChatGPT providers

ChatGPT follow-ups run entirely in the content script (same-origin cookies, no service-worker round trip). After ChatGPT’s stream handoff, the extension recovers the answer over the turn WebSocket.

## Unofficial ChatGPT session (current follow-up path)

Sidebar questions use **your logged-in ChatGPT session**, not an OpenAI API key:

- Each highlight thread uses a **temporary** side conversation so answers don’t appear in ChatGPT’s main history (and don’t get confused with your real chat).
- Follow-ups in a thread reuse that side conversation when ChatGPT still allows it; otherwise a fresh temporary turn is started.
- This is **unofficial / ToS-grey**. Endpoints, auth, and the sentinel/proof-of-work gate change without notice — expect breakage.
- Failures surface in the sidebar and as `[ai-helper][chatgpt-session]` errors in DevTools (enable debug logging for the full trace).
- Local SSE fixture tests: `npm run test:sse`
- Not a substitute for an official API if you later ship this to paying customers at scale.
