# Chrome Web Store — publish checklist

Use this when submitting **ai chat threads**.

## Rename the existing extension

The store title comes from `name` in `extension/manifest.json`. Release a new package through the existing listing to update the name in Chrome and the store after review. In the Developer Dashboard's **Store listing** tab, also update the detailed description below to use ai chat threads. Publish the updated privacy policy at its existing URL. Keep using the existing extension ID and listing.

## Package ready in this repo

- Store zip: [`releases/ai-helper-v0.2.5-store.zip`](../releases/ai-helper-v0.2.5-store.zip)
- Icons: `icons/icon16.png`, `icon48.png`, `icon128.png` (included in the zip)
- Privacy policy (host this URL in the dashboard):  
  after GitHub Pages / raw hosting is set up, point at  
  `https://ethan7778.github.io/ai-helper/privacy.html`  
  or open [`docs/privacy.html`](./privacy.html) locally and host it anywhere public.

To enable GitHub Pages for the policy:

1. Repo **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/docs`
4. After it publishes, the privacy URL is  
   `https://ethan7778.github.io/ai-helper/privacy.html`

## Developer account

1. Open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Pay the one-time $5 registration fee if you have not already
3. **New item** → upload `releases/ai-helper-v0.2.5-store.zip`

## Listing copy (paste into the dashboard)

### Short description (≤132 characters)

```
Highlight text in ChatGPT, Claude, or Gemini and ask follow-ups in a sidebar thread — without cluttering the main chat.
```

### Detailed description

```
ai chat threads lets you highlight any part of an assistant reply on ChatGPT, Claude, or Gemini and open a focused sidebar thread about just that snippet.

How it works
• Select text in a reply and click “Ask about this”
• Type your follow-up in the sidebar
• Answers stream into that thread, using your existing logged-in session on the site you’re on
• Side chats are temporary so they stay out of the site’s main history
• Threads are saved locally in your browser and stay linked to the highlight

Supported sites
• chatgpt.com
• claude.ai
• gemini.google.com

No API keys. No separate ai chat threads account. Your questions are handled through the chat site you already use.

Notes
• This is an unofficial helper that talks to each site the same way your browser session does. Site changes can break it until we update.
• Usage counts against your normal plan limits on those sites.
```

### Category

Productivity

### Language

English

## Privacy practices (dashboard answers)

| Question | Suggested answer |
| --- | --- |
| Single purpose | Highlight text in AI chat replies and ask follow-ups in a sidebar thread |
| Remote code | No |
| Collects user data | Yes — quotes/questions stored locally; sent only to the host chat site when you ask |
| Sold to third parties | No |
| Used for creditworthiness | No |
| Transfer for purposes other than listed | No |
| Host permissions justification | Content script and session requests must run on ChatGPT, Claude, and Gemini pages |
| `storage` justification | Persist highlight threads on the user’s device |

## Screenshots you still need to capture

Chrome requires at least **one** screenshot (1280×800 or 640×400). Capture these on a logged-in tab:

1. Highlight + black **Ask about this** pill on a ChatGPT/Claude/Gemini reply  
2. Sidebar open with a thread and streamed answer  
3. Optional: accordion / Threads tab on the right edge  

Save them under `docs/store-screenshots/` (create the folder) before uploading — they are not generated automatically.

## After upload

1. Attach screenshots and the privacy policy URL  
2. Set visibility (Public / Unlisted / Private)  
3. Submit for review  

First review often takes several days. If they ask about host permissions or how answers are generated, use the privacy policy wording: answers go through the user’s logged-in session on those three sites; nothing is sent to an ai chat threads server.

