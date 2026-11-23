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
// Each child renders as two single-line rows in a column box: line 1 is the
// group marker ("*" running, "-" idle), the bold agent name, and the task
// label (the child session's title with a leading "@<agent> subagent" prefix
// stripped, "Child session" when the title is absent or prefix-only); line 2 is
// 3-space indented and carries the model label, the usage figure (percent of
// the context window when the model's limit is known, otherwise the compact
// token count - never both), and cost. Running entries come first, then a
// single blank line between the running and finished groups (none inside a
// group). All rows truncate to the
// measured sidebar width and never wrap: the sidebar.content slot is 37
// columns in v2.3.2 (42 minus the 2+2 padding, plus the inner paddingRight 1)
// and carries no width prop, so the root box's ref reads its layout-resolved
// width and onSizeChange keeps that measurement current. Titles come from
// SessionInfo.title only - no transcript fetch.
//
// The store does not update child tokens mid-run, so while at least one child
// is running a 2s poll calls context.client.session.get({ sessionID }) plus a
// lightweight context.client.message.list({ sessionID, limit: 5, order: "desc",
// type: "assistant" }) for each running child, and holds the newest assistant
// message's tokens plus the store's cost/model in a local map that takes
// precedence over the store; entries are dropped once a child stops running.
// The newest assistant row may be an in-progress step with no tokens, so the
// first row carrying tokens is used (preferring a completed step), and the
// poll never falls back to the store's cumulative SessionInfo.tokens while any
// message-level value is known - that fallback is what made the figure
// oscillate.
// Each poll also writes those message tokens into the shared per-child cache
// (finishedTokens), so a finished child's figure is the last message-level
// value observed during its run rather than the warm-up value fetched at the
// start. Children that were already finished at load fetch their last assistant
// message tokens once, cached by child id, when their row is first rendered; a
// running child with no live entry yet also kicks off that same one-shot cached
// fetch so the message-level figure shows within one round-trip instead of
// waiting up to 2s. A fetch that yields no tokens stays retryable. When nothing
// runs, the poll makes no network calls.
//
// context.client.message.list() returns SessionMessagesResponse; with
// limit: 5 / order: "desc" / type: "assistant" the newest assistant messages
// come newest-first in data, and the tokens are read straight from them (no
// transcript download).
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
import type { BoxRenderable } from "@opentui/core";
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

// The sidebar.content slot is 37 columns wide in opencode v2.3.2. Its render
// input carries no width, so this is the value used until the root box's
// layout measurement lands.
const SIDEBAR_WIDTH_FALLBACK = 37;

