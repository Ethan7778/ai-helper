/** Draw one underline per visual text line, even across mixed inline fonts. */
const SVG_NS = "http://www.w3.org/2000/svg";
let requestLayout: (() => void) | undefined;

const EDITOR_SELECTOR = 'textarea,[role="textbox"],[contenteditable="true"],[contenteditable="plaintext-only"],dialog[open],[role="dialog"],[aria-modal="true"]';
const MARK_SELECTOR = 'mark[data-thread-id][data-ai-helper-underline]';

/** Find the editor's painted panel, stopping before the conversation itself. */
function editorPanel(editor: HTMLElement): HTMLElement {
  let panel = editor;
  const editorHeight = editor.getBoundingClientRect().height;
  for (let parent = editor.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (parent.querySelector(MARK_SELECTOR)) break;
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    // A full-screen, transparent portal can contain a small bottom composer.
    // Keep the mask on the actual panel instead of covering the whole page.
    if (bounds.height > Math.max(editorHeight + 64, innerHeight * 0.65)) continue;
    const painted = style.backgroundImage !== 'none' || (style.backgroundColor !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)/.test(style.backgroundColor));
    if (parent.tagName === 'FORM' || parent.tagName === 'FOOTER' || style.position === 'fixed' || style.position === 'sticky' || painted) panel = parent;
  }
  return panel;
}

function visiblePanelRects(editors: HTMLElement[]): { x: number; y: number; width: number; height: number }[] {
  const panels = new Set<HTMLElement>();
  for (const editor of editors) {
    if (!editor.isConnected || editor.closest(MARK_SELECTOR) || editor.querySelector(MARK_SELECTOR)) continue;
    const rect = editor.getBoundingClientRect();
    const style = getComputedStyle(editor);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) continue;
    const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const panel = editorPanel(editor);
    const hit = document.elementFromPoint(x, y);
    if (hit && panel.contains(hit)) panels.add(panel);
  }
  return Array.from(panels).flatMap(panel => {
    const r = panel.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const width = Math.min(innerWidth, r.right) - x, height = Math.min(innerHeight, r.bottom) - y;
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  });
}

export function scheduleUnderlineLayout(): void { requestLayout?.(); }

