// subagent-view: TUI plugin (plugin id "subagent-view.tui").
//
// Restores v1's live subagent token/context display, removed by the v2
// regression (upstream #42367 / #38495), as a "Subagents (n)" section in the
// session sidebar. Mirrors the upstream v2.0.21 built-in sidebar context plugin
// (packages/tui/src/feature-plugins/sidebar/context.tsx): the slot is
// "sidebar.content", whose render input carries the open session's sessionID
// (SlotMap in the installed @opencode/plugin typings), so the section is
// per-open-session and reactive.
//
// Data access mirrors the built-in plugin:
//   - context.data.session.list() is the reactive store of SessionInfo; children
//     of the open session are those with parentID === sessionID.
//   - context.data.session.status(childID) gives "idle" | "running".
//   - context.data.location.model.list() gives ModelInfo; a child's model label
//     is resolved by matching ModelInfo.providerID + ModelInfo.id against
//     SessionInfo.model (the same providerID + id match the built-in
//     contextUsage util uses), with ModelInfo.name as the display name and
//     ModelInfo.limit.context as the context window.
//   - SessionInfo.tokens (input + output + reasoning + cache.read +
//     cache.write - the v1 formula) gives live token usage; SessionInfo.cost
//     gives spend.
//
// The store does not update child tokens mid-run, so while at least one child
// is running a 2s poll calls context.client.session.get({ sessionID }) for each
// running child and holds the returned tokens/cost/model in a local map that
// takes precedence over the store; entries are dropped once a child stops
// running (the store's final values then win). When nothing runs, the poll
// makes no network calls.
//
// A one-shot supplement enumerates the open session's children through
// context.client.session.list({ directory, parentID, limit, cursor }) and merges
// any child id missing from the reactive store as a static fallback entry (store
// values always win when present). Every failure is swallowed: the reactive
// store alone is enough for the section to work.
//
// setup() wraps all registration in try/catch and swallows failures (the
// profile-switcher/tui.tsx convention).
//
// All files ASCII only.

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Plugin } from "@opencode/plugin/tui";
import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  TokenUsageInfo,
} from "@opencode/client";

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function degrade(what: string, err: unknown): void {
  console.warn("[subagent-view.tui] " + what + " unavailable: " + errorText(err));
}

// Compact token count, e.g. 12345 -> "12.3k".
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return (n / 1000).toFixed(1) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

// Graceful single-line truncation.
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3) + "...";
}

// Resolve a child's model label and context limit. Matched on
// ModelInfo.providerID + ModelInfo.id (the built-in contextUsage util's match).
// The " (#variant)" suffix is appended only when the variant is set and not
// "default". Fallback is "providerID/id".
function resolveModel(
  context: Plugin.Context,
  ref: ModelRef | undefined
): { label: string; contextLimit?: number } {
  if (!ref || typeof ref.providerID !== "string" || typeof ref.id !== "string") {
    return { label: "unknown" };
  }
  const variant =
    typeof ref.variant === "string" && ref.variant && ref.variant !== "default"
      ? ref.variant
      : undefined;
  let models: ModelInfo[] | undefined;
  try {
    models = context.data.location.model.list();
  } catch {
    models = undefined;
  }
  const found = models?.find(
    (model) => model.providerID === ref.providerID && model.id === ref.id
  );
  if (found) {
    return {
      label: found.name + (variant ? " (#" + variant + ")" : ""),
      contextLimit: found.limit?.context,
    };
  }
  return { label: ref.providerID + "/" + ref.id };
}

// v1 token formula: input + output + reasoning + cache.read + cache.write.
function totalTokens(tokens: TokenUsageInfo | undefined): number {
  if (!tokens) return 0;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  );
}

function usageText(
  tokens: TokenUsageInfo | undefined,
  contextLimit?: number
): string {
  const count = totalTokens(tokens);
  let out = formatTokens(count);
  if (typeof contextLimit === "number" && contextLimit > 0) {
    const percent = Math.min(100, Math.round((count / contextLimit) * 100));
    out += " (" + percent + "%)";
  }
  return out;
}