// Usable text width for a measured slot width: leave one column for the
// scrollbar, and never go below 8 columns.
function usableWidth(width: number): number {
  return Math.max(8, width - 1);
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

// Usage column: percent of the context window when the model's limit is known
// ("18%"), otherwise the compact token count. Never both.
function usageText(
  tokens: TokenUsageInfo | undefined,
  contextLimit?: number
): string {
  const count = totalTokens(tokens);
  if (typeof contextLimit === "number" && contextLimit > 0) {
    const percent = Math.min(100, Math.round((count / contextLimit) * 100));
    return percent + "%";
  }
  return formatTokens(count);
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
  // Measured width of this section inside the sidebar.content slot, updated by
  // the root box's onSizeChange and seeded once from the ref on mount. 37 (the
  // v2.3.2 slot width) until the first real measurement.
  const [width, setWidth] = createSignal(SIDEBAR_WIDTH_FALLBACK);
  let rootBox: BoxRenderable | undefined;

  // One-shot fetch of the newest assistant message usage for a child session,
  // using the lightweight message.list endpoint (a few newest assistant
  // messages, newest first) instead of downloading the child's whole
  // transcript via session.context(). The newest assistant row can be an
  // in-progress step that carries no tokens, so the first row with tokens is
  // used, preferring a completed step; if the page holds no completed step the
  // newest row that does carry tokens wins.
  async function fetchLatestAssistantTokens(
    id: string
  ): Promise<TokenUsageInfo | undefined> {
    const res = await context.client.message.list({
      sessionID: id,
      limit: 5,
      order: "desc",
      type: "assistant",
    });
    const messages = res?.data ?? [];
    let fallback: TokenUsageInfo | undefined;
    for (const message of messages) {
      if (!message || message.type !== "assistant") continue;
      const tokens = message.tokens;
      if (!tokens) continue;
      if (message.time?.completed !== undefined) return tokens;
      if (!fallback) fallback = tokens;
    }
    return fallback;
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
  // by child id. Only defined tokens are cached, and a fetch that yields
  // nothing (or fails) is left retryable instead of being marked done
  // permanently.
  async function fetchFinishedTokens(id: string): Promise<void> {
    try {
      const tokens = await fetchLatestAssistantTokens(id);
      if (!tokens) {
        finishedRequested.delete(id);
        return;
      }
      // Do not clobber a fresher value the running-child poll may have cached
      // while this warm-up fetch was in flight.
      if (finishedTokens().has(id)) return;
      cacheFinishedTokens(id, tokens);
    } catch {
      // best-effort; the store fallback covers the rest and a later render
      // retries this child
      finishedRequested.delete(id);
    }
  }

  // Returns cached message tokens for any child, kicking off the one-time fetch
  // on first request. Used for finished children and as a warm-up for a running
  // child that has no live poll entry yet. Plain Set guards against repeated
  // fetches across re-renders; an empty or failed fetch drops the guard above
  // so a later render can retry.
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
          // Never fall back to the cumulative SessionInfo.tokens while a
          // message-level value is known: it is the session-wide total, so it
          // jumps and overshoots every time an in-progress step has no tokens
          // yet. Order: this poll's message tokens, then the previous live
          // value, then the cached message value, and only for a brand-new
          // session with no assistant usage at all the store's total.
          const tokens =
            msgTokens ??
            prior?.tokens ??
            finishedTokens().get(child.id) ??
            info?.tokens;
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
    // The layout is resolved by mount time; onSizeChange covers later resizes.
    // A zero width keeps the 37-column fallback.
    const measured = rootBox?.width;
    if (typeof measured === "number" && measured > 0) setWidth(measured);
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

  // Single-line task label for a child row, from the child session's title
  // alone (no transcript fetch). Upstream titles a child "@<agent> subagent
  // <task>"; that prefix is stripped case-insensitively so the row shows the
  // task, and an absent or prefix-only title degrades to "Child session".
  function taskLabel(info: SessionInfo): string {
    const title = typeof info.title === "string" ? info.title.trim() : "";
    if (!title) return "Child session";
    const agent =
      typeof info.agent === "string" && info.agent ? info.agent : "";
    if (agent) {
      const prefix = "@" + agent + " subagent";
      if (title.toLowerCase().startsWith(prefix.toLowerCase())) {
        // Strip one separating ":" or "-" so "@analyst subagent: find X"
        // renders "find X" rather than ": find X".
        const rest = title
          .slice(prefix.length)
          .trim()
          .replace(/^[:\-]\s*/, "")
          .trim();
        return rest || "Child session";
      }
    }
    return title;
  }

  // Two single-line rows per child, rendered as a run of entries:
  //   line 1: status bullet ("*" running, "-" idle), bold agent, task label,
  //           one gap column between each
  //   line 2: 3-space indent, model, usage (percent-of-context, or the token
  //           count when the limit is unknown), cost
  // Every text is cut to the measured sidebar width and never wraps. Line 1's
  // task label gets the width left after the 1-column bullet, its gap, the
  // agent name, and the agent-to-label gap, so the label carries the ellipsis
  // when space runs out. Line 2 caps the model label first, so the usage and
  // cost columns stay visible on a narrow sidebar.
  function linesFor(info: SessionInfo): {
    bullet: string;
    agent: string;
    title: string;
    line2: string;
    running: boolean;
  } {
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
    const max = usableWidth(width());
    // Stage 1 of line 2: the model label may take at most ~45% of the width,
    // so the usage and cost columns survive.
    const modelMax = Math.max(10, Math.floor(width() * 0.45));
    const bullet = running ? "*" : "-";
    const title = truncate(
      taskLabel(info),
      Math.max(0, max - agent.length - 3)
    );
    const line2 = truncate(
      "   " +
        truncate(model.label, modelMax) +
        "  " +
        usageText(tokens, model.contextLimit) +
        "  " +
        costText(liveEntry?.cost ?? info.cost),
      max
    );
    return {
      bullet,
      agent,
      title,
      line2,
      running,
    };
  }

  // Running entries first (children() is already sorted running-first), then
  // exactly one blank spacer line between the two groups when both exist.
  const runningChildren = createMemo<SessionInfo[]>(() =>
    children().filter((info) => statusOf(info.id) === "running")
  );
  const finishedChildren = createMemo<SessionInfo[]>(() =>
    children().filter((info) => statusOf(info.id) !== "running")
  );

  // One entry block: no margin of its own (the only gap is the single spacer
  // between the running and finished groups). A child/subagent session is not
  // tab-openable (tabs are root-session tabs only), so a click navigates instead;
  // best-effort and silent.
  function entry(info: SessionInfo) {
    const row = createMemo(() => linesFor(info));
    return (
      <box
        flexDirection="column"
        onMouseDown={() => {
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
        <box flexDirection="row" gap={1}>
          <text
            fg={
              row().running
                ? context.theme.text.base
                : context.theme.text.muted
            }
            wrapMode="none"
            truncate
          >
            {row().bullet}
          </text>
          <text
            fg={
              row().running
                ? context.theme.text.base
                : context.theme.text.muted
            }
            wrapMode="none"
            truncate
          >
            <b>{row().agent}</b>
          </text>
          <text
            fg={
              row().running
                ? context.theme.text.base
                : context.theme.text.muted
            }
            wrapMode="none"
            truncate
          >
            {row().title}
          </text>
        </box>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>
          {row().line2}
        </text>
      </box>
    );
  }

  // Height cap for the inner list. Derived from the terminal, not from this
  // box (whose height is whatever it laid out to), so the cap does not chase
  // itself. 3 to 10 rows of the terminal's 30%, and each row is two text lines.
  const cap = () => {
    const terminalHeight = context.renderer?.terminalHeight ?? 40;
    const visibleRows = Math.max(
      3,
      Math.min(10, Math.floor(terminalHeight * 0.3)),
    );
    return visibleRows * 2;
  };

  // Every child is rendered, but only the list scrolls: the rows sit inside a
  // bounded inner scrollbox (about 30% of the terminal, 3 to 10 rows) so the
  // outer sidebar keeps its own height instead of growing with the child
  // count. The header stays fixed above the list. The inner box is not
  // focusable, so focus stays with the outer sidebar and its j/k keys, and a
  // wheel event is stopped only while the inner list still has room to move;
  // at the top and bottom edges the outer sidebar scrolls instead.
  return (
    <Show when={children().length > 0}>
      <box
        ref={(el) => {
          rootBox = el;
        }}
        onSizeChange={function () {
          // The handler runs with `this` bound to the renderable, so the
          // freshly laid-out width is read here (a stale width would let a row
          // wrap and push the next row down).
          const measured = this.width;
          if (typeof measured === "number" && measured > 0) setWidth(measured);
        }}
      >
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
            <text fg={context.theme.text.base} wrapMode="none" truncate>
              {view.open ? "\u25bc" : "\u25b6"}
            </text>
          </Show>
          <text fg={context.theme.text.base} wrapMode="none" truncate>
            <b>{"Subagents (" + children().length + ")"}</b>
          </text>
        </box>
        <Show when={children().length <= 2 || view.open}>
          <scrollbox
            maxHeight={cap()}
            scrollY
            scrollX={false}
            focusable={false}
            scrollbarOptions={{ visible: false }}
            onMouseScroll={function (event) {
              if (event.type !== "scroll") return;
              const room = this.scrollHeight - this.viewport.height;
              if (room <= 0) return;
              const dir = event.scroll?.direction;
              if (
                (dir === "down" && this.scrollTop < room) ||
                (dir === "up" && this.scrollTop > 0)
              ) {
                event.stopPropagation();
              }
            }}
          >
            <For each={runningChildren()}>{(info) => entry(info)}</For>
            <Show
              when={
                runningChildren().length > 0 && finishedChildren().length > 0
              }
            >
              <box height={1} />
            </Show>
            <For each={finishedChildren()}>{(info) => entry(info)}</For>
          </scrollbox>
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
