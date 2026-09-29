import { createChatGptAdapter } from "../adapters/chatgpt";
import { bootEngine } from "../core/engine";
import { BUILD_TIME, createLogger, DEBUG } from "../core/log";
import type { SiteAdapter } from "../core/types";

const log = createLogger();

function resolveAdapter(hostname: string): SiteAdapter | null {
  if (hostname === "chatgpt.com" || hostname === "www.chatgpt.com") {
    return createChatGptAdapter();
  }
  return null;
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