function costText(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  // Sub-cent spend is real (e.g. $0.00114) but would round to "$0.00" at 2
  // decimals; show 4 decimals for (0, 0.01) so it is not indistinguishable
  // from zero. Zero and >= 0.01 keep the existing 2-decimal format.
  if (cost > 0 && cost < 0.01) return "$" + cost.toFixed(4);
  return "$" + cost.toFixed(2);
}

// Live per-child usage fetched from the client while a child is running. The
// reactive store's SessionInfo does not update child tokens mid-run, so these
// values take precedence over the store while present (and are dropped once
// the child stops running, falling back to the store's final values).
type LiveUsage = {
  tokens: TokenUsageInfo | undefined;
  cost: number;
  modelRef: ModelRef | undefined;
};

function Subagents(props: { context: Plugin.Context; sessionID: string }) {
  const context = props.context;
  // Section collapse state, persisted (mirrors the built-in MCP sidebar
  // section's context.storage.store("view", ...) call shape). Sections with
  // <= 2 children are never collapsible and show no arrow.
  const [view, updateView] = context.storage.store("view", {
    initial: { open: true },
  });
  // Static fallback entries fetched once per mount, keyed by child id. The
  // reactive store always wins when it has the same id.
  const [fallback, setFallback] = createSignal<Map<string, SessionInfo>>(
    new Map()
  );
  // Live usage for currently-running children, keyed by child id. Refreshed by
  // a 2s poll (below); entries are removed as soon as a child stops running so
  // completed children fall back to the store's final values.
  const [live, setLive] = createSignal<Map<string, LiveUsage>>(new Map());
  let refreshing = false;

  async function refreshLive(): Promise<void> {
    try {
      // Same status source the component already uses.
      const running = children().filter(
        (child) => statusOf(child.id) === "running"
      );
      if (running.length === 0) {
        // Nothing running: no network calls; drop stale entries so completed
        // children render the store's final values.
        if (live().size > 0) setLive(new Map());
        return;
      }
      const previous = live();
      const next = new Map<string, LiveUsage>();
      for (const child of running) {
        const prior = previous.get(child.id);
        try {
          const res = await context.client.session.get({
            sessionID: child.id,
          });
          const info = (res as { data?: SessionInfo })?.data ?? res;
          next.set(child.id, {
            tokens: info?.tokens,
            cost: info?.cost,
            modelRef: info?.model,
          });
          if (totalTokens(prior?.tokens) !== totalTokens(info?.tokens)) {
            console.info(
              "[subagent-view.tui] live " +
                JSON.stringify({
                  sessionID: child.id,
                  tokens: totalTokens(info?.tokens),
                  cost: info?.cost,
                })
            );
          }
        } catch {
          // Keep the previous live entry for this child if we had one; the
          // store fallback covers the rest.
          if (prior) next.set(child.id, prior);
        }
      }
      setLive(next);
    } catch {
      // Defensive: the poll must never throw out of the interval callback.
    }
  }

  async function loadFallback(): Promise<void> {
    try {
      const directory = context.location?.directory;
      if (typeof directory !== "string" || !directory) return;
      const merged = new Map<string, SessionInfo>();
      let cursor: string | undefined;
      let pages = 0;
      while (merged.size < 100 && pages < 100) {
        pages++;
        const res = await context.client.session.list({
          directory,
          parentID: props.sessionID,
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const page: SessionInfo[] = res?.data ?? [];
        for (const info of page) {
          try {
            if (typeof info?.id !== "string") continue;
            if (info.parentID !== props.sessionID) continue;
            if (!merged.has(info.id)) merged.set(info.id, info);
          } catch {
            // skip this entry only
          }
        }
        if (page.length === 0) break;
        const next = res?.cursor?.next;
        if (typeof next !== "string" || !next) break;
        cursor = next;
      }
      if (merged.size > 0) setFallback(merged);
    } catch {
      // populate is best-effort; the reactive store alone suffices
    }
  }

  onMount(() => {
    void loadFallback();
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void refreshLive().finally(() => {
        refreshing = false;
      });
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });

  function statusOf(id: string): "idle" | "running" {
    try {
      return context.data.session.status(id);
    } catch {
      return "idle";
    }
  }

  // Reactive child list: store children filtered by parentID, supplemented by
  // the static fallback entries. Running children first, then most-recently
  // updated.
  const children = createMemo<SessionInfo[]>(() => {
    let storeList: SessionInfo[] = [];
    try {
      storeList = context.data.session.list();
    } catch {
      storeList = [];
    }
    const merged = new Map<string, SessionInfo>(fallback());
    for (const info of storeList) {
      try {
        if (info.parentID === props.sessionID) merged.set(info.id, info);
      } catch {
        // skip this entry only
      }
    }
    const out = Array.from(merged.values());
    out.sort((a, b) => {
      const aRunning = statusOf(a.id) === "running" ? 0 : 1;
      const bRunning = statusOf(b.id) === "running" ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
    });
    return out;
  });

  // Render-only subset of children(): every running child, plus the first 3
  // non-running children in the existing sort order (the 3 most recently
  // updated finished ones). The header still reports the true total.
  const visible = createMemo<SessionInfo[]>(() => {
    const all = children();
    const running = all.filter((info) => statusOf(info.id) === "running");
    const finished = all
      .filter((info) => statusOf(info.id) !== "running")
      .slice(0, 3);
    return running.concat(finished);
  });

  function lineFor(info: SessionInfo): { text: string; running: boolean } {
    const running = statusOf(info.id) === "running";
    const liveEntry = live().get(info.id);
    const agent =
      typeof info.agent === "string" && info.agent ? info.agent : "subagent";
    const model = resolveModel(context, liveEntry?.modelRef ?? info.model);
    const parts = [
      (running ? "* " : "  ") + agent,
      usageText(liveEntry?.tokens ?? info.tokens, model.contextLimit),
      model.label,
      costText(liveEntry?.cost ?? info.cost),
    ];
    return { text: truncate(parts.join("  "), 72), running };
  }

  return (
    <Show when={children().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (children().length <= 2) return;
            void updateView((draft) => {
              draft.open = !draft.open;
            });
          }}
        >
          <Show when={children().length > 2}>
            <text fg={context.theme.text.base}>
              {view.open ? "\u25bc" : "\u25b6"}
            </text>
          </Show>
          <text fg={context.theme.text.base}>
            <b>{"Subagents (" + children().length + ")"}</b>
          </text>
        </box>
        <Show when={children().length <= 2 || view.open}>
          <For each={visible()}>
            {(info) => {
              const row = createMemo(() => lineFor(info));
              return (
                <box
                  onMouseDown={() => {
                    try {
                      if (context.ui.tabs.enabled()) {
                        const opened = context.ui.tabs.focus(info.id);
                        if (opened) return;
                      }
                      context.ui.router.navigate({
                        type: "session",
                        sessionID: info.id,
                      });
                    } catch {
                      // best-effort navigation
                    }
                  }}
                >
                  <text
                    fg={
                      row().running
                        ? context.theme.text.base
                        : context.theme.text.muted
                    }
                  >
                    {row().text}
                  </text>
                </box>
              );
            }}
          </For>
        </Show>
      </box>
    </Show>
  );
}

export default Plugin.define({
  id: "subagent-view.tui",
  setup(context) {
    const disposers: Array<() => void> = [];
    try {
      const removeSlot = context.ui.slot({
        append: "sidebar.content",
        render: (props) => (
          <Subagents context={context} sessionID={props.sessionID} />
        ),
      });
      disposers.push(removeSlot);
    } catch (err) {
      degrade("sidebar slot", err);
    }

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
