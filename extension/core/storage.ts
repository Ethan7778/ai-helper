import type { Thread } from "./types";

function storageKey(siteId: string, conversationId: string): string {
  return `${siteId}:${conversationId}`;
}

/** Load threads for a conversation from chrome.storage.local. */
export async function loadThreads(
  siteId: string,
  conversationId: string
): Promise<Thread[]> {
  const key = storageKey(siteId, conversationId);
  return new Promise((resolve) => {
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
  });
}

/** Persist the full thread list for a conversation. */
export async function saveThreads(
  siteId: string,
  conversationId: string,
  threads: Thread[]
): Promise<void> {
  const key = storageKey(siteId, conversationId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: threads }, () => {
      if (chrome.runtime.lastError) {
        console.error(
          "[ai-helper] storage save failed:",
          chrome.runtime.lastError.message
        );
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
