# Sidebar media and readability update

## Changes

- GFM Markdown: tables, nested lists, fenced and indented code, blockquotes, links, headings, and in-progress fences. Preserves indentation. Raw HTML is shown as text; output is sanitized.
- Bundled syntax colors for common programming languages. Unknown languages retain plain code. Wide code and tables scroll horizontally.
- Attach up to three pictures with the + button, paste, or drop onto the composer. PNG, JPEG, WebP, GIF; 10 MB per input; GIFs become a still frame. Pictures are resized to a maximum 2048 px dimension and encoded as PNG. Oversized outputs are reduced further or rejected. Preview/remove controls, attachment-only questions, upload errors and draft recovery.
- Pictures go to the AI site used by that thread only when Send is pressed. ChatGPT uses its signed upload protocol; Claude uses organization uploads; Gemini uses its content-push upload service. No API key, new manifest permission, or remote JavaScript added.
- Only small thumbnails and image names are saved to extension storage. Original pixels remain in memory until upload. Provider-side history supplies picture context on later replies. Expired conversations require reattaching pictures rather than silently falling back to text-only context.
- Text size: seven stops (12–18 px), with 15 px as the middle default, under Appearance, applied immediately to message text, quotes and code, saved across tabs/sessions. Navigation controls keep their own sizing.
- Underlines: retain scroll-ancestor clipping; split around covering page elements; composer mask includes its outer gutter and extends to the bottom of the viewport. Header/dialog occlusion is also checked.

## Verification

Passed: TypeScript, production build, text-clean regression tests, SSE tests, ChatGPT stream interruption tests, provider parser tests, store-publish tests, new readability/media tests.
New tests cover rendered Markdown structure, sanitization, syntax colors, all three upload request shapes, generation requests carrying image references, paste/preview/remove/send, failed-send draft recovery, saved text size, covering elements and composer masking.

Live browser tests were blocked by the execution environment (Chromium could not start; browser policy blocked local-file preview). Provider tests use mocked responses. Signed-in ChatGPT/Claude/Gemini picture uploads have NOT been verified end to end. Their web upload protocols are unofficial and can change independently. Test those on a feature branch before releasing.

The supplied formatting screenshot exposed ChatGPT `:::writing{...}` wrappers. These now render as a titled writing card, including partial streamed cards; literal wrapper examples inside code stay literal. Your coworker's LaTeX/MathML rendering and inline-code protection from main bd1e4e5 are preserved. AI image generation is not part of this update.

## Local acceptance checks before release

1. Disable your store copy temporarily while testing the unpacked build, so only one copy runs. Load `extension/dist` at chrome://extensions, then refresh each AI tab.
2. Ask for Python, JavaScript, and C++ examples; check colors, indentation, unclosed streaming fences, and horizontal code scrolling.
3. Ask for a table, nested list and quoted note; resize the sidebar narrow and wide.
4. Set text size to 12, 15 and 18; reopen Settings, reload the page, and open another tab. Check the saved size, code and composer.
5. On EACH AI site, attach a harmless test picture with text and ask what it says. Test file selection, paste, drop, removal, an image-only send and three pictures. Confirm AI content actually matches the image. Reopen the thread and ask a follow-up referring to it.
6. Test unsupported SVG/PDF and an image over 10 MB; expect a useful message with the draft retained. Verify a failed upload retains pictures and question.
7. Underline text, scroll it behind the top header and bottom composer, type enough lines to grow the composer, resize/open/close the sidebar, zoom, and return to the highlight. The underline must disappear where covered and return with the text.
8. Confirm ChatGPT's earlier interrupted-stream fix still gives complete replies or a visible error.
