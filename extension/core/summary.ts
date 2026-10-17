/** Summaries stay part of the same request; no extra AI round trip. */
export const SUMMARY_MIN_WORDS = 100;
export const SUMMARY_START = "[[AI_HELPER_SUMMARY]]";
export const SUMMARY_END = "[[/AI_HELPER_SUMMARY]]";

export function answerWordCount(text: string): number {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  return prose.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Also hides incomplete delimiter fragments while a reply is streaming. */
export function splitSummaryReply(raw: string, enabled: boolean): {
  text: string; summary?: string[];
} {
  const start = raw.indexOf(SUMMARY_START);
  if (start < 0) {
    for (let n = SUMMARY_START.length - 1; n > 0; n--) {
      if (raw.endsWith(SUMMARY_START.slice(0, n))) {
        return { text: raw.slice(0, -n).trimEnd() };
      }
    }
    return { text: raw };
  }
  const text = raw.slice(0, start).trimEnd();
  const end = raw.indexOf(SUMMARY_END, start);
  if (!enabled || end < 0 || answerWordCount(text) < SUMMARY_MIN_WORDS) return { text };
  const summary = raw.slice(start + SUMMARY_START.length, end)
    .split(/\r?\n/)
    .filter(line => /^\s*[-*•]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean)
    .map(line => line.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? line)
    .slice(0, 3);
  return summary.length ? { text, summary } : { text };
}
