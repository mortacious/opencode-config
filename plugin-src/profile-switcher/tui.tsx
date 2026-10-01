// profile-switcher: TUI plugin (plugin id "profile-switcher.tui").
//
// - Slash command "/profile": with an argument -> rpc.set directly; without
//   -> ui.dialog.select over rpc list() (current profile marked), then
//   rpc.set. The result is toasted with the prefix "Profile switched: "
//   including any fallback substitutions and warnings.
// - Sidebar slot (sidebar.content): renders "Profile: <active>", initialized
//   from rpc current() and kept live by subscribing to the rpc "changed"
//   event; the subscription and the slot are unsubscribed in cleanup.
//
// Resilience: plugin setup runs OUTSIDE the host's Solid component tree, so
// context.keymap.layer() cannot be called directly (it resolves a
// Keymap.Provider from the owning component and throws otherwise). The keymap
// layer is therefore created inside an always-mounted "app" slot's component
// via onMount. Every registration is individually guarded: a failure degrades
// that one piece (logged, no throw) instead of killing the whole plugin, and
// the sidebar slot + rpc subscription still register.
//
// The shared Profile RPC definition is imported from ./rpc.ts. JSON Schema
// RPC values surface as `unknown`, so the result interfaces exported by
// ./rpc.ts are used to narrow them.
//
// All files ASCII only.

import { createSignal, onMount } from "solid-js";

import { Plugin } from "@opencode/plugin/tui";

import {
  Profile,
  type ProfileChangedEvent,
  type ProfileCurrentResult,
  type ProfileListResult,
  type ProfileSetResult,
} from "./rpc.js";

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function degrade(what: string, err: unknown): void {
  // Never surface the raw host error text here: a missing keymap provider must
  // not reintroduce its literal message into opencode logs.
  console.warn(
    "[profile-switcher.tui] " + what + " unavailable: " + errorText(err)
  );
}

export default Plugin.define({
  id: "profile-switcher.tui",
  async setup(context) {
    const disposers: Array<() => void> = [];
    let keymapRegistered = false;

    const [active, setActive] = createSignal("default");

    const rpc = context.client.rpc(Profile);

    try {
      const current = (await rpc.current({})) as ProfileCurrentResult;
      setActive(current.active);
    } catch (err) {
      context.ui.toast.show({
        message:
          "profile-switcher: cannot read active profile: " + errorText(err),
        variant: "error",
      });
    }

    try {
      const unsubscribe = rpc.events.on("changed", (event) => {
        const data = event.data as
          | ProfileChangedEvent
          | Readonly<Record<string, unknown>>;
        if (data && typeof data.active === "string") {
          setActive(data.active);
        }
      });
      disposers.push(unsubscribe);
    } catch (err) {
      degrade("changed subscription", err);
    }

    async function switchTo(name: string): Promise<void> {
      try {
        const result = (await rpc.set({ name })) as ProfileSetResult;
        let message = "Profile switched: " + result.active;
        const fallbacks = result.applied.filter((entry) => entry.fallback);
        if (fallbacks.length > 0) {
          message +=
            " (fallback: " +
            fallbacks
              .map((entry) => entry.agent + " -> " + entry.model)
              .join(", ") +
            ")";
        }
        if (result.warnings.length > 0) {
          message += "; warnings: " + result.warnings.join("; ");
        }
        context.ui.toast.show({
          message,
          variant: result.warnings.length > 0 ? "warning" : "success",
        });
      } catch (err) {
        context.ui.toast.show({
          message: "Profile switch failed: " + errorText(err),
          variant: "error",
        });
      }
    }

    function registerKeymapLayer(): void {
      if (keymapRegistered) return;
      try {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "profile-switcher.switch",
              title: "Switch opencode profile",
              group: "Profile",
              palette: true,
              slash: { name: "profile", arguments: true },
              run: async (input) => {
                const argument = (input ?? "").trim();
                if (argument) {
                  await switchTo(argument);
                  return;
                }
                try {
                  const list = (await rpc.list({})) as ProfileListResult;
                  const choice = await context.ui.dialog.select({
                    title: "Switch profile",
                    current: list.active,
                    options: list.profiles.map((entry) => ({
                      title: entry.name,
                      value: entry.name,
                    })),
                  });
                  if (choice === undefined) return;
                  await switchTo(choice);
                } catch (err) {
                  context.ui.toast.show({
                    message: "Profile switch failed: " + errorText(err),
                    variant: "error",
                  });
                }
              },
            },
          ],
        }));
        keymapRegistered = true;
      } catch (err) {
        degrade("/profile command", err);
      }
    }

    // The always-mounted app slot exists only to run our component body:
    // onMount fires inside the hosted component tree where the keymap
    // provider IS in scope, so the layer can be registered there.
    try {
      const removeKeymapSlot = context.ui.slot({
        append: "app",
        render: () => {
          onMount(() => registerKeymapLayer());
          return null;
        },
      });
      disposers.push(removeKeymapSlot);
    } catch (err) {
      degrade("keymap bootstrap slot", err);
    }

    try {
      const removeSlot = context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <text fg={context.theme.text.base}>Profile: {active()}</text>
        ),
      });
      disposers.push(removeSlot);
    } catch (err) {
      degrade("sidebar slot", err);
    }

    // No post-setup "not registered" warning here: keymap registration is
    // deferred to this slot's onMount (see above), so at setup time the flag
    // is legitimately still false; a failure is reported by degrade() from
    // registerKeymapLayer's own try/catch.

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // best-effort cleanup
        }
      }
    };
  },
});
