// fusion-channel: steer module.
//
// Tracks subagent sessions per parent from session.created events (child
// sessions carry parentID; both observed shapes - legacy properties.info
// `{id, parentID}` and flat v2 data `{sessionID, parentID}` - resolve to
// one info object, hedged exactly as in the fusion-audit plugin)
// and exposes the Fusion channel:
//
//  - steer tool (orchestrator -> child): target a direct child by session id
//    or agent name and deliver with delivery "steer" (default) or "queue".
//  - commandText: the /steer command body shared by the TUI slash command (via
//    the "steer" RPC in index.js) and the tests. Bare invocation is handled by
//    the TUI picker, which calls the RPC with an explicit target + message.
//    `/steer <text>` delivers to the most recent running child; the first
//    token is a target only when it starts with "ses" or names a direct
//    child's agent.
//  - report tool (child -> orchestrator): append one JSON line to the durable
//    inbox (~/.local/state/opencode/fusion-inbox.jsonl) and mirror it live to
//    the parent session (delivery "steer" when priority is "now", else
//    "queue").
//
// Every successful steer - tool or command, picker or typed - appends one
// `type: "steer"` line to the same channel log and surfaces a synthetic
// aside to the orchestrating parent session, so the orchestrator knows the
// child's instruction set changed. Both notifications are best-effort: a
// delivered steer never turns into an error because a log write or aside
// failed.
//
// "Still running" is best-effort: the event tracker answers unless the
// session record carries `time.busy` / `time.idle`, which wins when present.
// If several children match by agent name and more than one is running, the
// module refuses to guess and lists the candidate ids. Feedback asides carry
// fusionTools metadata ("steer") so a consumer can recognise them.
//
// State is in-memory per plugin generation (best-effort by design; a hot
// reload restarts tracking). The module registers whenever the plugin loads.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { log } from "./log.js";

const DEFAULT_INBOX = path.join(
  homedir(),
  ".local",
  "state",
  "opencode",
  "fusion-inbox.jsonl",
);

// Durable channel-log path. Test seams: createSteerModule({inboxPath}) wins,
// else FUSION_CHANNEL_INBOX_FILE (read lazily, like lib/log.js), else the live
// state file. Tests must never append to the live file.
export function inboxFile() {
  const override = process.env.FUSION_CHANNEL_INBOX_FILE;
  if (typeof override === "string" && override.trim()) return override;
  return DEFAULT_INBOX;
}

