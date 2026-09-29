// fusion-tools: steer module.
//
// Tracks subagent sessions per parent from session.created events (child
// sessions carry parentID; both observed shapes - legacy properties.info
// `{id, parentID}` and flat v2 data `{sessionID, parentID}` - resolve to
// one info object, hedged exactly as in the fusion-audit plugin)
// and registers the /steer command: it forwards a short steering message to
// the most recently created still-running child session of the calling
// session via ctx.session.prompt({delivery: "steer"}).
//
// "Still running" is best-effort: a child counts as running unless the
// plugin observed a session.idle event for it. If several children are
// running, the latest one is steered and the confirmation says so. Feedback
// goes back to the parent as a synthetic aside carrying fusionTools
// metadata ("steer"), which the render self-filter drops from advisor
// reviews.
//
// State is in-memory per plugin generation (best-effort by design; a hot
// reload restarts tracking). The module is independent of advisor.enabled:
// it registers whenever the plugin loads.

import { log } from "./log.js";

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

export function createSteerModule({ ctx }) {
  const children = new Map(); // parentSessionID -> [childSessionID, ...] in creation order
  const seenIdle = new Set(); // child sessionIDs observed idle

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
        // The idle event carries the sessionID flat (advisor code reads
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

  // Feedback aside for the parent. fusionTools metadata keeps it out of
  // advisor transcript renders (render.js self-filter).
  async function feedback(parentSessionID, text) {
    try {
      await ctx.session.synthetic({
        sessionID: parentSessionID,
        text,
        description: "steer command",
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

  const steerCommand = {
    name: "steer",
    description: "Steer the most recent still-running subagent of this session: /steer <text>",
    execute: async (input) => {
      const parentSessionID = input && input.sessionID;
      try {
        const raw =
          input && input.prompt && typeof input.prompt.text === "string"
            ? input.prompt.text
            : "";
        // Accept both the bare args and the full line ("/steer <text>").
        const text = String(raw)
          .trim()
          .replace(/^\/steer\b/i, "")
          .trim();
        if (!parentSessionID) return;
        if (!text) {
          await feedback(parentSessionID, "steer: usage - /steer <message for the running subagent>");
          return;
        }
        const running = runningChildren(parentSessionID);
        if (running.length === 0) {
          await feedback(parentSessionID, "steer: no running subagent");
          return;
        }
        const target = running[running.length - 1];
        await ctx.session.prompt({ sessionID: target, text, delivery: "steer" });
        const note =
          running.length > 1
            ? "steer delivered to the most recent of " +
              running.length +
              " running subagents (" +
              target +
              ")."
            : "steer delivered to subagent " + target + ".";
        await feedback(parentSessionID, note);
        log({
          module: "steer",
          level: "info",
          msg: "steer delivered",
          parentSessionID,
          childSessionID: target,
          runningChildren: running.length,
        });
      } catch (err) {
        log({
          module: "steer",
          level: "error",
          msg: "steer command failed",
          parentSessionID: parentSessionID || null,
          error: String(err && err.stack ? err.stack : err),
        });
        if (parentSessionID) {
          await feedback(parentSessionID, "steer failed: " + String(err).slice(0, 200));
        }
      }
    },
  };

  return { command: steerCommand, handleEvent, runningChildren };
}
