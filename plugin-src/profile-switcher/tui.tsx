// profile-switcher: TUI plugin (plugin id "profile-switcher.tui").
//
// - Slash command "/profile": with an argument -> rpc.set directly; without
//   -> ui.dialog.select over rpc list() (current profile marked), then
//   rpc.set. The result is toasted with the prefix "Profile switched: "
//   including any fallback substitutions and warnings.
// - Session claiming: this window claims ONLY the sessions currently open as
//   tabs, each tagged with a stable per-plugin-load `window` id and this
//   TUI's own directory. Every populate replaces this window's claim set on
//   the server, so sessions whose tabs closed are pruned and migration stays
//   scoped to this window; an empty list is a valid refresh. Claiming re-runs
//   debounced when the open-tab set changes, once just before a profile
//   switch, and once (empty) at cleanup. With tabs disabled or unreadable it
//   falls back to the reactive session list.
// - Sidebar slot (sidebar.content): renders "Profile: <active>", initialized
//   from rpc current() and kept live by subscribing to the rpc "changed"
//   event, applied only for events from this window's location; the
//   subscription and the slot are unsubscribed in cleanup.
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

import { createEffect, createSignal, For, onMount, Show } from "solid-js";

import { Plugin } from "@opencode/plugin/tui";

import {
  Profile,
  type ProfileAgentModelEntry,
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

// Graceful single-line truncation (mirrors subagent-view.tui).
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3) + "...";
}

