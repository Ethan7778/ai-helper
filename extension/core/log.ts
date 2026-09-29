declare const __AI_HELPER_BUILD_TIME__: string;

/** Flip to true for verbose logs in every build. */
const DEBUG_DEFAULT = false;

/** Per-browser override: `localStorage.setItem("ai-helper:debug", "1")` then reload. */
export const DEBUG_STORAGE_KEY = "ai-helper:debug";

const PREFIX = "[ai-helper]";

function readDebugOverride(): boolean {
  try {
    // Service workers have no localStorage.
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(DEBUG_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export const DEBUG = DEBUG_DEFAULT || readDebugOverride();

export const BUILD_TIME =
  typeof __AI_HELPER_BUILD_TIME__ === "string"
    ? __AI_HELPER_BUILD_TIME__
    : "dev";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Logger with a consistent `[ai-helper][scope]` prefix; `debug` is gated on DEBUG. */
export function createLogger(scope?: string): Logger {
  const tag = scope ? `${PREFIX}[${scope}]` : PREFIX;
  return {
    debug: (...args) => {
      if (DEBUG) console.log(tag, ...args);
    },
    info: (...args) => console.info(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
  };
}
