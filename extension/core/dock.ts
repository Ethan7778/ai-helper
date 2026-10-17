/**
 * Makes room for the sidebar by shrinking the host page instead of covering it.
 *
 * The page's <body> is narrowed by the panel width and given `contain: layout`,
 * which makes it the containing block for the site's own `position: fixed`
 * chrome (headers, composers, popovers), so those shrink with it. The sidebar
 * host therefore lives on <html>, outside <body>.
 *
 * The CSS only exists while docked and is installed two ways: as an adopted
 * stylesheet (not a DOM node, so frameworks that own <html> can't strip it)
 * and as a <style> fallback that is restored as soon as the page removes it.
 */

export const DOCK_WIDTH_VAR = "--ai-helper-dock-w";
const STYLE_ID = "ai-helper-dock-style";

export const SIDEBAR_DEFAULT_WIDTH = 380;
export const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_MAX_FRACTION = 0.5;
/** The chat site always keeps at least this much width while docked. */
const MIN_PAGE_WIDTH = 560;
/** Marks elements whose inline width we capped, so undocking can restore them. */
const CAPPED_ATTR = "data-ai-helper-capped";
const CAP_PROPS = ["width", "min-width", "max-width"] as const;
const CAP_SCAN_DEPTH = 12;

let dockedWidth = 0;
let visibleSidebarWidth = 0;

export function clampSidebarWidth(width: number): number {
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      window.innerWidth * SIDEBAR_MAX_FRACTION,
      window.innerWidth - MIN_PAGE_WIDTH
    )
  );
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** Below this the chat would be crushed; the panel overlays instead. */
export function canDock(): boolean {
  return window.innerWidth >= SIDEBAR_MIN_WIDTH + MIN_PAGE_WIDTH;
}

export function isDocked(): boolean {
  return dockedWidth > 0;
}

/** Right edge of the page area not covered by the sidebar, in viewport px. */
export function pageRightEdge(): number {
  return window.innerWidth - visibleSidebarWidth;
}

function dockCss(width: number, fixups: readonly string[]): string {
  return `
html {
  ${DOCK_WIDTH_VAR}: ${width}px;
  overflow-x: hidden !important;
}
html > body {
  width: calc(100vw - ${width}px) !important;
  min-width: 0 !important;
  max-width: none !important;
  margin-right: 0 !important;
  overflow-x: clip !important;
  contain: layout !important;
}
html > body > * {
  max-width: 100% !important;
}
${fixups.join("\n")}
`;
}

export class Dock {
  private docked = false;
  private width = SIDEBAR_DEFAULT_WIDTH;
  private sheet: CSSStyleSheet | null = null;
  private style: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  /** Times the page removed our fallback <style> (diagnostics). */
  externalRemovals = 0;

  constructor(private readonly fixups: readonly string[] = []) {}

  /** Dock (or undock) at `width`. Returns whether the page is now docked. */
  apply(open: boolean, width: number): boolean {
    const widthChanged = width !== this.width;
    this.width = width;
    // The floating Ask button must also avoid a sidebar that overlays a narrow page.
    visibleSidebarWidth = open ? Math.min(width, window.innerWidth) : 0;
    const shouldDock = open && canDock();
    if (shouldDock) {
      if (!this.docked || widthChanged) this.install();
    } else if (this.docked) {
      this.uninstall();
    }
    const changed = shouldDock !== this.docked;
    this.docked = shouldDock;
    dockedWidth = shouldDock ? width : 0;
    if (changed || (shouldDock && widthChanged)) this.notifyResize();
    return shouldDock;
  }

  /** Restore our style if the page removed it, and re-fit new wide wrappers. */
  reassert(): void {
    if (!this.docked) return;
    if (this.sheet && !document.adoptedStyleSheets.includes(this.sheet)) {
      this.adoptSheet();
    }
    if (!this.style?.isConnected) {
      this.externalRemovals++;
      this.install();
      this.notifyResize();
    }
    this.capViewportWide();
  }