// Append one JSON line to the inbox. Creates the state dir on demand, and
// prefixes a newline when the existing file does not end with one, so a
// previous (or externally edited) last line is never corrupted. Throws on
// real I/O failure; the caller decides how loud to be.
export function appendInboxLine(file, entry) {
  const target = typeof file === "string" && file.trim() ? file : inboxFile();
  mkdirSync(path.dirname(target), { recursive: true });
  let prefix = "";
  try {
    const st = statSync(target);
    if (st.size > 0) {
      const fd = openSync(target, "r");
      try {
        const buf = Buffer.alloc(1);
        const n = readSync(fd, buf, 0, 1, st.size - 1);
        if (n === 1 && buf[0] !== 0x0a) prefix = "\n";
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // missing file: plain append below creates it
  }
  // JSON.stringify escapes newlines, so one entry is always exactly one line.
  appendFileSync(target, prefix + JSON.stringify(entry) + "\n");
  return target;
}

// Epoch-ms from the DateTime-ish values `time.*` may carry (number, Date, or
// an object exposing getTime()). Returns null when not interpretable.
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && typeof value.getTime === "function") {
    try {
      const n = value.getTime();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

// true/false when the session record settles the question, null when it does
// not (caller falls back to the event tracker). A record with neither
// `time.busy` nor `time.idle` (created, never run) is unknown, not idle.
function recordRunning(info) {
  const t = info && typeof info === "object" ? info.time : null;
  if (!t || typeof t !== "object") return null;
  const busy = toMs(t.busy);
  const idle = toMs(t.idle);
  if (busy !== null) {
    if (idle === null) return true; // running, never finished a turn yet
    return busy > idle; // busy after the last completed execution
  }
  if (idle !== null) return false; // ran before, not running now
  return null;
}

function isSessionID(value) {
  return typeof value === "string" && value.startsWith("ses");
}

// Compact session id for user-facing asides: full id when already short,
// otherwise head + tail so the aside stays readable without losing identity.
function shortSessionID(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return "";
  if (sessionID.length <= 14) return sessionID;
  return sessionID.slice(0, 8) + "..." + sessionID.slice(-4);
}

// Resolve a session.created event to its info object across the observed
// shapes (properties.info, data.info, flat data).
function eventInfo(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties;
  if (props && props.info && typeof props.info === "object") return props.info;
  if (event.data && typeof event.data === "object") {
    if (event.data.info && typeof event.data.info === "object") return event.data.info;
    return event.data;
  }
  return null;
}

const STEER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: {
      type: "string",
      description:
        "Direct child session to steer: its session id (starts with \"ses\") or its agent name (e.g. \"sidekick\").",
    },
    message: {
      type: "string",
      description: "The steering instruction for the running child.",
    },
    delivery: {
      type: "string",
      enum: ["steer", "queue"],
      description:
        "steer (default) interrupts the child now; queue waits until its current step ends.",
    },
  },
  required: ["target", "message"],
};

const STEER_DESCRIPTION =
  "Steer a running child session of this session: target it by session id or agent name and deliver a message now (delivery \"steer\") or queued. Only direct children can be steered. Every steer is recorded in the fusion channel log and surfaced to the orchestrating parent session as a synthetic aside.";

const REPORT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description: "What the orchestrator should know, in one or two sentences.",
    },
    kind: {
      type: "string",
      enum: ["note", "question", "blocker"],
      description: "note (default) = information; question = needs an answer; blocker = cannot proceed.",
    },
    priority: {
      type: "string",
      enum: ["now", "next"],
      description: "now delivers mid-run with delivery \"steer\"; next (default) queues.",
    },
  },
  required: ["message"],
};

const REPORT_DESCRIPTION =
  "Report an important mid-task discovery to the orchestrating parent session. Durable inbox line plus live delivery (immediate for priority \"now\", queued for \"next\"). Blockers and completion still belong in your final report.";

