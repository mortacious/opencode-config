// fusion-audit: read-only observability for the Fusion delegation tree.
// opencode's tool hooks do NOT expose the calling agent, so this plugin
// cannot enforce who-does-what (permissions do that). It logs the shape of
// delegation - subagent sessions as they spawn, and edit/write/apply_patch tool calls -
// so a maintainer can audit that the main agent delegated instead of editing.
// Logs go through console under the service prefix "fusion-audit"; view them in
// opencode's logs. This is an aid on top of the ground-truth session DB.

// v2 port of the opencode plugin SDK (v1 exported an async ({ client }) => hooks
// function; v2 requires the standard definition form with { id, setup } and
// exposes the same data through ctx.event / ctx.tool instead of v1's hook names).

import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Sink file, mirroring fusion-tools' private JSONL logger: Promise plugins in
// v2 cannot reach the opencode log file (upstream anomalyco/opencode#27285),
// so this file is the observable record. Best-effort: never throws, creates
// the parent directory on demand.
const SINK_FILE = path.join(homedir(), ".local", "state", "opencode", "fusion-audit.log");
let sinkDirReady = null; // last directory successfully created

// Appends one JSON line to the sink; any I/O failure is swallowed so a log
// write can never throw into a plugin hook. Mirrors fusion-tools/lib/log.js.
const appendSink = (record) => {
  let line;
  try {
    line = JSON.stringify(record) + "\n";
  } catch {
    // cyclic/non-serializable record: do not throw over logging
    return;
  }
  try {
    appendFileSync(SINK_FILE, line);
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  const dir = path.dirname(SINK_FILE);
  if (sinkDirReady !== dir) {
    try {
      mkdirSync(dir, { recursive: true });
      sinkDirReady = dir;
    } catch {
      // best-effort only
    }
  }
  try {
    appendFileSync(SINK_FILE, line);
  } catch {
    // still failing - give up silently
  }
};

export default Plugin.define({
  id: "fusion-audit",
  async setup(ctx) {
    // v2 port: client.app.log equivalent not found in @opencode/plugin typings
    // - logging routed to console
    const log = (message, extra) => {
      const record = { service: "fusion-audit", level: "info", message, extra };
      console.log(JSON.stringify(record));
      appendSink(record);
    };
    const messagesBySession = new Map();

    // Drain every server event and dispatch it the same way the v1
    // event(event) hook did. SubscribeOptions.signal is the v2 replacement
    // for the disposable/registration-based hooks: the AbortSignal lets the
    // cleanup function returned by setup() cancel the SSE subscription.
    const controller = new AbortController();
    const eventStream = ctx.event.subscribe({ signal: controller.signal });
    (async () => {
      try {
        for await (const event of eventStream) {
          if (!event) continue;
          // v1 invoked the event handler once per event, so a guard could
          // bail out of a single event and still see the next one. This
          // drained for-await loop processes every event inline instead, so
          // a bad event must only skip itself via `continue;` - an early
          // exit here would kill the subscription for the rest of the
          // process lifetime. The dispatch is additionally wrapped in a
          // try/catch: a per-event failure is logged and the loop keeps
          // iterating instead of dying on the first malformed event.
          try {
            if (event.type === "session.created") {
              const info = event.properties?.info ?? event.data ?? {};
              // A child session (has parentID) is a delegation.
              // Root sessions have none.
              if (info.parentID) {
                log("subagent session spawned", {
                  sessionID: info.id ?? info.sessionID,
                  parentID: info.parentID,
                  title: info.title,
                });
              }
            }
            // Per-step token attribution: each assistant step emits a
            // started/ended event pair; the started event seeds the
            // per-message entry, the ended event accumulates its token
            // and cost counts into it.
            if (event.type === "session.step.started") {
              const info = event.data ?? event.properties;
              if (!info) continue;
              if (
                typeof info.assistantMessageID !== "string" ||
                typeof info.sessionID !== "string" ||
                typeof info.agent !== "string" ||
                typeof info.model?.id !== "string"
              ) continue;
              const messages = messagesBySession.get(info.sessionID) ?? new Map();
              messages.set(info.assistantMessageID, {
                agent: info.agent,
                modelID: info.model.id,
                providerID: typeof info.model.providerID === "string" ? info.model.providerID : undefined,
                input: 0,
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
              });
              messagesBySession.set(info.sessionID, messages);
            }
            if (event.type === "session.step.ended") {
              const info = event.data ?? event.properties;
              if (!info) continue;
              if (
                typeof info.assistantMessageID !== "string" ||
                typeof info.sessionID !== "string"
              ) continue;
              const messages = messagesBySession.get(info.sessionID);
              const entry = messages?.get(info.assistantMessageID);
              if (!entry || !messages) continue;
              const tokens = info.tokens;
              if (Number.isFinite(tokens?.input)) entry.input += tokens.input;
              if (Number.isFinite(tokens?.output)) entry.output += tokens.output;
              if (Number.isFinite(tokens?.reasoning)) entry.reasoning += tokens.reasoning;
              if (Number.isFinite(tokens?.cache?.read)) entry.cacheRead += tokens.cache.read;
              if (Number.isFinite(tokens?.cache?.write)) entry.cacheWrite += tokens.cache.write;
              if (Number.isFinite(info.cost)) entry.cost += info.cost;
            }
            if (event.type === "session.step.failed") {
              const info = event.data ?? event.properties;
              if (!info) continue;
              if (
                typeof info.assistantMessageID !== "string" ||
                typeof info.sessionID !== "string"
              ) continue;
              const messages = messagesBySession.get(info.sessionID);
              const entry = messages?.get(info.assistantMessageID);
              if (!entry || !messages) continue;
              const tokens = info.tokens;
              if (Number.isFinite(tokens?.input)) entry.input += tokens.input;
              if (Number.isFinite(tokens?.output)) entry.output += tokens.output;
              if (Number.isFinite(tokens?.reasoning)) entry.reasoning += tokens.reasoning;
              if (Number.isFinite(tokens?.cache?.read)) entry.cacheRead += tokens.cache.read;
              if (Number.isFinite(tokens?.cache?.write)) entry.cacheWrite += tokens.cache.write;
              if (Number.isFinite(info.cost)) entry.cost += info.cost;
            }
            if (event.type === "session.idle") {
              const sessionID = event.properties?.sessionID ?? event.data?.sessionID;
              const messages = messagesBySession.get(sessionID);
              if (!messages?.size) continue;

              const totals = new Map();
              for (const item of messages.values()) {
                const key = `${item.agent}\u0000${item.modelID}`;
                const total = totals.get(key) ?? {
                  agent: item.agent,
                  modelID: item.modelID,
                  ...(item.providerID ? { providerID: item.providerID } : {}),
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                };
                total.input += item.input;
                total.output += item.output;
                total.reasoning += item.reasoning;
                total.cacheRead += item.cacheRead;
                total.cacheWrite += item.cacheWrite;
                if (item.cost !== undefined) total.cost = (total.cost ?? 0) + item.cost;
                totals.set(key, total);
              }

              messagesBySession.delete(sessionID);
              const usage = [...totals.values()].sort(
                (a, b) => a.agent.localeCompare(b.agent) || a.modelID.localeCompare(b.modelID)
              );
              log("session token usage", { sessionID, usage });
            }
          } catch (error) {
            // A dispatch failure affects only this event: log and move on
            // to the next one, never propagate, never drop the stream.
            log("event dispatch error", {
              eventType: event.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        // Subscription-level failure. The abort raised by the cleanup
        // function cancelling the stream is normal shutdown and is silently
        // ignored; any subscription-level exception is logged instead of
        // rethrown - rethrowing here becomes an unhandled rejection that
        // can crash the host process, which is unacceptable for a
        // read-only observability plugin.
        if (!controller.signal.aborted) {
          log("event drain error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    // Aggregate the file-mutating and delegation tools for the audit trail.
    // "apply_patch" is the third mutation tool gated by the edit permission.
    // The hook call resolves to a Registration whose dispose must be awaited
    // during cleanup, or the tool hook stays registered after the plugin
    // releases everything else.
    const toolHookRegistration = await ctx.tool.hook("execute.after", async (input) => {
      if (
        input.tool === "edit" ||
        input.tool === "write" ||
        input.tool === "apply_patch" ||
        input.tool === "task"
      ) {
        log("tool executed", { tool: input.tool, sessionID: input.sessionID });
      }
    });

    // v2 cleanup: aborts the event subscription, releases the Map, and
    // disposes the tool hook registration.
    return async () => {
      controller.abort();
      messagesBySession.clear();
      await toolHookRegistration?.dispose?.();
    };
  },
});
