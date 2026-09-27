import type { Thread } from "./types";

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
          console.error(
            "[ai-helper] storage load failed:",
            chrome.runtime.lastError.message
          );
          resolve([]);
          return;
        }
        const value = result[key];
        resolve(Array.isArray(value) ? (value as Thread[]) : []);
      });
    } catch (err) {
      console.error("[ai-helper] storage load threw:", asStorageError(err).message);
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
          console.error("[ai-helper] storage save failed:", msg);
          reject(asStorageError(new Error(msg)));
          return;
        }
        // Index any side conversation ids so we can warn if the user opens one.
        const sideIds = threads
          .map((t) => t.sideConversationId)
          .filter((id): id is string => Boolean(id));
        if (sideIds.length) {
          void rememberSideConversations(siteId, sideIds);
        }
        resolve();
      });
    } catch (err) {
      reject(asStorageError(err));
    }
  });
}

function sideIndexKey(siteId: string): string {
  return `${siteId}:__side_conversation_ids`;
}

/** Remember ChatGPT conversation ids that were created only for highlight follow-ups. */
export async function rememberSideConversations(
  siteId: string,
  ids: string[]
): Promise<void> {
  const fresh = ids.map((id) => id.trim()).filter(Boolean);
  if (!fresh.length || !isExtensionAlive()) return;
  const key = sideIndexKey(siteId);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result) => {
        const prev = Array.isArray(result[key])
          ? (result[key] as string[])
          : [];
        const merged = Array.from(new Set([...prev, ...fresh]));
        chrome.storage.local.set({ [key]: merged }, () => resolve());
      });
    } catch {
      resolve();
    }
  });
}

/** True if this ChatGPT conversation id is one of our helper side chats. */
export async function isKnownSideConversation(
  siteId: string,
  conversationId: string
): Promise<boolean> {
  if (!conversationId || conversationId.startsWith("anon-")) return false;
  if (!isExtensionAlive()) return false;
  const key = sideIndexKey(siteId);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result) => {
        const ids = Array.isArray(result[key])
          ? (result[key] as string[])
          : [];
        resolve(ids.includes(conversationId));
      });
    } catch {
      resolve(false);
    }
  });
}
