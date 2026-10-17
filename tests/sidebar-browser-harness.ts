import { Sidebar, HOST_ID } from '../extension/core/sidebar';
import { wrapHighlightsInPlace } from '../extension/core/anchor';
import type { Thread } from '../extension/core/types';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run() {
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  const makeThread = (id: string): Thread => ({
    id, messageId: 'message', anchorStart: 0, anchorEnd: 6,
    quotedText: `Quote ${id}`, replies: [{ role: 'user', text: 'Saved question', ts: 1 }],
  });
  let threads = [makeThread('first'), makeThread('second')];
  const deleted: string[] = [];
  const sidebar = new Sidebar({
    onFocusThread() {},
    onDeleteThread(id) {
      deleted.push(id);
      threads = threads.filter(thread => thread.id !== id);
      sidebar.setThreads(threads);
    },
    onSend: async () => ({ ok: true }),
    onAppearanceChange() {}, onAnswerLengthChange() {}, onSummaryChange() {},
  });
  sidebar.setThreads(threads);
  const shadow = document.getElementById(HOST_ID)!.shadowRoot!;
  const click = (selector: string) => {
    const target = shadow.querySelector<HTMLElement>(selector);
    check(target, `Missing ${selector}`);
    target.click();
  };
  const focusedComposer = () => shadow.activeElement === shadow.querySelector('textarea');
  sidebar.focusThread('first');
  await wait(300);
  check(focusedComposer(), 'Opening a highlighted thread must focus the composer');

  click('.delete-thread');
  check(deleted.length === 0, 'Trash must not delete immediately');
  check(shadow.querySelector('dialog')?.open, 'Trash must open a modal confirmation');
  await wait(300);
  check(shadow.activeElement?.classList.contains('cancel-delete'), 'Cancel must stay focused while confirmation is open');
  click('.cancel-delete');
  check(deleted.length === 0 && !shadow.querySelector('dialog'), 'Cancel must retain the thread');

  click('.delete-thread');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  check(deleted.length === 0 && !shadow.querySelector('dialog'), 'Escape must cancel deletion');
  check(sidebar.describe().collapsed === false, 'Escape from confirmation must keep the sidebar open');

  click('.delete-thread');
  sidebar.setThreads([...threads]); // Background refresh while confirming.
  check(shadow.querySelector('dialog')?.open, 'A rerender must preserve confirmation');
  click('.cancel-delete');
  check(shadow.activeElement?.classList.contains('delete-thread'), 'Cancel must restore focus after a rerender');

  click('[aria-label="Back to threads"]');
  click('.row .delete-thread');
  check(deleted.length === 0, 'List trash must also wait for confirmation');
  click('.cancel-delete');
  click('.row');
  await wait(300);
  check(focusedComposer(), 'Clicking a thread row must focus the composer');

  click('.quote-block');
  await wait(300);
  check(focusedComposer(), 'Clicking the thread quote must focus the composer');

  const highlight = document.createElement('button');
  highlight.textContent = 'Open highlighted thread';
  highlight.addEventListener('click', () => sidebar.focusThread('second'));
  document.body.appendChild(highlight);
  document.addEventListener('click', () => outside.focus(), { once: true });
  highlight.click();
  await wait(300);
  check(focusedComposer(), 'Composer must regain focus after a host click handler');

  sidebar.focusThread('first');
  outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  outside.focus();
  await wait(300);
  check(document.activeElement === outside, 'A later user click must cancel pending composer focus');

  sidebar.focusThread('first');
  shadow.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
  const settingsButton = shadow.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!;
  settingsButton.focus();
  await wait(300);
  check(shadow.activeElement === settingsButton, 'Keyboard navigation must cancel pending composer focus');

  sidebar.focusThread('second');
  click('.delete-thread');
  click('.confirm-delete');
  check(deleted.length === 1 && deleted[0] === 'second', 'Confirmation must delete exactly the selected thread');

  const message = document.createElement('div');
  message.textContent = '0123456789';
  document.body.appendChild(message);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    for (let i = 0; i < 2; i++) wrapHighlightsInPlace(message, [
      { id: 'a', anchorStart: 0, anchorEnd: 6 },
      { id: 'b', anchorStart: 4, anchorEnd: 9 },
    ]);
  } finally {
    console.warn = originalWarn;
  }
  check(warnings.length === 0, 'Expected overlap recovery must not produce extension warnings');
  check(message.textContent === '0123456789', 'Overlap recovery must preserve message text');
  sidebar.destroy();
  document.getElementById('result')!.textContent = 'PASS: delete confirmation, cancel, Escape, rerenders, list deletion, composer focus, host focus recovery, user focus choice, overlap recovery';
}

run().catch(error => {
  document.getElementById('result')!.textContent = `FAIL: ${error.stack ?? error}`;
});
