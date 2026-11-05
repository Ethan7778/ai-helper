import type { ImageAttachment } from "./types";

export const MAX_IMAGES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function prepareImage(file: File): Promise<ImageAttachment> {
  if (!MIME_TYPES.has(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Each picture must be 10 MB or smaller.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) {
      throw new Error("This picture is too large. Choose an image under 40 megapixels.");
    }
    const draw = (max: number, preview = false) => {
      const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare this picture.");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { url: canvas.toDataURL(preview ? "image/jpeg" : "image/png", 0.8), width: canvas.width, height: canvas.height };
    };
    let full = draw(2048);
    // Keep upload memory bounded, retaining readable screenshots as PNG when possible.
    if (full.url.length > 4 * 1024 * 1024) full = draw(1280);
    if (full.url.length > 6 * 1024 * 1024) throw new Error("This picture is too complex. Try a smaller crop.");
    return { id: crypto.randomUUID(), name: `${(file.name || "picture").replace(/\.[^.]+$/, "")}.png`, mimeType: "image/png", dataUrl: full.url, previewDataUrl: draw(200, true).url, width: full.width, height: full.height };
  } finally { URL.revokeObjectURL(url); }
}

export function imageBlob(image: ImageAttachment): Blob {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl) || image.dataUrl.length > 6 * 1024 * 1024) {
    throw new Error("Invalid picture data. Remove the picture and attach it again.");
  }
  const binary = atob(image.dataUrl.split(",")[1]);
  return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type: "image/png" });
}
