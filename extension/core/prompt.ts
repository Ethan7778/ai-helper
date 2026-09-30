/** Pack highlight context + question into one prompt for the side conversation. */
export function buildFollowUpPrompt(args: {
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
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
  return parts.join("\n");
}
