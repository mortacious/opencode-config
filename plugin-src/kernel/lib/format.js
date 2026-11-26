// Turn one cell's host events into tool content.
//
// Events arrive in host order (stdout/stderr interleaved, displays, results,
// errors). formatResult preserves that order, strips ANSI noise, saves image
// payloads to the session images directory, and caps the text at capBytes by
// keeping a head and a tail and writing the complete text to a log file.
// buildContent then wraps the text with inline image file parts for the TUI.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const DEFAULT_CAP_BYTES = 51200;

const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/svg+xml", "svg"],
]);

// Images worth an inline TUI preview. SVG is deliberately excluded: it is not
// a raster mime and stays a path line only.
const INLINE_MIMES = new Set(["image/png", "image/jpeg"]);
const MAX_INLINE_IMAGES = 3;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024;

export function stripAnsi(value) {
  return String(value).replace(ANSI_OSC, "").replace(ANSI_ESCAPE, "");
}

export function stripHtml(value) {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function mimeText(data, mime) {
  if (!data || typeof data !== "object" || !(mime in data)) return null;
  const value = data[mime];
  if (Array.isArray(value)) return value.map((part) => String(part)).join("");
  if (typeof value === "string") return value;
  return null;
}

export function plainText(data) {
  const plain = mimeText(data, "text/plain");
  if (plain !== null) return plain;
  const markdown = mimeText(data, "text/markdown");
  if (markdown !== null) return markdown;
  const html = mimeText(data, "text/html");
  if (html !== null) return stripHtml(html).trim();
  return "";
}

export function safeName(value, fallback = "0") {
  const cleaned = String(value ?? "")
    .replace(/[^0-9A-Za-z_-]/g, "")
    .slice(0, 64);
  return cleaned === "" ? fallback : cleaned;
}

async function saveImage({ data, mime, imagesDir, executionCount, index }) {
  const encoded = mimeText(data, mime) ?? "";
  const buffer = Buffer.from(encoded, "base64");
  await mkdir(imagesDir, { recursive: true });
  const file = path.resolve(
    imagesDir,
    `${safeName(executionCount)}-${safeName(index, "1")}.${IMAGE_TYPES.get(mime)}`,
  );
  await writeFile(file, buffer);
  return { file, buffer };
}

/**
 * Build tool content for one result. Without an eligible image the content is
 * the plain text; otherwise it is a text part followed by up to three file
 * parts carrying the images the TUI can preview inline. Ineligible images keep
 * their `image: <path>` text line only.
 */
export function buildContent(text, imageParts = []) {
  const files = [];
  let total = 0;
  for (const image of Array.isArray(imageParts) ? imageParts : []) {
    if (files.length >= MAX_INLINE_IMAGES) break;
    if (!INLINE_MIMES.has(image.mime)) continue;
    if (image.bytes > MAX_INLINE_IMAGE_BYTES) continue;
    if (total + image.bytes > MAX_INLINE_TOTAL_BYTES) continue;
    total += image.bytes;
    files.push({
      type: "file",
      uri: `data:${image.mime};base64,${image.base64}`,
      mime: image.mime,
      name: path.basename(image.file),
    });
  }
  if (files.length === 0) return text;
  return [{ type: "text", text }, ...files];
}

export async function formatResult(events, options = {}) {
  const { imagesDir, logsDir, capBytes = DEFAULT_CAP_BYTES } = options;
  if (typeof imagesDir !== "string" || typeof logsDir !== "string") {
    throw new TypeError("formatResult requires imagesDir and logsDir");
  }

  const chunks = [];
  const pendingImages = [];
  const supersededImages = new Set();
  let pendingClear = false;
  let executionCount = 0;
  let status = "ok";
  let sawError = false;
  let imageIndex = 0;

  // A `wait:true` clear_output applies at the next output, not immediately.
  const flushClear = () => {
    if (!pendingClear) return;
    pendingClear = false;
    chunks.length = 0;
  };

  const pushRaw = (text) => {
    flushClear();
    if (text !== "") chunks.push({ kind: "raw", text });
  };

  const pushBlock = (text, displayId = null, images = []) => {
    flushClear();
    chunks.push({ kind: "block", text, displayId, images });
  };

  const displayIdOf = (event) => {
    const transient =
      event.transient && typeof event.transient === "object" ? event.transient : {};
    const id = transient.display_id;
    if (typeof id === "string" && id !== "") return id;
    if (typeof id === "number") return String(id);
    return null;
  };

  const displayParts = (data) => {
    const value = data && typeof data === "object" ? data : {};
    const parts = [];
    const images = [];
    const preview = plainText(value);
    if (preview !== "") parts.push(stripAnsi(preview).replace(/\s+$/, ""));
    for (const mime of IMAGE_TYPES.keys()) {
      if (!(mime in value)) continue;
      imageIndex += 1;
      const placeholder = `\u0000image-${imageIndex}\u0000`;
      const item = { data: value, mime, index: imageIndex, placeholder };
      pendingImages.push(item);
      images.push(item);
      parts.push(placeholder);
    }
    return { text: parts.join("\n"), images };
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    switch (event.op) {
      case "stream": {
        pushRaw(stripAnsi(event.text ?? ""));
        break;
      }
      case "result": {
        if (typeof event.executionCount === "number") executionCount = event.executionCount;
        const value = stripAnsi(plainText(event.data)).replace(/\s+$/, "");
        pushBlock(`Out[${executionCount}]: ${value}`);
        break;
      }
      case "display": {
        const shown = displayParts(event.data);
        pushBlock(shown.text, displayIdOf(event), shown.images);
        break;
      }
      case "update_display": {
        const shown = displayParts(event.data);
        const displayId = displayIdOf(event);
        flushClear();
        let replaced = false;
        if (displayId !== null) {
          for (let i = chunks.length - 1; i >= 0; i -= 1) {
            const chunk = chunks[i];
            if (chunk.kind === "block" && chunk.displayId === displayId) {
              // The replaced chunk's text leaves the output, so its images must
              // not be saved or listed as long as their placeholders are gone.
              for (const item of chunk.images) supersededImages.add(item);
              chunk.text = shown.text;
              chunk.images = shown.images;
              replaced = true;
              break;
            }
          }
        }
        if (!replaced) {
          chunks.push({ kind: "block", text: shown.text, displayId, images: shown.images });
        }
        break;
      }
      case "clear_output": {
        if (event.wait === true) {
          pendingClear = true;
        } else {
          chunks.length = 0;
          pendingClear = false;
        }
        break;
      }
      case "error": {
        sawError = true;
        const name = stripAnsi(event.ename ?? "Error");
        const value = stripAnsi(event.evalue ?? "");
        pushBlock(`${name}: ${value}`.trimEnd());
        const traceback = Array.isArray(event.traceback) ? event.traceback : [];
        const lines = traceback
          .map((line) => stripAnsi(line).replace(/\s+$/, ""))
          .filter((line) => line !== "");
        if (lines.length > 0) pushBlock(lines.join("\n"));
        break;
      }
      case "done": {
        if (typeof event.executionCount === "number") executionCount = event.executionCount;
        if (typeof event.status === "string") status = event.status;
        break;
      }
      default:
        break;
    }
  }

  let text = "";
  for (const chunk of chunks) {
    if (chunk.kind === "raw") {
      text += chunk.text;
      continue;
    }
    if (chunk.text === "") continue;
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    text += chunk.text.endsWith("\n") ? chunk.text : `${chunk.text}\n`;
  }

  const images = [];
  const imageParts = [];
  for (const item of pendingImages) {
    if (supersededImages.has(item)) continue;
    if (!text.includes(item.placeholder)) continue;
    const { file, buffer } = await saveImage({
      data: item.data,
      mime: item.mime,
      imagesDir,
      executionCount,
      index: item.index,
    });
    images.push(file);
    if (INLINE_MIMES.has(item.mime) && buffer.length <= MAX_INLINE_IMAGE_BYTES) {
      imageParts.push({
        file,
        mime: item.mime,
        bytes: buffer.length,
        base64: buffer.toString("base64"),
      });
    }
    text = text.split(item.placeholder).join(`image: ${file}`);
  }

  if (status === "ok" && sawError) status = "error";
  if (text.trim() === "") text = "(no output)";

  // The cell's source lives in the tool input; the result text is only its
  // output side. An In[n] label makes the expanded transcript read like a
  // notebook cell without repeating the source into model context. It goes in
  // before the cap so the 50 KiB budget and the full log include it.
  if (executionCount > 0) text = `In[${executionCount}]\n${text}`;

  let truncated = false;
  let logPath = null;
  const cap = Number(capBytes);
  if (Number.isFinite(cap) && cap > 0) {
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length > cap) {
      truncated = true;
      await mkdir(logsDir, { recursive: true });
      logPath = path.resolve(logsDir, `cell-${safeName(executionCount)}.log`);
      await writeFile(logPath, text);
      const headBytes = Math.floor(cap / 2);
      const tailBytes = cap - headBytes;
      const head = buffer.subarray(0, headBytes).toString("utf8");
      const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
      text =
        `${head}\n... [output elided] ...\n${tail}\n` +
        `[truncated at ${cap} bytes; full log: ${logPath}]`;
    }
  }

  return { text, images, imageParts, truncated, logPath, status, executionCount };
}
