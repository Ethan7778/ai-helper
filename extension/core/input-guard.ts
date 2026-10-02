/**
 * Stop ChatGPT/Claude/Gemini page handlers from stealing keystrokes
 * typed into the sidebar composer (Shadow DOM events still bubble to the
 * document in some hosts).
 */
export const SIDEBAR_HOST_ID = "ai-helper-sidebar-host";
export const SIDEBAR_KEY_EVENT = "ai-helper:composer-keydown";

export function installSidebarInputGuard(): () => void {
  const guard = (event: Event) => {
    const path = event.composedPath();
    if (
      !path.some(
        (node) => node instanceof HTMLElement && node.id === SIDEBAR_HOST_ID
      )
    ) {
      return;
    }
    const target = path[0];
    if (!(target instanceof HTMLTextAreaElement)) return;
    event.stopImmediatePropagation();
    if (event.type === "keydown") {
      target.dispatchEvent(
        new CustomEvent(SIDEBAR_KEY_EVENT, { detail: event })
      );
    }
  };

  const types = ["keydown", "keypress", "keyup"] as const;
  for (const type of types) window.addEventListener(type, guard, true);
  return () => {
    for (const type of types) window.removeEventListener(type, guard, true);
  };
}
