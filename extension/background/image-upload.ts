import type { ImageAttachment } from "../core/types";
import { imageBlob } from "../core/images";

async function uploadFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`Picture upload failed (HTTP ${response.status}). Your pictures are still attached; try again.`);
    // Keep the deadline active while reading the small ticket/confirmation body.
    await response.clone().arrayBuffer();
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Picture upload timed out. Try again with a smaller picture.");
    throw error;
  } finally { clearTimeout(timer); }
}

/** Session protocols, deliberately isolated so provider changes are contained. */
export async function uploadChatGptImages(images: ImageAttachment[], token: string): Promise<{ parts: unknown[]; attachments: unknown[] }> {
  const parts: unknown[] = [], attachments: unknown[] = [];
  for (const image of images) {
    const blob = imageBlob(image);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const ticket = await (await uploadFetch("https://chatgpt.com/backend-api/files", {
      method: "POST", credentials: "include", headers,
      body: JSON.stringify({ file_name: image.name, file_size: blob.size, use_case: "multimodal", timezone_offset_min: new Date().getTimezoneOffset() }),
    })).json() as { file_id?: string; upload_url?: string };
    if (!ticket.file_id || !ticket.upload_url) throw new Error("ChatGPT did not accept the picture upload. Reload ChatGPT and try again.");
    const target = new URL(ticket.upload_url);
    if (target.protocol !== "https:" || !(target.hostname.endsWith(".blob.core.windows.net") || target.hostname === "chatgpt.com" || target.hostname.endsWith(".oaiusercontent.com"))) {
      throw new Error("ChatGPT returned an unsupported picture upload address.");
    }
    // Never forward the user's bearer token to a signed storage URL.
    await uploadFetch(target.href, { method: "PUT", credentials: "omit", headers: { "Content-Type": "image/png", "x-ms-blob-type": "BlockBlob", "x-ms-version": "2020-04-08" }, body: blob });
    await uploadFetch(`https://chatgpt.com/backend-api/files/${encodeURIComponent(ticket.file_id)}/uploaded`, { method: "POST", credentials: "include", headers, body: "{}" });
    parts.push({ content_type: "image_asset_pointer", asset_pointer: `file-service://${ticket.file_id}`, size_bytes: blob.size, width: image.width, height: image.height });
    attachments.push({ id: ticket.file_id, name: image.name, size: blob.size, mime_type: "image/png", width: image.width, height: image.height });
  }
  return { parts, attachments };
}

export async function uploadClaudeImages(images: ImageAttachment[], orgId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const image of images) {
    const form = new FormData(); form.append("file", imageBlob(image), image.name);
    const result = await (await uploadFetch(`https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/upload`, { method: "POST", credentials: "include", body: form })).json() as { file_uuid?: string; uuid?: string };
    const id = result.file_uuid || result.uuid;
    if (!id) throw new Error("Claude did not return a picture ID. Reload Claude and try again.");
    ids.push(id);
  }
  return ids;
}

export async function uploadGeminiImages(images: ImageAttachment[], pushId: string): Promise<unknown[]> {
  const files: unknown[] = [];
  for (const image of images) {
    const form = new FormData(); form.append("file", imageBlob(image), image.name);
    const result = (await (await uploadFetch("https://content-push.googleapis.com/upload", { method: "POST", credentials: "include", headers: { "X-Tenant-Id": "bard-storage", "Push-ID": pushId }, body: form })).text()).trim();
    if (!/^\/contrib_service\/[^\s]+$/.test(result)) throw new Error("Gemini did not return a picture reference. Reload Gemini and try again.");
    files.push([[result], image.name]);
  }
  return files;
}
