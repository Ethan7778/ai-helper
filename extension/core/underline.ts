/** Draw one underline per visual text line, even across mixed inline fonts. */
const SVG_NS = "http://www.w3.org/2000/svg";
let requestLayout: (() => void) | undefined;

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
  let previousGeometry = "";
  const render = () => {
    frame = 0;
    if (disposed || document.hidden) return;
    if (!layer.isConnected) document.documentElement.appendChild(layer);
    if (marksDirty) {
      marks = Array.from(document.querySelectorAll<HTMLElement>("mark[data-thread-id][data-ai-helper-underline]"));
      marksDirty = false;
    }
    marks = marks.filter(mark => mark.isConnected && mark.hasAttribute("data-ai-helper-underline"));
    const threads = new Map<string, { color: string; width: number; rects: DOMRect[] }>();
    for (const mark of marks) {
      const id = mark.dataset.threadId!;
      let group = threads.get(id);
      if (!group) {
        group = { color: mark.dataset.aiHelperUnderline!, width: 2, rects: [] };
        threads.set(id, group);
      }
      group.width = Math.max(group.width, Number(mark.style.getPropertyValue("--ai-helper-underline-width")) || 2);
      for (const rect of mark.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight) group.rects.push(rect);
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
    const signature = JSON.stringify(geometry);
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
      layer.replaceChildren(...lines);
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
    if (relevant.some(record => record.type === "childList" || record.attributeName === "data-ai-helper-underline" || record.attributeName === "data-thread-id")) marksDirty = true;
    schedule();
  });
  mutations.observe(document.documentElement, {
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ["class", "style", "hidden", "data-ai-helper-underline", "data-thread-id"],
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
