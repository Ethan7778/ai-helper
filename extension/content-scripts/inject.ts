import { createChatGptAdapter } from "../adapters/chatgpt";
import { createClaudeAdapter } from "../adapters/claude";
import { createGeminiAdapter } from "../adapters/gemini";
import { bootEngine } from "../core/engine";
import { BUILD_TIME, createLogger, DEBUG } from "../core/log";
import type { SiteAdapter } from "../core/types";

const log = createLogger();

const ADAPTERS: Record<string, () => SiteAdapter> = {
  "chatgpt.com": createChatGptAdapter,
  "www.chatgpt.com": createChatGptAdapter,
  "claude.ai": createClaudeAdapter,
  "gemini.google.com": createGeminiAdapter,
};

function resolveAdapter(hostname: string): SiteAdapter | null {
  return ADAPTERS[hostname]?.() ?? null;
}

async function main(): Promise<void> {
  log.debug(
    `Content script loaded (build ${BUILD_TIME}, DEBUG=${DEBUG}) on ${location.href}`
  );
  const adapter = resolveAdapter(location.hostname);
  if (!adapter) {
    log.warn(`No adapter for hostname "${location.hostname}". Extension idle.`);
    return;
  }

  try {
    await bootEngine(adapter);
  } catch (err) {
    log.error("Failed to boot engine:", err);
  }
}

void main();
