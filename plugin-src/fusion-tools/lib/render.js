// fusion-tools: transcript delta rendering.
// - computeDelta: cursor-based slicing of the session context message list.
// - isSelfMessage: advisor-origin filter (A10).
// - renderMessage: ASCII markdown block for one message.
// - capMessages: keep only the most recent messages that fit maxDeltaChars.
//
// Pure module: operates on plain message objects, so node:test can drive it.

const SELF_METADATA_VALUES = new Set(["advisor", "advisor-note"]);

export function isSelfMessage(msg) {
  const md = msg && msg.metadata;
  if (!md || typeof md !== "object") return false;
  const kind = md.fusionTools;
  if (typeof kind !== "string") return false;
  return kind === "advisor" || kind === "advisor-note";
}

const SUMMARY_LIMIT = 200;

function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function summarizeToolInput(input) {
  try {
    if (input === undefined || input === null) return "";
    const s = oneLine(JSON.stringify(input));
    return s.length > SUMMARY_LIMIT ? s.slice(0, SUMMARY_LIMIT) + "..." : s;
  } catch {
    return "";
  }
}

export function renderMessage(msg) {
  if (isSelfMessage(msg)) return null;
  if (!msg || typeof msg !== "object") return null;
  const type = msg.type;
  if (type === "user") {
    const text = typeof msg.text === "string" ? msg.text : "";
    return "[user] " + oneLine(text);
  }
  if (type === "synthetic") {
    const text = typeof msg.text === "string" ? msg.text : "";
    return "[synthetic] " + oneLine(text);
  }
  if (type === "assistant") {
    const agent = typeof msg.agent === "string" ? msg.agent : "";
    const lines = [];
    lines.push(agent ? "[assistant " + agent + "]" : "[assistant]");
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") {
        lines.push(oneLine(part.text || ""));
      } else if (part.type === "tool") {
        // Tool calls rendered as one line; NEVER tool results or reasoning.
        lines.push("Tool " + String(part.name || "?") + "(" + summarizeToolInput(part.state && part.state.input) + ")");
      }
      // part.type === "reasoning" -> dropped
    }
    return lines.join("\n");
  }
  // system, compaction, idle, agent/model selected, skill, shell, ...: skip
  return null;
}

export function computeDelta(messages, cursor) {
  const list = Array.isArray(messages) ? messages : [];
  if (!cursor || !cursor.lastMessageID) {
    return { slice: list, reset: true };
  }
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].id === cursor.lastMessageID) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    // cursor id gone (compaction/rewrite) -> full context, bounded by the cap
    return { slice: list, reset: true };
  }
  return { slice: list.slice(idx + 1), reset: false };
}

// Keep the most recent messages whose rendered blocks fit maxChars. Always
// keeps at least the newest block. Pure: input array is not mutated.
export function capMessages(slice, maxChars) {
  if (!Array.isArray(slice) || slice.length === 0) return [];
  const cap = maxChars | 0;
  if (cap <= 3) return slice.slice(-1);
  let budget = cap;
  const out = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    const block = renderMessage(slice[i]);
    const cost = (block ? block.length : 0) + 2; // block + "\n\n"
    if (out.length > 0 && cost > budget) break;
    budget -= cost;
    out.push({ msg: slice[i], block });
  }
  return out.reverse().map((e) => e.msg);
}

export function renderSlice(slice) {
  const parts = [];
  for (const msg of slice) {
    const block = renderMessage(msg);
    if (block !== null && block !== "") parts.push(block);
  }
  return parts.join("\n\n");
}
