// fusion-channel plugin package.
//
// The bidirectional Fusion channel. The TUI "/steer" command is a single
// entry point: bare invocation opens a picker over direct children,
// "/steer [agent|session-id] <message>" delivers directly. Both call the
// server "steer" RPC, whose delivery/resolution/notification logic lives in
// lib/steer.js; the `steer` tool is the non-TUI path for the same logic, and
// the `report` tool lets a child write a mid-run note/question/blocker to the
// orchestrator (durable JSON-lines inbox plus live delivery). Every steer
// appends a channel-log line and surfaces a synthetic aside to the
// orchestrator. Children are tracked from session.created events via parentID
// (see lib/steer.js).
//
// Structured logging goes to ${HOME}/.local/state/opencode/fusion-channel.log
// (see lib/log.js).

import { Plugin } from "@opencode/plugin";

import { log } from "./lib/log.js";
import { createSteerModule } from "./lib/steer.js";
import { Steer } from "./rpc.ts";

export default Plugin.define({
  id: "fusion-channel",
  async setup(ctx) {
    const state = {
      closing: false,
      registrations: [],
    };

    log({ module: "channel", level: "info", msg: "setup (load/reload)" });

    // ---------------- steer module ----------------
    // The TUI /steer command talks to the server through this RPC (the server
    // command surface is deliberately NOT registered: both a keymap slash
    // command and a server command feed the same prompt slash completion, so
    // registering both would show two /steer entries). The steer tool is the
    // non-TUI path; all of them share lib/steer.js delivery logic.
    const steer = createSteerModule({ ctx });
    try {
      if (ctx.rpc && typeof ctx.rpc.register === "function") {
        const regSteerRpc = await ctx.rpc.register(Steer, {
          children: async (input) => {
            const parentSessionID =
              input && typeof input.parentSessionID === "string"
                ? input.parentSessionID
                : "";
            return {
              children: parentSessionID
                ? await steer.listChildrenForPicker(parentSessionID)
                : [],
            };
          },
          deliver: async (input) => steer.deliverRpc(input),
        });
        if (regSteerRpc) state.registrations.push(regSteerRpc);
        log({
          module: "steer",
          level: "info",
          msg: "steer rpc registered",
          registrations: state.registrations.length,
        });
      } else {
        log({
          module: "steer",
          level: "warn",
          msg: "ctx.rpc unavailable; /steer picker disabled",
        });
      }
    } catch (err) {
      log({
        module: "steer",
        level: "error",
        msg: "steer rpc registration failed",
        error: String(err && err.stack ? err.stack : err),
      });
    }
    try {
      const regSteerTools = await ctx.tool.transform((editor) => {
        editor.add(steer.tools.steer);
        editor.add(steer.tools.report);
      });
      if (regSteerTools) state.registrations.push(regSteerTools);
      log({
        module: "steer",
        level: "info",
        msg: "steer/report tools registered",
        registrations: state.registrations.length,
      });
    } catch (err) {
      log({
        module: "steer",
        level: "error",
        msg: "steer/report tool registration failed",
        error: String(err && err.stack ? err.stack : err),
      });
    }

    // ---------------- event subscription ----------------
    // Every event goes to the steer child tracker.
    async function handleEvent(event) {
      if (state.closing) return; // shutdown: stop processing events
      try {
        if (!event || typeof event.type !== "string") return;
        steer.handleEvent(event);
      } catch (err) {
        log({
          module: "steer",
          level: "error",
          msg: "event handler failed",
          error: String(err),
        });
      }
    }

    let eventIterator = null;
    void (async () => {
      try {
        const stream = ctx.event.subscribe();
        eventIterator = stream[Symbol.asyncIterator]();
        while (!state.closing) {
          const { value, done } = await eventIterator.next();
          if (done || state.closing) break;
          void handleEvent(value);
        }
      } catch (err) {
        if (!state.closing) {
          log({
            module: "steer",
            level: "error",
            msg: "event subscription ended with error",
            error: String(err),
          });
        }
      }
      try {
        if (eventIterator && typeof eventIterator.return === "function") {
          await eventIterator.return();
        }
      } catch {
        // ignore
      }
    })();

    let unloaded = false;
    return async () => {
      log({ module: "channel", level: "info", msg: "unloaded" });
      if (unloaded) return;
      unloaded = true;
      state.closing = true;
      for (const reg of state.registrations.splice(0, state.registrations.length)) {
        try {
          await reg.dispose();
        } catch {
          // ignore
        }
      }
      // close the event subscription iterator (idempotent: the while loop
      // already exits via state.closing, and a second return() is a no-op)
      try {
        if (eventIterator && typeof eventIterator.return === "function") {
          await eventIterator.return();
          eventIterator = null;
        }
      } catch {
        // ignore
      }
      log({ module: "channel", level: "info", msg: "cleanup complete" });
    };
  },
});