// Debounce for the reactive open-tab reclaim (see registerTabsReclaim).
const TAB_RECLAIM_DEBOUNCE_MS = 300;

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
  // caller-guaranteed). Absent in a degenerate context with no directory.
  location?: string;
  // This window's stable claim id (see windowID): the server replaces this
  // window's whole claim set per populate, which is what prunes closed tabs.
  window: string;
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
    const [agents, setAgents] = createSignal<ProfileAgentModelEntry[]>([]);

    const rpc = context.client.rpc(Profile);

    // Stable claim id for THIS plugin load (one TUI window): random ASCII
    // matching the server's window schema ^[A-Za-z0-9_-]{1,64}$. crypto is the
    // preferred entropy source; the fallback is still ASCII and unique enough
    // for a single process.
    const windowID = (() => {
      try {
        const id = crypto.randomUUID().replace(/-/g, "");
        if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
      } catch {
        // fall through to the entropy fallback
      }
      let id = "";
      for (let index = 0; index < 32; index++) {
        id += Math.floor(Math.random() * 36).toString(36);
      }
      return id;
    })();

    // Candidate session ids for this window's claim. The open session tabs are
    // authoritative; when tabs are disabled or the tab read fails, fall back
    // to the reactive data store's session list (best-effort). Throws only
    // when NEITHER source is readable - the caller then skips the populate
    // rather than sending an empty list, which would drop live claims.
    function collectCandidateSessionIDs(): string[] {
      let tabsEnabled = false;
      try {
        tabsEnabled = context.ui.tabs.enabled();
      } catch {
        tabsEnabled = false;
      }
      if (tabsEnabled) {
        try {
          const ids: string[] = [];
          for (const tab of context.ui.tabs.list()) {
            if (typeof tab?.sessionID === "string") ids.push(tab.sessionID);
          }
          return ids;
        } catch {
          // The reactive fallback below covers an unreadable tab list.
        }
      }
      const ids: string[] = [];
      for (const info of context.data.session.list()) {
        if (typeof info?.id === "string") ids.push(info.id);
      }
      return ids;
    }

    // Claim only the sessions open as tabs in THIS window. Every call replaces
    // this window's claim set on the server, so an empty list is a meaningful
    // refresh that prunes sessions whose tabs closed. Returns true when a
    // populate call was issued (even with zero entries); false when a
    // transient failure prevented assembling a candidate list at all, in
    // which case no populate is sent so live claims are not wiped. Never
    // throws.
    async function populateTracker(): Promise<boolean> {
      try {
        const directory = context.location?.directory;
        let candidateIDs: string[];
        try {
          candidateIDs = collectCandidateSessionIDs();
        } catch {
          // Nothing was assembled: a spurious empty populate here would drop
          // this window's live claims.
          return false;
        }
        const entries: PopulateEntry[] = [];
        const seen = new Set<string>();
        for (const id of candidateIDs) {
          if (entries.length >= 200) break;
          if (seen.has(id)) continue;
          seen.add(id);
          try {
            // One session.get per candidate resolves the authoritative
            // agent/model/parentID/archived state.
            const info = (await context.client.session.get({
              sessionID: id,
            })) as SessionInfoLike;
            if (info?.time?.archived !== undefined) continue;
            // Children never migrate: excluded from claiming.
            if (typeof info.parentID === "string" && info.parentID) continue;
            const model = serializeModel(info?.model);
            if (model === undefined) continue;
            const entry: PopulateEntry = {
              sessionID: id,
              model,
              window: windowID,
            };
            if (typeof info.agent === "string") entry.agent = info.agent;
            if (typeof directory === "string" && directory) {
              entry.location = directory;
            }
            entries.push(entry);
          } catch {
            // skip this entry only
          }
        }
        try {
          // The populate input schema caps sessions at 200. Always carry the
          // top-level window so even an empty refresh replaces this window's
          // claim set (prunes closed tabs); the top-level location routes it to
          // the instance owning this directory when the context knows it.
          await rpc.populate({
            sessions: entries.slice(0, 200),
            window: windowID,
            ...(typeof directory === "string" && directory
              ? { location: directory }
              : {}),
          });
          return true;
        } catch {
          // populate is best-effort; never break setup
          return false;
        }
      } catch {
        // never throw out of populateTracker
        return false;
      }
    }
    void populateTracker();

    try {
      const current = (await rpc.current({})) as ProfileCurrentResult;
      setActive(current.active);
      setAgents(current.agents ?? []);
    } catch (err) {
      context.ui.toast.show({
        message:
          "profile-switcher: cannot read active profile: " + errorText(err),
        variant: "error",
      });
    }

    try {
      const unsubscribe = rpc.events.on("changed", (event) => {
        // Follow only switches originating from this window's location; a
        // foreign window's switch must not update this sidebar. Lenient when
        // this context has no directory.
        const ownDirectory = context.location?.directory;
        const eventDirectory = event.location?.directory;
        // Lenient like the server's locationMismatch: skip only when BOTH
        // sides name a directory and they differ; a directory-less event
        // applies.
        if (
          ownDirectory !== undefined &&
          eventDirectory !== undefined &&
          eventDirectory !== ownDirectory
        ) {
          return;
        }
        const data = event.data as
          | ProfileChangedEvent
          | Readonly<Record<string, unknown>>;
        if (data && typeof data.active === "string") {
          setActive(data.active);
        }
        if (data && Array.isArray(data.agents)) {
          setAgents(data.agents as ProfileAgentModelEntry[]);
        }
      });
      disposers.push(unsubscribe);
    } catch (err) {
      degrade("changed subscription", err);
    }

    async function switchTo(name: string): Promise<void> {
      try {
        // Fresh claims for this window right before the switch: migration is
        // scoped to the sessions this window currently holds. Best effort.
        await populateTracker();
        const result = (await rpc.set({ name })) as ProfileSetResult;
        // Apply the result immediately: the location-stamped "changed" event
        // may be filtered or lost, and this window's sidebar must still show
        // the switch. The agent list follows from a background refresh.
        setActive(result.active);
        void (async () => {
          try {
            const current = (await rpc.current({})) as ProfileCurrentResult;
            setActive(current.active);
            setAgents(current.agents ?? []);
          } catch {
            // background refresh is best-effort
          }
        })();
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

    // Reactive re-claim: the always-mounted app slot observes the open-tab id
    // set and, when it changes, schedules a debounced fire-and-forget
    // populateTracker() so opening/closing tabs immediately refreshes this
    // window's claims. Registered once; the timer is cleaned up with the slot.
    let tabsReclaimRegistered = false;
    function registerTabsReclaim(): void {
      if (tabsReclaimRegistered) return;
      try {
        let lastTabKey: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        createEffect(() => {
          let tabKey = "";
          try {
            // Sorted join = a stable key over the open-tab id SET (tab order
            // does not matter).
            tabKey = context.ui.tabs
              .list()
              .map((tab) => tab.sessionID)
              .sort()
              .join("\n");
          } catch {
            tabKey = "";
          }
          if (lastTabKey === undefined) {
            // First reactive read: the initial populateTracker() already ran
            // during setup, so only later changes schedule a re-claim.
            lastTabKey = tabKey;
            return;
          }
          if (tabKey === lastTabKey) return;
          lastTabKey = tabKey;
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
            void populateTracker();
          }, TAB_RECLAIM_DEBOUNCE_MS);
        });
        disposers.push(() => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        });
        tabsReclaimRegistered = true;
      } catch (err) {
        degrade("tab reclaim effect", err);
      }
    }

    // The always-mounted app slot exists only to run our component body:
    // onMount fires inside the hosted component tree where the keymap
    // provider IS in scope, so the layer can be registered there. The same
    // component registers the reactive open-tab reclaim effect.
    try {
      const removeKeymapSlot = context.ui.slot({
        append: "app",
        render: () => {
          registerTabsReclaim();
          onMount(() => registerKeymapLayer());
          return null;
        },
      });
      disposers.push(removeKeymapSlot);
    } catch (err) {
      degrade("keymap bootstrap slot", err);
    }

    // Collapsible sidebar section: header "Profile: <active> (n)" with an
    // arrow, and (when expanded) one muted "<agent>  <model>" row per agent.
    // Storage key "sidebar", default collapsed, durable. With no known agents
    // it degrades to the original static "Profile: <active>" line.
    function ProfileSection() {
      const [view, updateView] = context.storage.store("sidebar", {
        initial: { open: false },
      });
      return (
        <Show
          when={agents().length > 0}
          fallback={
            <text fg={context.theme.text.base}>Profile: {active()}</text>
          }
        >
          <box>
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => {
                try {
                  void updateView((draft) => {
                    draft.open = !draft.open;
                  });
                } catch {
                  // toggle is best-effort: never break the sidebar
                }
              }}
            >
              <text fg={context.theme.text.base}>
                {view.open ? "\u25bc" : "\u25b6"}
              </text>
              <text fg={context.theme.text.base}>
                <b>{"Profile: " + active() + " (" + agents().length + ")"}</b>
              </text>
            </box>
            <Show when={view.open}>
              <For each={agents()}>
                {(entry) => (
                  <text fg={context.theme.text.muted}>
                    {truncate("  " + entry.agent + "  " + entry.model, 72)}
                  </text>
                )}
              </For>
            </Show>
          </box>
        </Show>
      );
    }

    try {
      const removeSlot = context.ui.slot({
        append: "sidebar.content",
        render: () => <ProfileSection />,
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
      // Best-effort final claim refresh for this window id: zero sessions with
      // this window id and (when known) this directory, so a closed/reloaded
      // window stops holding claims. Fire-and-forget: never awaited, never
      // throws.
      const directory = context.location?.directory;
      try {
        void rpc
          .populate({
            sessions: [],
            window: windowID,
            ...(typeof directory === "string" && directory
              ? { location: directory }
              : {}),
          })
          .catch(() => {
            // cleanup must never reject
          });
      } catch {
        // never break cleanup
      }
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
