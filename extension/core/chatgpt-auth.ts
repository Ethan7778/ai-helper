const LOG = "[ai-helper][chatgpt-session]";
const SESSION_URL = "https://chatgpt.com/api/auth/session";

/** Fetch access token from chatgpt.com (call from content script; cookies included). */
export async function fetchAccessTokenFromPage(): Promise<{
  accessToken: string;
  userAgent: string;
}> {
  const res = await fetch(SESSION_URL, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    console.error(`${LOG} /api/auth/session HTTP ${res.status}`);
    throw new Error(
      "ChatGPT session unavailable — reload the page or re-login, then try again."
    );
  }
  if (!res.ok) {
    console.error(`${LOG} /api/auth/session HTTP ${res.status}`);
    throw new Error(`Failed to read ChatGPT session (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    console.error(`${LOG} session JSON missing accessToken`);
    throw new Error(
      "No ChatGPT access token found. Make sure you are logged in on chatgpt.com."
    );
  }
  return {
    accessToken: data.accessToken,
    userAgent: navigator.userAgent,
  };
}
