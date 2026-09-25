/** Pack highlight context + question into one prompt for the side conversation. */
export function buildFollowUpPrompt(args: {
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
}): string {
  const parts = [
    "You are answering a follow-up about a highlighted span from a ChatGPT reply.",
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
    "",
    "## Question",
    args.question.trim(),
  ];
  return parts.join("\n");
}
