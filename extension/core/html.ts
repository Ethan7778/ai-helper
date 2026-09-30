interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createHTML: (s: string) => string }
  ): { createHTML: (s: string) => unknown };
}

let policy: { createHTML: (s: string) => unknown } | null | undefined;

function getPolicy() {
  if (policy !== undefined) return policy;
  const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  try {
    // Only ever fed strings we built and escaped ourselves.
    policy = tt ? tt.createPolicy("ai-helper", { createHTML: (s) => s }) : null;
  } catch {
    policy = null;
  }
  return policy;
}

/**
 * innerHTML that also works on pages enforcing Trusted Types
 * (gemini.google.com sends `require-trusted-types-for 'script'`).
 */
export function setHtml(target: Element | ShadowRoot, html: string): void {
  const p = getPolicy();
  (target as { innerHTML: unknown }).innerHTML = p ? p.createHTML(html) : html;
}