  /**
   * Some site wrappers are sized to the viewport (`100vw`, `100dvw`), which
   * ignores the narrowed <body>. Find them by measurement, descending only into
   * elements that run under the panel or have content spilling out of them,
   * and cap them to their parent.
   */
  private capViewportWide(): void {
    if (!this.docked || !document.body) return;
    const edge = pageRightEdge();
    let level: Element[] = Array.from(document.body.children);
    for (let depth = 0; depth < CAP_SCAN_DEPTH && level.length; depth++) {
      const next: Element[] = [];
      for (const el of level) {
        if (!(el instanceof HTMLElement) || el.id === "ai-helper-sidebar-host") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4) continue;
        if (rect.right <= edge + 1) {
          // Fits, but a descendant may still spill past it.
          if (el.scrollWidth > el.clientWidth + 1) next.push(...Array.from(el.children));
          continue;
        }
        if (Math.abs(rect.width - window.innerWidth) <= 2 && !el.hasAttribute(CAPPED_ATTR)) {
          const saved: Record<string, [string, string]> = {};
          for (const prop of CAP_PROPS) {
            saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
          }
          el.setAttribute(CAPPED_ATTR, JSON.stringify(saved));
          el.style.setProperty("width", "100%", "important");
          el.style.setProperty("min-width", "0", "important");
          el.style.setProperty("max-width", "100%", "important");
          this.cappedCount++;
          if (el.getBoundingClientRect().right <= edge + 1) continue;
        }
        next.push(...Array.from(el.children));
      }
      level = next;
    }
  }

  private restoreCapped(): void {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${CAPPED_ATTR}]`))) {
      try {
        const saved = JSON.parse(el.getAttribute(CAPPED_ATTR) || "{}") as Record<
          string,
          [string, string]
        >;
        for (const prop of CAP_PROPS) {
          const [value, priority] = saved[prop] ?? ["", ""];
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        }
      } catch {
        for (const prop of CAP_PROPS) el.style.removeProperty(prop);
      }
      el.removeAttribute(CAPPED_ATTR);
    }
  }

  /** Wrappers capped so far (diagnostics). */
  private cappedCount = 0;

  describe(): Record<string, unknown> {
    return {
      docked: this.docked,
      width: this.width,
      adoptedSheet: Boolean(this.sheet && document.adoptedStyleSheets.includes(this.sheet)),
      styleElement: Boolean(this.style?.isConnected),
      externalRemovals: this.externalRemovals,
      cappedWrappers: this.cappedCount,
    };
  }

  private install(): void {
    const css = dockCss(this.width, this.fixups);
    try {
      if (!this.sheet) this.sheet = new CSSStyleSheet();
      this.sheet.replaceSync(css);
      this.adoptSheet();
    } catch {
      this.sheet = null;
    }
    if (!this.style) {
      this.style =
        (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ??
        document.createElement("style");
      this.style.id = STYLE_ID;
    }
    this.style.textContent = css;
    if (!this.style.isConnected) document.documentElement.appendChild(this.style);
    this.watch();
  }

  private adoptSheet(): void {
    if (!this.sheet) return;
    try {
      if (!document.adoptedStyleSheets.includes(this.sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
      }
    } catch {
      this.sheet = null;
    }
  }

  private uninstall(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.sheet) {
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (s) => s !== this.sheet
        );
      } catch {
        // Nothing to remove.
      }
    }
    this.style?.remove();
    this.restoreCapped();
  }

  /** Put the fallback <style> back right away if the page strips <html>. */
  private watch(): void {
    if (this.observer) return;
    this.observer = new MutationObserver(() => {
      if (this.docked && !this.style?.isConnected) this.reassert();
    });
    this.observer.observe(document.documentElement, { childList: true });
    if (document.head) this.observer.observe(document.head, { childList: true });
  }

  private resizeQueued = false;

  /** Let the site's JS layout (virtualized lists, textareas) re-measure. */
  private notifyResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      window.dispatchEvent(new Event("resize"));
      this.capViewportWide();
    });
  }
}

/** Layout facts for the diagnostics report when docking looks wrong. */
export function dockReport(): Record<string, unknown> {
  const docked = isDocked();
  const edge = pageRightEdge();
  const overflowing: string[] = [];
  if (docked) {
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.right <= edge + 1) continue;
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > edge + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none") continue;
      overflowing.push(
        `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}"> ${cs.position} width=${cs.width} right=${Math.round(r.right)}`
      );
      if (overflowing.length >= 8) break;
    }
  }
  const bodyStyle = getComputedStyle(document.body);
  return {
    docked,
    canDock: canDock(),
    viewportWidth: window.innerWidth,
    pageRightEdge: Math.round(edge),
    bodyWidth: Math.round(document.body.getBoundingClientRect().width),
    bodyContain: bodyStyle.contain,
    overflowing,
  };
}
