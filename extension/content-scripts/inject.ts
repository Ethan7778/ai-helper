import { createChatGptAdapter } from "../adapters/chatgpt";
import { bootEngine } from "../core/engine";
import type { SiteAdapter } from "../core/types";

function resolveAdapter(hostname: string): SiteAdapter | null {
  if (hostname === "chatgpt.com" || hostname === "www.chatgpt.com") {
    return createChatGptAdapter();
  }
  return null;
}

async function main(): Promise<void> {
  const adapter = resolveAdapter(location.hostname);
  if (!adapter) {
    console.warn(
      `[ai-helper] No adapter for hostname "${location.hostname}". Extension idle.`
    );
    return;
  }

  try {
    await bootEngine(adapter);
  } catch (err) {
    console.error("[ai-helper] Failed to boot engine:", err);
  }
}

void main();