export function createSteerModule({ ctx, inboxPath } = {}) {
  const children = new Map(); // parentSessionID -> [childSessionID, ...] in creation order
  const seenIdle = new Set(); // child sessionIDs observed idle
  const inbox = typeof inboxPath === "string" && inboxPath.trim() ? inboxPath : inboxFile();

  // Event dispatch: session.created records a child under its parent;
  // session.idle marks a child as no longer running. Never throws.
  function handleEvent(event) {
    try {
      if (!event || typeof event.type !== "string") return;
      if (event.type === "session.created") {
        const info = eventInfo(event);
        // The session-id FIELD name differs between the two observed
        // shapes: legacy v1 nests `{id, parentID}` under
        // properties.info, flat v2 carries `{sessionID, parentID}`
        // directly on event.data. eventInfo() already resolves BOTH to
        // the same single info object, so only the id key needs the
        // mutation-shape hedge (info.id ?? info.sessionID, exactly the
        // proven read in fusion-audit/index.js). parentID shares its
        // field name across both shapes and sits on the same unpacked
        // object, so one un-hedged read covers both.
        const sessionID = info && (info.id ?? info.sessionID);
        const parentID = info && info.parentID;
        if (!sessionID || !parentID) return;
        let list = children.get(parentID);
        if (!list) {
          list = [];
          children.set(parentID, list);
        }
        if (!list.includes(sessionID)) list.push(sessionID);
        return;
      }
      if (event.type === "session.idle") {
        // The idle event carries the sessionID flat (data.sessionID here;
        // data.sessionID; fusion-audit reads properties.sessionID) - not
        // nested under an info object like session.created.
        const props = event.properties;
        const data = event.data;
        const sessionID =
          (props && props.sessionID) ||
          (data && data.sessionID) ||
          (data && data.info && data.info.sessionID) ||
          null;
        if (sessionID) seenIdle.add(sessionID);
        return;
      }
    } catch {
      // never throw from an event handler
    }
  }

  // Children of the parent that have not been seen idle (most recent last).
  function runningChildren(parentSessionID) {
    const list = children.get(parentSessionID);
    if (!Array.isArray(list)) return [];
    return list.filter((id) => !seenIdle.has(id));
  }

  function trackedChildren(parentSessionID) {
    const list = children.get(parentSessionID);
    return Array.isArray(list) ? list.slice() : [];
  }

  // Feedback aside for the parent. Best-effort: a failed
  // aside is logged, never thrown.
  async function feedback(parentSessionID, text, description = "steer command") {
    try {
      await ctx.session.synthetic({
        sessionID: parentSessionID,
        text,
        description,
        metadata: { fusionTools: "steer" },
        resume: false,
      });
    } catch (err) {
      log({
        module: "steer",
        level: "warn",
        msg: "steer feedback failed",
        parentSessionID: parentSessionID || null,
        error: String(err),
      });
    }
  }

  // Durable + live notification for one delivered steer. The channel-log line
  // is appended first; the aside follows. Both failures are logged and
  // swallowed so a delivered steer stays successful.
  async function notifyDelivery({
    parentSessionID,
    targetSessionID,
    targetAgent,
    source,
    delivery,
    message,
  }) {
    const agent =
      typeof targetAgent === "string" && targetAgent ? targetAgent : null;
    const entry = {
      ts: new Date().toISOString(),
      type: "steer",
      parentSessionID,
      targetSessionID,
      targetAgent: agent,
      source,
      delivery,
      message,
    };
    try {
      appendInboxLine(inbox, entry);
    } catch (err) {
      log({
        module: "steer",
        level: "error",
        msg: "steer channel-log append failed",
        parentSessionID,
        targetSessionID,
        inbox,
        error: String(err),
      });
    }
    await feedback(
      parentSessionID,
      "steer delivered to " +
        (agent || "child") +
        " (" +
        shortSessionID(targetSessionID) +
        ") via " +
        source +
        ": " +
        message,
      source === "tool" ? "steer tool" : "steer command",
    );
  }

  // One session record by id, or null (lookup failures are recoverable).
  async function sessionInfo(sessionID) {
    try {
      const info = await ctx.session.get({ sessionID });
      return info && typeof info === "object" ? info : null;
    } catch (err) {
      log({
        module: "steer",
        level: "warn",
        msg: "session lookup failed",
        sessionID,
        error: String(err),
      });
      return null;
    }
  }

  function infoID(info) {
    if (!info || typeof info !== "object") return null;
    return info.id ?? info.sessionID ?? null;
  }

  // Direct children of parentSessionID as session records. Prefers the list
  // API; falls back to the event-tracked map when the call is unavailable or
  // fails, and unions tracked ids the list may not have returned yet.
  async function listChildren(parentSessionID) {
    const out = new Map(); // childSessionID -> info
    let listed = null;
    try {
      if (ctx.session && typeof ctx.session.list === "function") {
        const res = await ctx.session.list({ parentID: parentSessionID });
        listed = Array.isArray(res) ? res : res && Array.isArray(res.data) ? res.data : [];
      }
    } catch (err) {
      listed = null;
      log({
        module: "steer",
        level: "warn",
        msg: "session list failed (falling back to event tracking)",
        parentSessionID,
        error: String(err),
      });
    }
    for (const info of listed || []) {
      const id = infoID(info);
      if (!id) continue;
      const parentID = info && typeof info === "object" ? info.parentID : null;
      // The query already filtered by parentID; only reject a record that
      // explicitly names a different parent.
      if (parentID && parentID !== parentSessionID) continue;
      out.set(id, info);
    }
    for (const id of trackedChildren(parentSessionID)) {
      if (out.has(id)) continue;
      const info = await sessionInfo(id);
      if (info) {
        const parentID = info.parentID;
        if (parentID && parentID !== parentSessionID) continue;
        out.set(id, info);
      }
    }
    return [...out.values()];
  }

  // Running signal for one child: the record's timing wins when present,
  // otherwise the session.idle tracker answers.
  function childRunning(info, sessionID, parentSessionID) {
    const rec = recordRunning(info);
    if (rec !== null) return rec;
    return runningChildren(parentSessionID).includes(sessionID);
  }

  function agentOf(info, hint) {
    if (info && typeof info.agent === "string" && info.agent) return info.agent;
    return typeof hint === "string" && hint ? hint : null;
  }

  function candidateIDs(list) {
    return list
      .map((child) => infoID(child))
      .filter((id) => typeof id === "string");
  }

  // Resolve a target among the parent's direct children. Returns {info} on
  // success or {content, candidates?} with the refusal text shared by the tool
  // and the command path. A "ses" target is exact-first, then a prefix match
  // over direct children; an agent name prefers the single running child.
  async function resolveChild(parentSessionID, target) {
    if (isSessionID(target)) {
      const exact = await sessionInfo(target);
      if (exact) {
        if (exact.parentID !== parentSessionID) {
          return {
            content:
              "steer: " +
              target +
              " is not a direct child of this session (parent " +
              (typeof exact.parentID === "string" && exact.parentID
                ? exact.parentID
                : "none") +
              "); only direct children can be steered.",
          };
        }
        return { info: exact };
      }
      const matches = (await listChildren(parentSessionID)).filter((child) => {
        const id = infoID(child);
        return typeof id === "string" && id.startsWith(target);
      });
      if (matches.length === 0) {
        return {
          content:
            "steer: could not resolve session " + target + "; nothing was delivered.",
        };
      }
      if (matches.length > 1) {
        const candidates = candidateIDs(matches);
        return {
          content:
            "steer: " +
            matches.length +
            " children match session " +
            target +
            ": " +
            candidates.join(", ") +
            ". Retarget by full session id.",
          candidates,
        };
      }
      return { info: matches[0] };
    }

    const matches = (await listChildren(parentSessionID)).filter(
      (child) => child && child.agent === target,
    );
    if (matches.length === 0) {
      return { content: "steer: no child matching " + target };
    }
    const running = matches.filter((child) =>
      childRunning(child, infoID(child), parentSessionID),
    );
    const candidates = candidateIDs(running.length > 0 ? running : matches);
    if (running.length > 1) {
      return {
        content:
          "steer: " +
          running.length +
          " running children match " +
          target +
          ": " +
          candidates.join(", ") +
          ". Retarget by session id.",
        candidates,
      };
    }
    if (running.length === 1) return { info: running[0] };
    if (matches.length === 1) return { info: matches[0] };
    return {
      content:
        "steer: " +
        matches.length +
        " children match " +
        target +
        " and none are running: " +
        candidates.join(", ") +
        ". Retarget by session id.",
      candidates,
    };
  }

  // Deliver to an already resolved child, then run the durable + live steer
  // notification. The API call is the only step that can fail the steer; the
  // notification is best-effort by construction.
  async function deliverResolved(
    parentSessionID,
    info,
    message,
    delivery,
    source,
    agentHint,
  ) {
    const targetSessionID = infoID(info);
    if (!targetSessionID) {
      return {
        ok: false,
        error: "steer: resolved child has no session id; nothing was delivered.",
      };
    }
    const targetAgent = agentOf(info, agentHint);
    try {
      await ctx.session.prompt({
        sessionID: targetSessionID,
        text: message,
        delivery,
      });
    } catch (err) {
      log({
        module: "steer",
        level: "warn",
        msg: "steer delivery failed",
        parentSessionID,
        targetSessionID,
        delivery,
        error: String(err),
      });
      return {
        ok: false,
        error: "steer: delivery to " + targetSessionID + " failed: " + String(err),
        targetSessionID,
      };
    }
    await notifyDelivery({
      parentSessionID,
      targetSessionID,
      targetAgent,
      source,
      delivery,
      message,
    });
    log({
      module: "steer",
      level: "info",
      msg: "steer delivered",
      parentSessionID,
      targetSessionID,
      agent: targetAgent,
      source,
      delivery,
    });
    return { ok: true, targetSessionID, agent: targetAgent, delivery };
  }

  async function steerTarget({ parentSessionID, target, message, delivery, source }) {
    const resolved = await resolveChild(parentSessionID, target);
    if (resolved.content) {
      return {
        ok: false,
        error: resolved.content,
        candidates: resolved.candidates || [],
      };
    }
    return deliverResolved(
      parentSessionID,
      resolved.info,
      message,
      delivery,
      source,
      isSessionID(target) ? null : target,
    );
  }

  // Parse "/steer ..." arguments. The first token is a target ONLY when it
  // starts with "ses" or is the agent name of a direct child; otherwise the
  // whole text is the message. This keeps a message that happens to begin
  // with an agent name from being misrouted when no such child exists.
  async function parseCommandText(parentSessionID, text) {
    const space = text.search(/\s/);
    const head = space === -1 ? text : text.slice(0, space);
    const rest = space === -1 ? "" : text.slice(space + 1).trim();
    if (isSessionID(head)) return { target: head, message: rest };
    if (head) {
      const kids = await listChildren(parentSessionID);
      if (kids.some((child) => child && child.agent === head)) {
        return { target: head, message: rest };
      }
    }
    return { target: null, message: text };
  }

  async function runCommandText(parentSessionID, rawText) {
    const text = String(rawText == null ? "" : rawText)
      .trim()
      .replace(/^\/steer\b/i, "")
      .trim();
    if (!text) {
      return { ok: false, error: "steer: usage - /steer [agent|session-id] <message>" };
    }
    const parsed = await parseCommandText(parentSessionID, text);
    if (parsed.target) {
      if (!parsed.message) {
        return { ok: false, error: "steer: usage - /steer <target> <message>" };
      }
      return steerTarget({
        parentSessionID,
        target: parsed.target,
        message: parsed.message,
        delivery: "steer",
        source: "command",
      });
    }
    const running = runningChildren(parentSessionID);
    if (running.length === 0) {
      return { ok: false, error: "steer: no running subagent" };
    }
    const targetSessionID = running[running.length - 1];
    const info = (await sessionInfo(targetSessionID)) || { id: targetSessionID };
    return deliverResolved(
      parentSessionID,
      info,
      text,
      "steer",
      "command",
      null,
    );
  }

  // /steer command body: same delivery path as the tool, plus the command's
  // failure feedback aside. Never throws.
  async function commandText(parentSessionID, rawText) {
    if (!parentSessionID) return { ok: false, error: "steer: no calling session." };
    let result;
    try {
      result = await runCommandText(parentSessionID, rawText);
    } catch (err) {
      log({
        module: "steer",
        level: "error",
        msg: "steer command failed",
        parentSessionID,
        error: String(err && err.stack ? err.stack : err),
      });
      result = { ok: false, error: "steer failed: " + String(err).slice(0, 200) };
    }
    if (!result.ok && result.error) {
      await feedback(parentSessionID, result.error);
    }
    return result;
  }

  // Direct children for the /steer picker, running first (stable within each
  // group). Agent is "unknown" rather than null so the RPC output schema stays
  // string-typed.
  async function listChildrenForPicker(parentSessionID) {
    const rows = [];
    for (const child of await listChildren(parentSessionID)) {
      const sessionID = infoID(child);
      if (typeof sessionID !== "string") continue;
      rows.push({
        sessionID,
        agent: agentOf(child, null) || "unknown",
        running: childRunning(child, sessionID, parentSessionID),
      });
    }
    rows.sort((a, b) => Number(b.running) - Number(a.running));
    return rows;
  }

  // Strip null/undefined optional fields so the result always satisfies the
  // RPC output JSON schema (e.g. an unknown target agent must be omitted, not
  // sent as null).
  function rpcResult(result) {
    const out = { ok: Boolean(result && result.ok) };
    if (result && typeof result.targetSessionID === "string") {
      out.targetSessionID = result.targetSessionID;
    }
    if (result && typeof result.agent === "string") out.agent = result.agent;
    if (result && (result.delivery === "steer" || result.delivery === "queue")) {
      out.delivery = result.delivery;
    }
    if (result && typeof result.error === "string") out.error = result.error;
    if (result && Array.isArray(result.candidates)) {
      out.candidates = result.candidates.filter(
        (id) => typeof id === "string",
      );
    }
    return out;
  }

  // RPC entry point used by the TUI /steer command. `input` (raw arguments
  // after "/steer") takes the command parsing path; target + message is the
  // picker path. Delivery, resolution and notification stay here.
  async function deliverRpc(input) {
    const parentSessionID =
      input && typeof input.parentSessionID === "string"
        ? input.parentSessionID.trim()
        : "";
    const source = input && input.source === "tool" ? "tool" : "command";
    const delivery = input && input.delivery === "queue" ? "queue" : "steer";
    if (!parentSessionID) {
      return { ok: false, error: "steer: parent session is required." };
    }
    if (input && typeof input.input === "string") {
      return rpcResult(await commandText(parentSessionID, input.input));
    }
    const target =
      input && typeof input.target === "string" ? input.target.trim() : "";
    const message = input && typeof input.message === "string" ? input.message : "";
    if (!target) {
      return {
        ok: false,
        error: "steer: target is required (session id or agent name).",
      };
    }
    if (!message.trim()) {
      return { ok: false, error: "steer: message is required." };
    }
    const result = await steerTarget({
      parentSessionID,
      target,
      message,
      delivery,
      source,
    });
    if (!result.ok && result.error) {
      await feedback(parentSessionID, result.error);
    }
    return rpcResult(result);
  }

  const steerTool = {
    name: "steer",
    description: STEER_DESCRIPTION,
    // codemode: false -> expose as a DIRECT session tool (default plugin
    // tools are routed through Code Mode only and never reach a plain
    // session's function list).
    options: { codemode: false },
    input: STEER_INPUT_SCHEMA,
    execute: async (input, context) => {
      try {
        const parentSessionID = context && context.sessionID;
        if (!parentSessionID) {
          return { content: "steer: no calling session; nothing was delivered." };
        }
        const target = input && typeof input.target === "string" ? input.target.trim() : "";
        const message = input && typeof input.message === "string" ? input.message : "";
        const delivery = input && input.delivery === "queue" ? "queue" : "steer";
        if (!target) {
          return { content: "steer: target is required (session id or agent name)." };
        }
        if (!message.trim()) {
          return { content: "steer: message is required." };
        }

        const result = await steerTarget({
          parentSessionID,
          target,
          message,
          delivery,
          source: "tool",
        });
        if (!result.ok) {
          return { content: result.error };
        }
        return {
          content:
            "steer delivered to " +
            (result.agent || "child") +
            " (" +
            result.targetSessionID +
            ") via " +
            result.delivery +
            ".",
          metadata: {
            targetSessionID: result.targetSessionID,
            agent: result.agent,
            delivery: result.delivery,
          },
        };
      } catch (err) {
        log({
          module: "steer",
          level: "error",
          msg: "steer tool failed",
          error: String(err && err.stack ? err.stack : err),
        });
        return { content: "steer: failed: " + String(err) };
      }
    },
  };

  const reportTool = {
    name: "report",
    description: REPORT_DESCRIPTION,
    options: { codemode: false },
    input: REPORT_INPUT_SCHEMA,
    execute: async (input, context) => {
      try {
        const sessionID = context && context.sessionID;
        if (!sessionID) {
          return { content: "report: no calling session; the message was not sent." };
        }
        const message = input && typeof input.message === "string" ? input.message : "";
        if (!message.trim()) {
          return { content: "report: message is required." };
        }
        const kind =
          input && (input.kind === "question" || input.kind === "blocker")
            ? input.kind
            : "note";
        const priority = input && input.priority === "now" ? "now" : "next";

        let info = null;
        let lookupError = null;
        try {
          info = await ctx.session.get({ sessionID });
        } catch (err) {
          lookupError = err;
        }
        const parentSessionID =
          info && typeof info.parentID === "string" && info.parentID
            ? info.parentID
            : null;
        const agent = info && typeof info.agent === "string" ? info.agent : "unknown";
        if (!parentSessionID) {
          return {
            content:
              "report: this session has no orchestrator parent" +
              (lookupError ? " (parent lookup failed: " + String(lookupError) + ")" : "") +
              "; the message was not sent.",
          };
        }

        // Durable channel first: one JSON line, even if the live mirror fails.
        const entry = {
          ts: new Date().toISOString(),
          parentSessionID,
          fromSessionID: sessionID,
          agent,
          kind,
          priority,
          message,
        };
        let durable = false;
        let inboxError = null;
        try {
          appendInboxLine(inbox, entry);
          durable = true;
        } catch (err) {
          inboxError = err;
          log({
            module: "steer",
            level: "error",
            msg: "report inbox append failed",
            fromSessionID: sessionID,
            inbox,
            error: String(err),
          });
        }

        const text =
          "[report kind=" +
          kind +
          " from=" +
          agent +
          " session=" +
          sessionID +
          "] " +
          message;
        const delivery = priority === "now" ? "steer" : "queue";
        try {
          await ctx.session.prompt({ sessionID: parentSessionID, text, delivery });
        } catch (err) {
          log({
            module: "steer",
            level: "warn",
            msg: "report live delivery failed (inbox only)",
            fromSessionID: sessionID,
            parentSessionID,
            durable,
            error: String(err),
          });
          return {
            content:
              "report: live delivery to the orchestrator failed (" +
              String(err) +
              "); " +
              (durable
                ? "delivered to the inbox only (" + inbox + ")."
                : "the inbox write also failed" +
                  (inboxError ? " (" + String(inboxError) + ")" : "") +
                  "; the message was lost."),
            metadata: { parentSessionID, kind, priority, live: false },
          };
        }
        log({
          module: "steer",
          level: "info",
          msg: "report delivered",
          fromSessionID: sessionID,
          parentSessionID,
          kind,
          priority,
          live: true,
        });
        return {
          content:
            "report delivered to the orchestrator (" +
            parentSessionID +
            ") live via " +
            delivery +
            (durable ? " and recorded in the inbox" : "") +
            ".",
          metadata: { parentSessionID, kind, priority, live: true },
        };
      } catch (err) {
        log({
          module: "steer",
          level: "error",
          msg: "report tool failed",
          error: String(err && err.stack ? err.stack : err),
        });
        return { content: "report: failed: " + String(err) };
      }
    },
  };

  return {
    handleEvent,
    runningChildren,
    listChildrenForPicker,
    commandText,
    deliverRpc,
    tools: { steer: steerTool, report: reportTool },
  };
}
