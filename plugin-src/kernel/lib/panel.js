// Pure helpers for the /kernel TUI panel.
//
// The panel asks the `cells` RPC for a snapshot (meta plus the last `limit`
// cell/boundary records) and then applies live `cell` events on top. These
// functions keep that merge and the journal-to-render-descriptor mapping out
// of the Solid component so node --test can cover them without a renderer.
//
// Journal shapes (see lib/journal.js and host.py):
//   cell     {v, type:"cell", execution_count, source, outputs, truncated}
//   boundary {v, type:"boundary", text}
//
// All files ASCII only.

const MAX_IMAGES = 3;
const IMAGE_MIMES = ["image/png", "image/jpeg"];
// The journal replaces a capped image payload with this literal and sets
// cell.truncated; such a payload is also not base64, so both checks guard.
const TRUNCATED_IMAGE_TEXT = "[truncated image data]";
const BASE64_PAYLOAD = /^[A-Za-z0-9+/=\s]*$/;

// ipykernel colorizes tracebacks and programs colorize stdout; escape
// sequences are meaningless inside a renderable, so drop them here.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function plain(value) {
  return String(value).replace(ANSI_OSC, "").replace(ANSI_ESCAPE, "");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Jupyter multiformat values are a string or an array of strings.
function textValue(value) {
  if (Array.isArray(value)) return value.map((part) => String(part)).join("");
  if (typeof value === "string") return value;
  return null;
}

// Record equality for the live/fetch race. Both sides come from JSON.parse of
// the same journal line, so key order matches and stringify is stable.
function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Append one live cell record unless it is the record already at the tail.
 * The tail check is what stops a `cell` event from duplicating a record the
 * in-flight `cells` fetch also returned. Returns a new array on append and the
 * input array unchanged on a duplicate.
 */
export function mergeCell(cells, cell) {
  const list = Array.isArray(cells) ? cells : [];
  if (!isObject(cell)) return list;
  const last = list.length > 0 ? list[list.length - 1] : null;
  if (last !== null && sameRecord(last, cell)) return list;
  return [...list, cell];
}

/**
 * Ordered render descriptors for one journal record:
 *   {kind:"text", text, muted?}            stream text or text/plain
 *   {kind:"markdown", text}                text/markdown
 *   {kind:"image", mime, dataUri}          image/png or image/jpeg
 *   {kind:"error", ename, evalue, traceback}
 *   {kind:"boundary", text}                reset divider
 *
 * At most three images render per cell; any further images collapse into one
 * trailing muted "+N more image(s)" text descriptor. A payload that is not
 * base64 (the journal's `[truncated image data]` cap) renders as a muted text
 * placeholder instead of an undecodable image; a cell flagged truncated for
 * its text stream alone keeps its intact base64 payload and still renders.
 * text/html is ignored:
 * the panel has no HTML renderer. When a result carries both text/markdown and
 * text/plain, markdown wins so the same value is not printed twice.
 */
export function outputParts(cell) {
  if (!isObject(cell)) return [];
  if (cell.type === "boundary") {
    const text =
      typeof cell.text === "string" && cell.text !== "" ? cell.text : "Kernel reset";
    return [{ kind: "boundary", text }];
  }

  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const parts = [];
  let images = 0;
  let skippedImages = 0;

  for (const output of outputs) {
    if (!isObject(output)) continue;
    const type = output.output_type;

    if (type === "stream") {
      const text = typeof output.text === "string" ? plain(output.text) : "";
      if (text !== "") parts.push({ kind: "text", text });
      continue;
    }

    if (type === "execute_result" || type === "display_data") {
      const data = isObject(output.data) ? output.data : {};
      const markdown = textValue(data["text/markdown"]);
      const text = textValue(data["text/plain"]);
      if (markdown !== null && markdown !== "") {
        parts.push({ kind: "markdown", text: plain(markdown) });
      } else if (text !== null && text !== "") {
        parts.push({ kind: "text", text: plain(text) });
      }
      for (const mime of IMAGE_MIMES) {
        const encoded = data[mime];
        if (typeof encoded !== "string" || encoded === "") continue;
        if (!BASE64_PAYLOAD.test(encoded)) {
          parts.push({ kind: "text", text: TRUNCATED_IMAGE_TEXT, muted: true });
          continue;
        }
        if (images < MAX_IMAGES) {
          images += 1;
          parts.push({
            kind: "image",
            mime,
            dataUri: `data:${mime};base64,${encoded}`,
          });
        } else {
          skippedImages += 1;
        }
      }
      continue;
    }

    if (type === "error") {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.map((line) => plain(line))
        : [];
      parts.push({
        kind: "error",
        ename: typeof output.ename === "string" ? plain(output.ename) : "Error",
        evalue: typeof output.evalue === "string" ? plain(output.evalue) : "",
        traceback,
      });
    }
  }

  if (skippedImages > 0) {
    parts.push({
      kind: "text",
      text: `+${skippedImages} more image${skippedImages === 1 ? "" : "s"}`,
      muted: true,
    });
  }
  return parts;
}

/**
 * Row label: `In[n]` from the execution count (falling back to the visible
 * position), with a "(truncated)" marker when the journal capped the record.
 * Boundary records get the divider text.
 */
export function cellLabel(cell, index) {
  if (!isObject(cell)) return "In[?]";
  if (cell.type === "boundary") {
    const text =
      typeof cell.text === "string" && cell.text !== "" ? cell.text : "Kernel reset";
    return `--- ${text} ---`;
  }
  const count =
    typeof cell.execution_count === "number" && Number.isFinite(cell.execution_count)
      ? cell.execution_count
      : Number.isFinite(index)
        ? index + 1
        : 1;
  const label = `In[${count}]`;
  return cell.truncated === true ? `${label} (truncated)` : label;
}
