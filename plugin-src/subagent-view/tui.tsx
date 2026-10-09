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
//   - The context figure (tokens + percent-of-context) comes from the newest
//     assistant message's tokens for the child session, using the same 5-field
//     formula (input + output + reasoning + cache.read + cache.write) as the
//     built-in context indicator, divided by ModelInfo.limit.context.
//     SessionInfo.tokens is NOT used for the percentage: the v2 server computes
//     it as the session-wide cumulative total across all messages, so it grows
//     without bound and overshoots the context window. SessionInfo.tokens
//     remains only a fallback when no message tokens are obtainable (e.g. a
//     brand-new session before its first assistant message).
//   - SessionInfo.cost gives spend (cumulative, matching OpenCode's own cost
//     display).
//
// The store does not update child tokens mid-run, so while at least one child
// is running a 2s poll calls context.client.session.get({ sessionID }) plus a
// lightweight context.client.message.list({ sessionID, limit: 1, order: "desc",
// type: "assistant" }) for each running child, and holds the newest assistant
// message's tokens plus the store's cost/model in a local map that takes
// precedence over the store; entries are dropped once a child stops running.
// Each poll also writes those message tokens into the shared per-child cache
// (finishedTokens), so a finished child's figure is the last message-level
// value observed during its run rather than the warm-up value fetched at the
// start. Children that were already finished at load fetch their last assistant
// message tokens once, cached by child id, when their row is first rendered; a
// running child with no live entry yet also kicks off that same one-shot cached
// fetch so the message-level figure shows within one round-trip instead of
// waiting up to 2s. When nothing runs, the poll makes no network calls.
//
// context.client.message.list() returns SessionMessagesResponse; with
// limit: 1 / order: "desc" / type: "assistant" the newest assistant message is
// data[0], and the tokens are read straight from it (no transcript download).
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
  // Newest assistant message tokens, keyed by child id. Seeded once when a
  // child's row is first rendered (finished children to restore the per-message
  // figure; a running child as a warm-up before its first poll entry), then
  // kept fresh by the running-child poll so a finished child shows the last
  // message-level value observed during its run. The reactive store carries
  // only the cumulative SessionInfo.tokens, so this avoids showing that
  // overshoot (and avoids refetching on every render).
  const [finishedTokens, setFinishedTokens] = createSignal<
    Map<string, TokenUsageInfo>
  >(new Map());
  const finishedRequested = new Set<string>();
  let refreshing = false;

  // One-shot fetch of the newest assistant message tokens for a child session,
  // using the lightweight message.list endpoint (limit 1, newest first, only
  // assistant messages) instead of downloading the child's whole transcript via
  // session.context(). Failures fall back to the store's SessionInfo.tokens.
  async function fetchLatestAssistantTokens(
    id: string
  ): Promise<TokenUsageInfo | undefined> {
    const res = await context.client.message.list({
      sessionID: id,
      limit: 1,
      order: "desc",
      type: "assistant",
    });
    const message = res?.data?.[0];
    if (!message || message.type !== "assistant") return undefined;
    return message.tokens;
  }

  // Store the newest assistant message tokens for a child in the shared cache.
  // Shared by the one-shot fetch and the running-child poll so a finished
  // child's displayed figure is the last message-level value observed during
  // its run, not the warm-up value fetched at the start.
  function cacheFinishedTokens(id: string, tokens: TokenUsageInfo): void {
    setFinishedTokens((prev) => {
      const next = new Map(prev);
      next.set(id, tokens);
      return next;
    });
  }

  // One-shot (per child) fetch of the newest assistant message tokens, cached
  // by child id. Failures fall back to the store's SessionInfo.tokens.
  async function fetchFinishedTokens(id: string): Promise<void> {
    try {
      const tokens = await fetchLatestAssistantTokens(id);
      if (!tokens) return;
      // Do not clobber a fresher value the running-child poll may have cached
      // while this warm-up fetch was in flight.
      if (finishedTokens().has(id)) return;
      cacheFinishedTokens(id, tokens);
    } catch {
      // best-effort; the store fallback covers the rest
    }
  }

  // Returns cached message tokens for any child, kicking off the one-time fetch
  // on first request. Used for finished children and as a warm-up for a running
  // child that has no live poll entry yet. Plain Set guards against repeated
  // fetches across re-renders (including the "no tokens found" case).
  function ensureFinishedTokens(id: string): TokenUsageInfo | undefined {
    const cached = finishedTokens().get(id);
    if (cached) return cached;
    if (!finishedRequested.has(id)) {
      finishedRequested.add(id);
      void fetchFinishedTokens(id);
    }
    return undefined;
  }

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
          // Prefer the newest assistant message's tokens (matches the built-in
          // context indicator); SessionInfo.tokens is the cumulative session
          // total and is used only as a fallback.
          let msgTokens: TokenUsageInfo | undefined;
          try {
            msgTokens = await fetchLatestAssistantTokens(child.id);
          } catch {
            msgTokens = undefined;
          }
          const tokens = msgTokens ?? info?.tokens;
          // Keep the shared cache fresh while running so the value survives the
          // live-entry drop when the child finishes (only message-level tokens,
          // never the cumulative SessionInfo.tokens fallback).
          if (msgTokens) cacheFinishedTokens(child.id, msgTokens);
          next.set(child.id, {
            tokens,
            cost: info?.cost,
            modelRef: info?.model,
          });
          if (totalTokens(prior?.tokens) !== totalTokens(tokens)) {
            console.info(
              "[subagent-view.tui] live " +
                JSON.stringify({
                  sessionID: child.id,
                  tokens: totalTokens(tokens),
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
    // Running children use the poll's newest-assistant-message tokens; until the
    // first poll result arrives they also use the one-shot cached fetch as a
    // warm-up. Finished children use the shared cache, which the poll kept
    // updated while they ran (or the one-shot fetch if they finished at load).
    // SessionInfo.tokens is only the fallback when no message tokens are
    // obtainable.
    const tokens = running
      ? (liveEntry?.tokens ?? ensureFinishedTokens(info.id) ?? info.tokens)
      : (ensureFinishedTokens(info.id) ?? info.tokens);
    const parts = [
      (running ? "* " : "  ") + agent,
      usageText(tokens, model.contextLimit),
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
                    // A child/subagent session is not tab-openable (tabs are
                    // root-session tabs only), so navigation is the only
                    // correct behavior. Best-effort and silent.
                    try {
                      context.ui.router.navigate({
                        type: "session",
                        sessionID: info.id,
                      });
                    } catch {
                      // navigation is best-effort
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
