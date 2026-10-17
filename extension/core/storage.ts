import { createLogger } from "./log";
import {
  DEFAULT_UI_APPEARANCE,
  DEFAULT_ANSWER_LENGTH,
  normalizeAnswerLength,
  type AnswerLength,
  type HighlightStyle,
  type Thread,
  type UiAppearance,
} from "./types";

const log = createLogger("storage");

export const EXTENSION_RELOAD_MSG =
  "Extension was reloaded — refresh this tab to keep using Highlight threads.";

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
  // Skip empty drafts — those are in-memory only until the user sends.
  const withReplies = (list: Thread[]) =>
    list.filter((t) => t.replies.length > 0);
  const moving = withReplies(from).filter((t) =>
    presentMessageIds.has(t.messageId)
  );
  const toPersisted = withReplies(to);
  if (moving.length === 0) return toPersisted;

  const known = new Set(toPersisted.map((t) => t.id));
  const merged = [...toPersisted, ...moving.filter((t) => !known.has(t.id))];
  const remaining = withReplies(from).filter(
    (t) => !presentMessageIds.has(t.messageId)
  );

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

const SIDEBAR_WIDTH_KEY = "ui:sidebarWidth";
const UI_APPEARANCE_KEY = "ui:appearance";
export const ANSWER_LENGTH_KEY = "ui:answerLength";
export const SUMMARY_ENABLED_KEY = "ui:summaryEnabled";

export async function loadSummaryEnabled(): Promise<boolean> {
  if (!isExtensionAlive()) return false;
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([SUMMARY_ENABLED_KEY], result => {
        resolve(!chrome.runtime.lastError && result[SUMMARY_ENABLED_KEY] === true);
      });
    } catch { resolve(false); }
  });
}

export async function saveSummaryEnabled(enabled: boolean): Promise<void> {
  if (!isExtensionAlive()) throw new Error(EXTENSION_RELOAD_MSG);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [SUMMARY_ENABLED_KEY]: enabled === true }, () => {
        if (chrome.runtime.lastError) {
          reject(asStorageError(new Error(chrome.runtime.lastError.message || "summary setting save failed")));
        } else { resolve(); }
      });
    } catch (err) { reject(asStorageError(err)); }
  });
}

/** Kept separate from appearance so existing highlight preferences are preserved. */
export async function loadAnswerLength(): Promise<AnswerLength> {
  if (!isExtensionAlive()) return DEFAULT_ANSWER_LENGTH;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([ANSWER_LENGTH_KEY], (result) => {
        resolve(chrome.runtime.lastError
          ? DEFAULT_ANSWER_LENGTH
          : normalizeAnswerLength(result[ANSWER_LENGTH_KEY]));
      });
    } catch {
      resolve(DEFAULT_ANSWER_LENGTH);
    }
  });
}

export async function saveAnswerLength(value: AnswerLength): Promise<void> {
  if (!isExtensionAlive()) throw new Error(EXTENSION_RELOAD_MSG);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(
        { [ANSWER_LENGTH_KEY]: normalizeAnswerLength(value) },
        () => {
          if (chrome.runtime.lastError) {
            reject(asStorageError(new Error(chrome.runtime.lastError.message || "answer length save failed")));
          } else {
            resolve();
          }
        }
      );
    } catch (err) {
      reject(asStorageError(err));
    }
  });
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeAppearance(raw: unknown): UiAppearance {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_UI_APPEARANCE };
  const obj = raw as Partial<UiAppearance>;
  const color =
    typeof obj.highlightColor === "string" && HEX_COLOR_RE.test(obj.highlightColor)
      ? obj.highlightColor.toLowerCase()
      : DEFAULT_UI_APPEARANCE.highlightColor;
  const style: HighlightStyle =
    obj.highlightStyle === "underline" || obj.highlightStyle === "classic"
      ? obj.highlightStyle
      : DEFAULT_UI_APPEARANCE.highlightStyle;
  return { highlightColor: color, highlightStyle: style };
}

/** Load highlight color/style prefs (falls back to defaults). */
export async function loadUiAppearance(): Promise<UiAppearance> {
  if (!isExtensionAlive()) return { ...DEFAULT_UI_APPEARANCE };
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([UI_APPEARANCE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          resolve({ ...DEFAULT_UI_APPEARANCE });
          return;
        }
        resolve(normalizeAppearance(result[UI_APPEARANCE_KEY]));
      });
    } catch {
      resolve({ ...DEFAULT_UI_APPEARANCE });
    }
  });
}

/** Persist highlight appearance prefs. */
export async function saveUiAppearance(appearance: UiAppearance): Promise<void> {
  if (!isExtensionAlive()) {
    throw new Error(EXTENSION_RELOAD_MSG);
  }
  const normalized = normalizeAppearance(appearance);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [UI_APPEARANCE_KEY]: normalized }, () => {
        if (chrome.runtime.lastError) {
          reject(
            asStorageError(
              new Error(chrome.runtime.lastError.message || "appearance save failed")
            )
          );
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(asStorageError(err));
    }
  });
}

/** Saved sidebar width in CSS px, or null if never set. */
export function loadSidebarWidth(): Promise<number | null> {
  if (!isExtensionAlive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([SIDEBAR_WIDTH_KEY], (result) => {
        const value = chrome.runtime.lastError ? null : result[SIDEBAR_WIDTH_KEY];
        resolve(typeof value === "number" && Number.isFinite(value) ? value : null);
      });
    } catch {
      resolve(null);
    }
  });
}

export function saveSidebarWidth(width: number): void {
  if (!isExtensionAlive()) return;
  try {
    chrome.storage.local.set({ [SIDEBAR_WIDTH_KEY]: Math.round(width) }, () => {
      if (chrome.runtime.lastError) {
        log.warn("could not save sidebar width:", chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    log.warn("could not save sidebar width:", asStorageError(err).message);
  }
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
