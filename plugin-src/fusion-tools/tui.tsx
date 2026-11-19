// fusion-tools: TUI plugin (plugin id "fusion-tools.tui").
//
// ONE /steer entry point:
//  - "/steer <args>" forwards the raw arguments to the server "steer" RPC
//    (source "command"); the server parses target/message, resolves the child,
//    delivers, appends the channel-log line and notifies the orchestrator.
//  - "/steer" (no arguments) opens a picker over the active session's direct
//    children (running first), then a prompt for the message, and delivers
//    through the SAME RPC with an explicit target.
//
// The server command registration was removed on purpose: in 2.3.2 both a
// keymap slash command and a server command feed the same prompt slash
// completion (packages/tui/src/component/prompt/autocomplete.tsx appends
// keymapCommands() results and data.location.command.list() results without
// dedupe), so keeping both would show two "/steer" entries. Typed arguments
// are dispatched to the keymap command first
// (packages/tui/src/component/prompt/index.tsx argumentSlash branch), so the
// keymap command is the single surface and the steer tool remains the
// non-TUI path.
//
// Resilience mirrors profile-switcher/tui.tsx: setup runs outside the host's
// Solid component tree, so keymap.layer() is called from an always-mounted
// app slot's onMount; every registration and dialog failure is caught and
// surfaced (or logged), never thrown.
//
// All files ASCII only.

import { onMount } from "solid-js";

import { Plugin } from "@opencode/plugin/tui";

import {
  Steer,
  type SteerChild,
  type SteerChildrenResult,
  type SteerDeliverResult,
} from "./rpc.js";

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Display-only compaction of a session id (matches the server aside).
function shortSessionID(sessionID: string): string {
  if (sessionID.length <= 14) return sessionID;
  return sessionID.slice(0, 8) + "..." + sessionID.slice(-4);
}

export default Plugin.define({
  id: "fusion-tools.tui",
  async setup(context) {
    const rpc = context.client.rpc(Steer);

    // Same routing-scope convention as profile-switcher/tui.tsx: the verified
    // routing key is the x-opencode-directory request header, not the typed
    // location option.
    function rpcOptions():
      | { headers: { "x-opencode-directory": string } }
      | undefined {
      const directory = context.location?.directory;
      if (typeof directory !== "string" || !directory) return undefined;
      return {
        headers: { "x-opencode-directory": encodeURIComponent(directory) },
      };
    }

    function alert(message: string): void {
      try {
        void context.ui.dialog
          .alert({ title: "Steer", message })
          .catch((err: unknown) => {
            console.warn(
              "[fusion-tools.tui] steer alert failed: " + errorText(err),
            );
          });
      } catch (err) {
        console.warn("[fusion-tools.tui] steer alert failed: " + errorText(err));
      }
    }

    async function deliver(
      parentSessionID: string,
      request: {
        input?: string;
        target?: string;
        message?: string;
      },
    ): Promise<SteerDeliverResult> {
      const result = (await rpc.deliver(
        {
          parentSessionID,
          delivery: "steer",
          source: "command",
          ...request,
        },
        rpcOptions(),
      )) as SteerDeliverResult;
      if (result?.ok) {
        alert(
          "Steer delivered to " +
            (result.agent || "child") +
            " (" +
            shortSessionID(result.targetSessionID || "") +
            ")",
        );
      } else {
        alert(result?.error || "Steer failed");
      }
      return result;
    }

    async function pickAndDeliver(parentSessionID: string): Promise<void> {
      const listed = (await rpc.children(
        { parentSessionID },
        rpcOptions(),
      )) as SteerChildrenResult;
      const children: SteerChild[] = Array.isArray(listed?.children)
        ? listed.children
        : [];
      if (children.length === 0) {
        alert("No subagents to steer in this session");
        return;
      }
      const choice = await context.ui.dialog.select<string>({
        title: "Steer subagent",
        placeholder: "Select a subagent",
        options: children.map((child) => ({
          title: child.agent + " (" + shortSessionID(child.sessionID) + ")",
          value: child.sessionID,
          description: child.running ? "running" : "idle",
        })),
      });
      if (choice === undefined) return;
      const picked = children.find((child) => child.sessionID === choice);
      const message = await context.ui.dialog.prompt({
        title: "Steer " + (picked?.agent || "subagent"),
        placeholder: "Message for the subagent",
      });
      if (message === undefined || !message.trim()) return;
      await deliver(parentSessionID, { target: choice, message: message.trim() });
    }

    function registerKeymapLayer(): void {
      try {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "fusion-tools.steer",
              title: "Steer a subagent",
              description:
                "Send a steering message to a direct child session (bare invocation opens a picker)",
              group: "Fusion",
              palette: true,
              slash: { name: "steer", arguments: true },
              run: async (input) => {
                try {
                  const route = context.ui.router.current();
                  if (route.type !== "session") {
                    alert("Open a session first");
                    return;
                  }
                  const raw = (input ?? "").trim();
                  if (raw) {
                    await deliver(route.sessionID, { input: raw });
                    return;
                  }
                  await pickAndDeliver(route.sessionID);
                } catch (err) {
                  alert("Steer failed: " + errorText(err));
                }
              },
            },
          ],
        }));
      } catch (err) {
        console.warn(
          "[fusion-tools.tui] /steer command unavailable: " + errorText(err),
        );
      }
    }

    try {
      const removeKeymapSlot = context.ui.slot({
        append: "app",
        render: () => {
          onMount(() => registerKeymapLayer());
          return null;
        },
      });
      return () => {
        try {
          removeKeymapSlot();
        } catch {
          // best-effort cleanup
        }
      };
    } catch (err) {
      console.warn(
        "[fusion-tools.tui] keymap bootstrap slot unavailable: " + errorText(err),
      );
    }
  },
});
