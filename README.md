# AI Chat Threads

Chrome extension (Manifest V3) that lets you highlight text in an AI reply, open a sidebar thread about just that snippet, and keep highlights two-way linked with thread cards. Threads persist per conversation via `chrome.storage.local`.

Works on:

- [chatgpt.com](https://chatgpt.com)
- [claude.ai](https://claude.ai)
- [gemini.google.com](https://gemini.google.com)

Each site answers sidebar questions through **your own logged-in session** on that site. No API keys are needed.

## Share with a friend (no npm)

Download the prebuilt zip from the repo:

- [`releases/ai-helper-v0.2.5-store.zip`](./releases/ai-helper-v0.2.5-store.zip) (Chrome Web Store package)
- Or the same build unpacked: load `extension/dist` after `npm run build`

Chrome Web Store publish steps (icons, privacy policy, listing copy): see [`docs/CHROME_WEB_STORE.md`](./docs/CHROME_WEB_STORE.md).

Then:

1. Unzip — you should see `manifest.json`, `content.js`, `service-worker.js`, and an `icons/` folder
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the unzipped folder
5. Open/refresh ChatGPT, Claude, or Gemini while logged in

When a new zip is published, replace the folder contents, click **Reload** on the extension card, and refresh your chat tabs.

## Install, reload, and debug (any OS)

### Which folder to load

**Load unpacked** must point at the folder that directly contains `manifest.json` **and** `content.js`:

| You have | Load this folder |
| --- | --- |
| The release zip | The unzipped folder (the one with `manifest.json` inside) |
| A clone of the repo | `extension/dist` — after running the build |

Do **not** load `extension/` itself. It has a `manifest.json` but no compiled `content.js`, so Chrome loads it without error and the extension silently does nothing. On macOS, also make sure you picked the inner folder if Archive Utility nested the folder.

The version on the `chrome://extensions` card should match the zip name (e.g. `0.2.5`).

### Build from source

```bash
npm install
npm run build        # outputs extension/dist
```

Requires Node 18+. Works the same on Windows, macOS, and Linux.

### Reload after changes

1. `chrome://extensions` → click the **Reload** (circular arrow) icon on the AI Chat Threads card.
2. Refresh every open ChatGPT, Claude, and Gemini tab. Old tabs keep running the previous copy and will log "Extension was reloaded — refresh this tab".

### Turn on debug logging

Debug logs are off by default, and the setting is per site. To turn them on, open DevTools on a chat tab (**F12** on Windows/Linux, **Cmd + Option + I** on macOS), and run this in the Console:

```js
localStorage.setItem("ai-helper:debug", "1"); location.reload();
```

All extension logs start with `[ai-helper]`, followed by a scope such as `[claude-adapter]`, `[storage]`, or `[gemini-session]`. To turn logging off again:

```js
localStorage.removeItem("ai-helper:debug"); location.reload();
```

(For developers: `DEBUG_DEFAULT` in `extension/core/log.ts` forces it on for every build.)

### Run diagnostics

On a chat tab, run this in the Console:

```js
document.dispatchEvent(new Event("ai-helper:diagnostics"));
```

It prints a JSON report covering:
- extension version and build time
- OS and Chrome version
- current URL and conversation id
- whether the page elements the extension depends on were found (per selector)
- whether the sidebar and Ask button are present
- a storage summary: thread counts and 40-character quote previews only, no reply text or tokens

If nothing prints, the content script isn't running. Check which folder was loaded, then reload the extension and the tab.

If you switch the Console's context dropdown from `top` to **AI Chat Threads**, you can call `aiHelperDiagnostics()` directly instead.

## Publish updates automatically

Pushes to `main` build, test, and submit new versions to the Chrome Web Store. Run `npm run release:bump` before committing a release. Google publishes the update after review. See [automatic release instructions](docs/AUTOMATED_RELEASES.md).

## Develop

For rebuild-on-change: `npm run watch`, then click Reload on the extension card and refresh your chat tabs.

Tests:

```bash
npx tsc --noEmit
npm run test:sse
npm run test:chatgpt-stream # Completion, interruptions, and WebSocket handoff
npm run test:streams     # Claude and Gemini stream parsers
npm run test:browser     # Chrome/Chromium UI checks; set CHROME_PATH if needed
node tests/text-clean.test.mjs
```

## Offset harness (no ChatGPT required)

Open `tests/anchor-harness.html` in a browser. Select text in the fake message, click **Ask about this**, and confirm marks are re-rendered from stored character offsets.

## Architecture

- `extension/core/` — site-agnostic engine (anchors, sidebar Shadow DOM, storage, logging, diagnostics)
- `extension/adapters/` — per-site DOM hooks. `dom-adapter.ts` holds the shared logic; `chatgpt.ts`, `claude.ts`, and `gemini.ts` are mostly selectors.
- `extension/content-scripts/inject.ts` — picks adapter by hostname and boots the engine
- `extension/background/{chatgpt,claude,gemini}-session.ts` — unofficial session clients (they run inside the content script, despite the folder name)
- `extension/background/service-worker.ts` — routing point reserved for future official-API providers

Follow-ups run entirely in the content script (same-origin cookies, no service-worker round trip). After ChatGPT’s stream handoff, the extension recovers the answer over the turn WebSocket.

## Unofficial sessions (current follow-up path)

Sidebar questions use **your logged-in session** on the site you're on, not an API key:

- Each highlight thread uses a **temporary** side chat, so answers don't appear in the site's history and don't get mixed into your real chat:
  - ChatGPT: a temporary conversation.
  - Claude: an incognito conversation.
  - Gemini: a temporary chat.
- Follow-ups in a thread continue that side chat when the site still allows it. Otherwise a fresh temporary chat is started and the thread's earlier Q&A is resent, so the answer keeps its context.
- This is **unofficial / ToS-grey**. Endpoints, auth, and anti-abuse checks change without notice, so expect breakage.
- Failures surface in the sidebar and as `[ai-helper][<site>-session]` errors in DevTools (enable debug logging for the full trace).
- Not a substitute for an official API if you later ship this to paying customers at scale.

Per-site notes:

- **Claude** needs you to be logged in. Usage counts against your normal Claude plan limits. In Claude's own incognito chats the URL stays `/new`, so threads there are only kept until you start another incognito chat.
- **Gemini** works signed in (a guest session also works while Google allows it). If Google changes its request format, Gemini may answer with a generic "I encountered an error" message instead of failing outright. That means the extension needs an update.
- **ChatGPT** behaves as before.
