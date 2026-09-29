import { createLogger } from "./log";
import type { Thread } from "./types";

const log = createLogger("storage");

export const EXTENSION_RELOAD_MSG =
  "Extension was reloaded — refresh this ChatGPT tab to keep using Highlight threads.";

function storageKey(siteId: string, conversationId: string): string {
  return `${siteId}:${conversationId}`;
}

/** True while this content script still has a live extension context. */
export function isExtensionAlive(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function asStorageError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/extension context invalidated/i.test(raw) || !isExtensionAlive()) {
    return new Error(EXTENSION_RELOAD_MSG);
  }
  return err instanceof Error ? err : new Error(raw);
}

/** Load threads for a conversation from chrome.storage.local. */
export async function loadThreads(
  siteId: string,
  conversationId: string
): Promise<Thread[]> {
  if (!isExtensionAlive()) return [];
  const key = storageKey(siteId, conversationId);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          log.error("storage load failed:", chrome.runtime.lastError.message);
          resolve([]);
          return;
        }
        const value = result[key];
        const threads = Array.isArray(value) ? (value as Thread[]) : [];
        log.debug(`Loaded ${threads.length} thread(s) from "${key}"`);
        resolve(threads);
      });
    } catch (err) {
      log.error("storage load threw:", asStorageError(err).message);
      resolve([]);
    }
  });
}

/** Persist the full thread list for a conversation. */
export async function saveThreads(
  siteId: string,
  conversationId: string,
  threads: Thread[]
): Promise<void> {
  if (!isExtensionAlive()) {
    throw new Error(EXTENSION_RELOAD_MSG);
  }
  const key = storageKey(siteId, conversationId);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [key]: threads }, () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "storage save failed";
          log.error("storage save failed:", msg);
          reject(asStorageError(new Error(msg)));
          return;
        }
        log.debug(`Saved ${threads.length} thread(s) to "${key}"`);
        resolve();
      });
    } catch (err) {
      reject(asStorageError(err));
    }
  });
}

function removeKeys(keys: string[]): Promise<void> {
  if (!isExtensionAlive() || keys.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          log.warn("storage remove failed:", chrome.runtime.lastError.message);
        }
        resolve();
      });
    } catch (err) {
      log.warn("storage remove threw:", asStorageError(err).message);
      resolve();
    }
  });
}

/** Drop keys written by older versions that nothing reads anymore. */
export function removeLegacyKeys(siteId: string): Promise<void> {
  return removeKeys([`${siteId}:__side_conversation_ids`]);
}

/**
 * Move threads from a pre-id conversation key (e.g. "anon-/") to the real
 * conversation id once the host assigns one. Only threads whose message is
 * in `presentMessageIds` move; the rest stay under the old key.
 */
export async function migrateThreads(
  siteId: string,
  fromConversationId: string,
  toConversationId: string,
  presentMessageIds: Set<string>
): Promise<Thread[]> {
  const [from, to] = await Promise.all([
    loadThreads(siteId, fromConversationId),
    loadThreads(siteId, toConversationId),
  ]);
  const moving = from.filter((t) => presentMessageIds.has(t.messageId));
  if (moving.length === 0) return to;

  const known = new Set(to.map((t) => t.id));
  const merged = [...to, ...moving.filter((t) => !known.has(t.id))];
  const remaining = from.filter((t) => !presentMessageIds.has(t.messageId));

  await saveThreads(siteId, toConversationId, merged);
  if (remaining.length) {
    await saveThreads(siteId, fromConversationId, remaining);
  } else {
    await removeKeys([storageKey(siteId, fromConversationId)]);
  }
  log.debug(
    `Moved ${moving.length} thread(s) from "${fromConversationId}" to "${toConversationId}"`
  );
  return merged;
}

export interface StorageSummary {
  bytesInUse: number | null;
  conversations: {
    key: string;
    threads: number;
    replies: number;
    quotes: string[];
  }[];
}

/** Counts and short quote previews for diagnostics; never includes reply bodies. */
export async function summarizeStorage(siteId: string): Promise<StorageSummary> {
  if (!isExtensionAlive()) return { bytesInUse: null, conversations: [] };
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (all) => {
        const conversations: StorageSummary["conversations"] = [];
        for (const [key, value] of Object.entries(all ?? {})) {
          if (!key.startsWith(`${siteId}:`) || !Array.isArray(value)) continue;
          const threads = value as Thread[];
          conversations.push({
            key,
            threads: threads.length,
            replies: threads.reduce((n, t) => n + (t.replies?.length ?? 0), 0),
            quotes: threads
              .slice(0, 5)
              .map((t) => (t.quotedText ?? "").slice(0, 40)),
          });
        }
        chrome.storage.local.getBytesInUse(null, (bytes) => {
          resolve({
            bytesInUse: chrome.runtime.lastError ? null : bytes,
            conversations,
          });
        });
      });
    } catch (err) {
      log.warn("storage summary failed:", asStorageError(err).message);
      resolve({ bytesInUse: null, conversations: [] });
    }
  });
}