export function installUnderlineLayer(): () => void {
  const layer = document.createElementNS(SVG_NS, "svg");
  layer.dataset.aiHelperUnderlines = "1";
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:9998;";
  document.documentElement.appendChild(layer);
  let frame = 0;
  let disposed = false;
  let marksDirty = true;
  let marks: HTMLElement[] = [];
  let editors: HTMLElement[] = [];
  let clippingParents = new WeakMap<HTMLElement, { element: HTMLElement; x: boolean; y: boolean }[]>();
  const maskId = `ai-helper-underline-mask-${Math.random().toString(36).slice(2)}`;
  let previousGeometry = "";
  const render = () => {
    frame = 0;
    if (disposed || document.hidden) return;
    if (!layer.isConnected) document.documentElement.appendChild(layer);
    if (marksDirty) {
      marks = Array.from(document.querySelectorAll<HTMLElement>(MARK_SELECTOR));
      editors = Array.from(document.querySelectorAll<HTMLElement>(EDITOR_SELECTOR));
      clippingParents = new WeakMap();
      marksDirty = false;
    }
    marks = marks.filter(mark => mark.isConnected && mark.hasAttribute("data-ai-helper-underline"));
    const threads = new Map<string, { color: string; width: number; rects: DOMRect[] }>();
    const ancestorRects = new Map<HTMLElement, DOMRect>();
    for (const mark of marks) {
      const id = mark.dataset.threadId!;
      let group = threads.get(id);
      if (!group) {
        group = { color: mark.dataset.aiHelperUnderline!, width: 2, rects: [] };
        threads.set(id, group);
      }
      group.width = Math.max(group.width, Number(mark.style.getPropertyValue("--ai-helper-underline-width")) || 2);
      let ancestors = clippingParents.get(mark);
      if (!ancestors) {
        ancestors = [];
        for (let parent = mark.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
          const y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
          if ((x || y) && parent.clientWidth && parent.clientHeight) ancestors.push({ element: parent, x, y });
        }
        clippingParents.set(mark, ancestors);
      }
      let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
      for (const ancestor of ancestors) {
        let r = ancestorRects.get(ancestor.element);
        if (!r) { r = ancestor.element.getBoundingClientRect(); ancestorRects.set(ancestor.element, r); }
        const scaleX = r.width / (ancestor.element.offsetWidth || r.width || 1);
        const scaleY = r.height / (ancestor.element.offsetHeight || r.height || 1);
        const x = r.left + ancestor.element.clientLeft * scaleX;
        const y = r.top + ancestor.element.clientTop * scaleY;
        if (ancestor.x) { left = Math.max(left, x); right = Math.min(right, x + ancestor.element.clientWidth * scaleX); }
        if (ancestor.y) { top = Math.max(top, y); bottom = Math.min(bottom, y + ancestor.element.clientHeight * scaleY); }
      }
      for (const rect of mark.getClientRects()) {
        const x = Math.max(left, rect.left), end = Math.min(right, rect.right);
        const baseline = Math.round(rect.bottom) + 1;
        if (end > x && rect.height > 0 && baseline - group.width / 2 >= top && baseline + group.width / 2 <= bottom) {
          group.rects.push(new DOMRect(x, rect.top, end - x, rect.height));
        }
      }
    }
    const geometry: { id: string; left: number; right: number; y: number; color: string; width: number }[] = [];
    for (const [id, group] of threads) {
      const rows: { top: number; bottom: number; rects: DOMRect[] }[] = [];
      for (const rect of group.rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
        const center = (rect.top + rect.bottom) / 2;
        const row = rows.find(row => Math.abs((row.top + row.bottom) / 2 - center) < Math.min(row.bottom - row.top, rect.height) * 0.65);
        if (row) {
          row.top = Math.min(row.top, rect.top); row.bottom = Math.max(row.bottom, rect.bottom); row.rects.push(rect);
        } else rows.push({ top: rect.top, bottom: rect.bottom, rects: [rect] });
      }
      for (const row of rows) {
        const spans: { left: number; right: number }[] = [];
        for (const rect of row.rects.sort((a, b) => a.left - b.left)) {
          const last = spans[spans.length - 1];
          if (last && rect.left - last.right <= 8) last.right = Math.max(last.right, rect.right);
          else spans.push({ left: rect.left, right: rect.right });
        }
        for (const span of spans) {
          geometry.push({ id, left: span.left, right: span.right, y: Math.round(row.bottom) + 1, color: group.color, width: group.width });
        }
      }
    }
    const panels = visiblePanelRects(editors);
    const signature = JSON.stringify([geometry, panels, innerWidth, innerHeight]);
    if (signature !== previousGeometry) {
      previousGeometry = signature;
      const lines = geometry.map(item => {
        const line = document.createElementNS(SVG_NS, "line");
        line.dataset.threadId = item.id;
        line.setAttribute("x1", String(item.left)); line.setAttribute("x2", String(item.right));
        line.setAttribute("y1", String(item.y)); line.setAttribute("y2", String(item.y));
        line.setAttribute("stroke", item.color); line.setAttribute("stroke-width", String(item.width));
        line.setAttribute("stroke-linecap", "round");
        return line;
      });
      if (panels.length) {
        const defs = document.createElementNS(SVG_NS, 'defs');
        const mask = document.createElementNS(SVG_NS, 'mask');
        mask.id = maskId;
        mask.setAttribute('maskUnits', 'userSpaceOnUse');
        mask.setAttribute('x', '0'); mask.setAttribute('y', '0');
        mask.setAttribute('width', String(innerWidth)); mask.setAttribute('height', String(innerHeight));
        const allowed = document.createElementNS(SVG_NS, 'rect');
        allowed.setAttribute('width', String(innerWidth)); allowed.setAttribute('height', String(innerHeight));
        allowed.setAttribute('fill', 'white');
        mask.appendChild(allowed);
        for (const panel of panels) {
          const hidden = document.createElementNS(SVG_NS, 'rect');
          for (const [key, value] of Object.entries(panel)) hidden.setAttribute(key, String(value));
          hidden.setAttribute('fill', 'black'); mask.appendChild(hidden);
        }
        defs.appendChild(mask);
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('mask', `url(#${maskId})`);
        group.append(...lines);
        layer.replaceChildren(defs, group);
      } else layer.replaceChildren(...lines);
    }
    // Transforms and centered/virtualized chat layouts can keep moving without
    // resizing <body> or mutating its children. Follow the marked text itself.
    // Read cached marks while visible; only write SVG when their geometry changes.
    if (marks.length) frame = requestAnimationFrame(render);
  };
  const schedule = () => {
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(render);
  };
  requestLayout = () => { marksDirty = true; schedule(); };
  const currentRequest = requestLayout;
  const mutations = new MutationObserver(records => {
    const relevant = records.filter(record => {
      if (record.target === layer || layer.contains(record.target)) return false;
      if (record.type === "childList") {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.length && nodes.every(node => node === layer)) return false;
      }
      return true;
    });
    if (!relevant.length) return;
    marksDirty = true;
    schedule();
  });
  mutations.observe(document.documentElement, {
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ["class", "style", "hidden", "role", "aria-modal", "open", "contenteditable", "data-ai-helper-underline", "data-thread-id"],
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(document.documentElement);
  resize.observe(document.body);
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  document.fonts?.addEventListener("loadingdone", schedule);
  const onVisibilityChange = () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
    else { marksDirty = true; schedule(); }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  schedule();
  return () => {
    disposed = true;
    if (requestLayout === currentRequest) requestLayout = undefined;
    cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect();
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    document.fonts?.removeEventListener("loadingdone", schedule);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    layer.remove();
  };
}
