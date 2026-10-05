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

// Structured ModelRef -> the normalized "providerID/id#variant" ref string the
// server tracker uses; the "default" variant is dropped. Undefined when the
// ref is missing providerID or id (un-serializable).
function serializeModel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof m.providerID !== "string" || typeof m.id !== "string") {
    return undefined;
  }
  return (
    m.providerID +
    "/" +
    m.id +
    (typeof m.variant === "string" && m.variant && m.variant !== "default"
      ? "#" + m.variant
      : "")
  );
}

interface PopulateEntry {
  sessionID: string;
  agent?: string;
  model?: string;
  parentID?: string;
  // This TUI's own directory, so the server can route the seed to the plugin
  // instance that owns the location (RPC routing between instances is not
  // caller-guaranteed). Absent on tabs-gap entries.
  location?: string;
}

interface SessionInfoLike {
  id?: unknown;
  agent?: unknown;
  model?: unknown;
  parentID?: unknown;
  time?: { archived?: unknown };
}

export default Plugin.define({
  id: "profile-switcher.tui",
  async setup(context) {
    const disposers: Array<() => void> = [];
    let keymapRegistered = false;

    const [active, setActive] = createSignal("default");

    const rpc = context.client.rpc(Profile);

    // Seed the server-side session tracker with sessions that predate this
    // plugin load (the server plugin has no session.list of its own). Runs
    // concurrently with the rest of setup; every failure is swallowed so setup
    // cannot break.
    async function populateTracker(): Promise<void> {
      try {
        const entries: PopulateEntry[] = [];
        const seen = new Set<string>();
        const directory = context.location?.directory;
        if (typeof directory === "string" && directory) {
          // Authoritative enumeration of this location's sessions: paged
          // client.session.list({directory}). context.data.session.list() is
          // NOT used here - it does not reliably contain sessions that predate
          // the TUI's own event stream.
          let cursor: string | undefined;
          let pages = 0;
          while (entries.length < 200 && pages < 100) {
            pages++;
            const res = await context.client.session.list({
              directory,
              limit: 50,
              ...(cursor === undefined ? {} : { cursor }),
            });
            const page: SessionInfoLike[] = res?.data ?? [];
            for (const info of page) {
              try {
                const id = info?.id;
                if (typeof id !== "string" || seen.has(id)) continue;
                if (info.time?.archived !== undefined) continue;
                // Children never migrate: excluded from seeding.
                if (typeof info.parentID === "string" && info.parentID) {
                  continue;
                }
                const model = serializeModel(info.model);
                if (model === undefined) continue;
                seen.add(id);
                const entry: PopulateEntry = {
                  sessionID: id,
                  model,
                  location: directory,
                };
                if (typeof info.agent === "string") entry.agent = info.agent;
                entries.push(entry);
                if (entries.length >= 200) break;
              } catch {
                // skip this entry only
              }
            }
            if (page.length === 0) break;
            const next = res?.cursor?.next;
            if (typeof next !== "string" || !next) break;
            cursor = next;
          }
        } else {
          // No usable location on this context: unchanged fallback to the
          // reactive data store's best-effort list.
          let sessions: SessionInfoLike[] = [];
          try {
            sessions = context.data.session.list() as SessionInfoLike[];
          } catch {
            sessions = [];
          }
          for (const info of sessions) {
            try {
              const id = info?.id;
              if (typeof id !== "string" || seen.has(id)) continue;
              if (info.time?.archived !== undefined) continue;
              const model = serializeModel(info.model);
              if (model === undefined) continue;
              seen.add(id);
              entries.push({
                sessionID: id,
                agent: typeof info.agent === "string" ? info.agent : undefined,
                model,
                parentID:
                  typeof info.parentID === "string"
                    ? info.parentID
                    : undefined,
              });
            } catch {
              // skip this entry only
            }
          }
        }
        // Any open tab not covered by the enumeration above: fetch it once.
        // These entries carry NO location; the server resolves the owner via a
        // session.get.
        let tabs: ReadonlyArray<{ sessionID?: unknown }> = [];
        try {
          tabs = context.ui.tabs.list();
        } catch {
          tabs = [];
        }
        for (const tab of tabs) {
          try {
            const id = tab?.sessionID;
            if (typeof id !== "string" || seen.has(id)) continue;
            if (entries.length >= 200) break;
            seen.add(id);
            const info = (await context.client.session.get({
              sessionID: id,
            })) as SessionInfoLike;
            const model = serializeModel(info?.model);
            if (model === undefined) continue;
            entries.push({
              sessionID: id,
              agent: typeof info.agent === "string" ? info.agent : undefined,
              model,
              parentID:
                typeof info.parentID === "string" ? info.parentID : undefined,
            });
          } catch {
            // skip fetch failures only
          }
        }
        if (entries.length === 0) return;
        // The populate input schema caps sessions at 200.
        await rpc.populate({ sessions: entries.slice(0, 200) });
      } catch {
        // populate is best-effort; never break setup
      }
    }
    void populateTracker();

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
