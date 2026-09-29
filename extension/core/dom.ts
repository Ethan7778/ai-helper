/** First element matching any selector, in selector priority order. */
export function queryFirst(
  selectors: readonly string[],
  root: ParentNode = document
): HTMLElement | null {
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Resolve once an element matching any selector exists, or null after timeoutMs.
 * Never rejects, so callers can fall back gracefully.
 */
export function waitForElement(
  selectors: readonly string[],
  timeoutMs: number
): Promise<HTMLElement | null> {
  const found = queryFirst(selectors);
  if (found) return Promise.resolve(found);

  return new Promise((resolve) => {
    let done = false;
    const finish = (el: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const observer = new MutationObserver(() => {
      const el = queryFirst(selectors);
      if (el) finish(el);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Run `fn` at most once per animation frame, with the latest arguments. */
export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void
): ((...args: A) => void) & { cancel: () => void } {
  let frame = 0;
  let lastArgs: A | null = null;
  const throttled = (...args: A) => {
    lastArgs = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (lastArgs) fn(...lastArgs);
    });
  };
  throttled.cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  return throttled;
}
