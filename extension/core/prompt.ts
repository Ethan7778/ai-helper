import { normalizeAnswerLength, type AnswerLength } from "./types";
import { SUMMARY_MIN_WORDS, SUMMARY_START, SUMMARY_END } from "./summary";

const ANSWER_LENGTH_INSTRUCTIONS: Record<AnswerLength, string> = {
  short:
    "Keep the answer short, clear, and specific. Lead with the direct answer, then include only the essential explanation or steps. Use a compact example only when it helps. Preserve necessary details and correctness; do not become vague just to be brief.",
  medium:
    "Give a balanced answer with a direct answer and enough explanation to understand it. Include key reasoning or steps and one useful example when appropriate. Avoid unnecessary background, repetition, and tangents.",
  detailed:
    "Give a detailed, well-organized explanation. Explain the reasoning step by step, include useful examples, and cover relevant nuances or common mistakes. Stay focused on the question and avoid padding or repetition.",
};

/** Pack highlight context + question into one prompt for the side conversation. */
export function buildFollowUpPrompt(args: {
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
  answerLength?: AnswerLength;
  summaryEnabled?: boolean;
  /** Assistant the highlighted reply came from, e.g. "ChatGPT" or "Claude". */
  siteName?: string;
  /** Earlier turns of this thread, for when the side chat is started fresh. */
  priorTurns?: { role: "user" | "assistant"; text: string }[];
}): string {
  const parts = [
    `You are answering a follow-up about a highlighted span from a ${
      args.siteName ?? "ChatGPT"
    } reply.`,
    "The user should not need the main chat; use only this context.",
    "",
    "## Highlighted span",
    args.quotedText.trim() || "(empty)",
    "",
    "## Surrounding message",
    args.surroundingContext.trim() || "(none)",
    "",
    "## Earlier conversation excerpt",
    args.conversationExcerpt.trim() || "(none)",
  ];
  if (args.priorTurns?.length) {
    parts.push(
      "",
      "## Earlier follow-ups in this thread",
      ...args.priorTurns.map(
        (t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text.trim()}`
      )
    );
  }
  parts.push("", "## Question", args.question.trim());
  parts.push(
    "",
    "## Answer length for this reply",
    ANSWER_LENGTH_INSTRUCTIONS[normalizeAnswerLength(args.answerLength)],
    "Use this preference for the current reply even if earlier replies used a different length. If the user's question explicitly requests a different length or format, follow that request."
  );
  parts.push("", "## Summary preference for this reply");
  if (args.summaryEnabled) {
    parts.push(
      `If the main answer contains at least ${SUMMARY_MIN_WORDS} words of prose (excluding code), append a summary after the complete answer.`,
      "Use one to three bullet points, with one short, clear sentence per bullet. Summarize the key takeaways without adding new information.",
      `Put the bullets between these exact markers, each on its own line: ${SUMMARY_START} and ${SUMMARY_END}.`,
      `For an answer shorter than ${SUMMARY_MIN_WORDS} words, omit the summary and both markers. Do not lengthen the answer just to qualify for a summary.`
    );
  } else {
    parts.push("Do not append a separate summary or summary markers, even if earlier replies included one.");
  }
  return parts.join("\n");
}
