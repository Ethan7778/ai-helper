import { ASK_BUTTON_ID } from "./anchor";
import { BUILD_TIME, DEBUG, DEBUG_STORAGE_KEY } from "./log";
import { HOST_ID } from "./sidebar";
import { isExtensionAlive, summarizeStorage } from "./storage";
import type { SiteAdapter } from "./types";

/** Dispatch this on `document` from the page console to print diagnostics. */
export const DIAGNOSTICS_EVENT = "ai-helper:diagnostics";

export interface DiagnosticsSources {
  adapter: SiteAdapter;
  getConversationId: () => string;
  getThreadCount: () => number;
  getRegisteredMessageCount: () => number;
  getPendingCount: () => number;
  isSidebarMounted: () => boolean;
  isDead: () => boolean;
}

interface UADataLike {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platform?: string;
    platformVersion?: string;
    architecture?: string;
    fullVersionList?: { brand: string; version: string }[];
  }>;
}

async function environment(): Promise<Record<string, unknown>> {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike })
    .userAgentData;
  const chromeFromUa = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null;
  let os: string = uaData?.platform || navigator.platform || "unknown";
  let chromeVersion: string | null = chromeFromUa;
  let arch: string | null = null;
  try {
    const hi = await uaData?.getHighEntropyValues?.([
      "platform",
      "platformVersion",
      "architecture",
      "fullVersionList",
    ]);
    if (hi) {
      if (hi.platform) {
        os = hi.platformVersion ? `${hi.platform} ${hi.platformVersion}` : hi.platform;
      }
      arch = hi.architecture ?? null;
      const brand = hi.fullVersionList?.find((b) =>
        /Google Chrome|Chromium|Microsoft Edge|Brave/.test(b.brand)
      );
      if (brand) chromeVersion = `${brand.brand} ${brand.version}`;
    }
  } catch {
    // High-entropy hints are optional; the UA string fallback is enough.
  }
  return {
    os,
    arch,
    chromeVersion,
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
  };
}

function manifestVersion(): string | null {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

async function collect(src: DiagnosticsSources): Promise<Record<string, unknown>> {
  const alive = isExtensionAlive();
  const storage = alive
    ? await summarizeStorage(src.adapter.siteId)
    : "extension context invalidated — refresh the tab";
  return {
    extension: {
      version: manifestVersion(),
      buildTime: BUILD_TIME,
      contextAlive: alive,
      engineStopped: src.isDead(),
      debug: DEBUG,
      debugToggle: `localStorage.setItem("${DEBUG_STORAGE_KEY}", "1") then reload`,
    },
    environment: await environment(),
    page: {
      url: location.href,
      readyState: document.readyState,
      siteId: src.adapter.siteId,
      conversationId: src.getConversationId(),
    },
    engine: {
      threadsLoaded: src.getThreadCount(),
      messagesRegistered: src.getRegisteredMessageCount(),
      messagesWaitingForStreamEnd: src.getPendingCount(),
      messageRootsFoundNow: src.adapter.getMessageContainers().length,
    },
    dom: {
      sidebarHostPresent: Boolean(document.getElementById(HOST_ID)),
      sidebarMounted: src.isSidebarMounted(),
      askButtonVisible: Boolean(document.getElementById(ASK_BUTTON_ID)),
      highlightMarks: document.querySelectorAll("mark[data-thread-id]").length,
      ...(src.adapter.describeDom?.() ?? {}),
    },
    storage,
  };
}

/**
 * Expose diagnostics two ways:
 * - `document.dispatchEvent(new Event("ai-helper:diagnostics"))` from the normal
 *   page console (DOM events cross the content-script isolation boundary).
 * - `aiHelperDiagnostics()` when the console context is set to this extension.
 */
export function registerDiagnostics(src: DiagnosticsSources): () => void {
  const run = async () => {
    const report = await collect(src);
    console.log("[ai-helper] diagnostics\n" + JSON.stringify(report, null, 2));
    return report;
  };
  const onEvent = () => void run();
  document.addEventListener(DIAGNOSTICS_EVENT, onEvent);
  const g = globalThis as { aiHelperDiagnostics?: () => Promise<unknown> };
  g.aiHelperDiagnostics = run;
  return () => {
    document.removeEventListener(DIAGNOSTICS_EVENT, onEvent);
    if (g.aiHelperDiagnostics === run) delete g.aiHelperDiagnostics;
  };
}
