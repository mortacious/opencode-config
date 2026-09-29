// fusion-tools plugin package.
//
// Three modules share this entrypoint:
//
// advisor (Phase 1): a peer-reviewer that watches scoped primary agent
// sessions (currently build/plan), renders redacted deltas of their
// transcript, runs them through a second "advisor" agent on its own session,
// and routes the advisor's `advise` tool calls back into the primary as
// advisory notes with severity-based delivery.
//
// fanout (Phase 2): a `fanout` tool that splits a job across parallel worker
// sessions, each isolated in its own git worktree, with schema-validated
// results reported back via the workers' `submit_result` tool. Orchestration
// lives in lib/fanout.js; worktrees are retained for the parent to integrate.
//
// steer: a `/steer` command that forwards a short message to the most
// recently created still-running subagent of the calling session (children
// are tracked from session.created events via parentID; see lib/steer.js).
// It registers whenever the plugin loads, independent of advisor.enabled.
//
// Config lives in opencode.jsonc plugins entry options: ctx.options.advisor =
// {enabled, model?, scope?, maxNotesPerUpdate?, reviewTimeoutMs?,
// maxDeltaChars?, activation?, minStepsTurn?, minTurnDeltaChars?,
// failurePauseMs?} and ctx.options.fanout = {enabled?, maxConcurrency?,
// defaultAgent?, defaultTimeoutMs?, worktreeBase?}. State lives in
// ctx.storage under "fusion-tools/advisor/" and "fusion-tools/fanout/" with
// an in-memory fallback. Structured logging goes to
// ${HOME}/.local/state/opencode/fusion-tools.log (see lib/log.js).

import { Plugin } from "@opencode/plugin";

import { log } from "./lib/log.js";
import { createStorageAdapter } from "./lib/state.js";
import { redactText } from "./lib/redact.js";
import {
  computeDelta,
  capMessages,
  renderSlice,
} from "./lib/render.js";
import {
  createGuardState,
  runEmissionGuard,
  markDelivered,
  resetBudget,
  refundBudget,
} from "./lib/guard.js";
import {
  routeNote,
  ACK_DELIVERED,
  ACK_QUEUED,
  ACK_RAISED,
  ACK_NOISE,
  ACK_BUDGET,
  ACK_NO_SESSION,
} from "./lib/routing.js";
import { createFanoutModule } from "./lib/fanout.js";
import { createSteerModule } from "./lib/steer.js";

const STORAGE_PREFIX = "fusion-tools/advisor/";
const CURSOR_PREFIX = STORAGE_PREFIX + "cursor/";
const SESSION_PREFIX = STORAGE_PREFIX + "session/";
const OVERRIDE_PREFIX = STORAGE_PREFIX + "override/";

const ACK_BY_REASON = {
  noise: ACK_NOISE,
  "already raised": ACK_RAISED,
  "budget spent": ACK_BUDGET,
};

const ADVISE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: {
      type: "string",
      description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
    },
    severity: {
      type: "string",
      enum: ["nit", "concern", "blocker"],
      description: "How strongly to weigh this. Omit for a plain nit.",
    },
  },
  required: ["note"],
};

const ADVISE_DESCRIPTION =
  "Watched agent: send 1 concrete, terse advice. Use sparingly; stay silent when nothing matters. Call to avert likely-wrong or materially wasteful work.";

// Deferred-queue hard cap (not part of the acceptance criteria; guards
// against unbounded parked notes if a session never reaches another review).
const QUEUE_HARD_CAP = 64;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function noteText(rawNote, severity) {
  // Verbatim template; the severity attribute is omitted for plain nits.
  const sev = severity === "nit" ? "" : ' severity="' + severity + '"';
  return (
    '<advisory advisor="advisor"' +
    sev +
    ' guidance="weigh, don\'t blindly obey">' +
    "\n" +
    rawNote +
    "\n</advisory>"
  );
}

export default Plugin.define({
  id: "fusion-tools",
  async setup(ctx) {
    const raw = (ctx.options && ctx.options.advisor) || {};
    const cfg = {
      enabled: raw.enabled === true,
      model: typeof raw.model === "string" ? raw.model : null,
      scope:
        Array.isArray(raw.scope) && raw.scope.length > 0
          ? raw.scope.filter((s) => typeof s === "string")
          : ["build", "plan"],
      maxNotesPerUpdate: num(raw.maxNotesPerUpdate, 4),
      reviewTimeoutMs: num(raw.reviewTimeoutMs, 120000),
      maxDeltaChars: num(raw.maxDeltaChars, 30000),
      // Review activation: "always" = current behavior (mid-turn + idle
      // reviews); "idle-complex" (default) = no mid-turn reviews, idle
      // reviews only for substantial turns; "off" = no review triggers at
      // all (advise tool + /advisor command still registered).
      activation:
        raw.activation === "always" || raw.activation === "off"
          ? raw.activation
          : "idle-complex",
      minStepsTurn: num(raw.minStepsTurn, 8),
      minTurnDeltaChars: num(raw.minTurnDeltaChars, 8000),
      failurePauseMs: num(raw.failurePauseMs, 900000),
    };

    const storage = createStorageAdapter(ctx.storage);

    // ---------------- fanout config (Phase 2) ----------------
    // enabled defaults to TRUE when the fanout options object exists (the
    // Phase-0 config entry carries fanout: {maxConcurrency: 8}); a missing
    // fanout object means the module is off.
    const rawFanout = ctx.options && ctx.options.fanout ? ctx.options.fanout : null;
    const fanoutCfg = rawFanout
      ? {
          enabled: rawFanout.enabled === undefined ? true : rawFanout.enabled === true,
          maxConcurrency: num(rawFanout.maxConcurrency, 8),
          defaultAgent:
            typeof rawFanout.defaultAgent === "string" && rawFanout.defaultAgent.trim()
              ? rawFanout.defaultAgent.trim()
              : "worker",
          defaultTimeoutMs: num(rawFanout.defaultTimeoutMs, 600000),
          worktreeBase:
            typeof rawFanout.worktreeBase === "string" && rawFanout.worktreeBase.trim()
              ? rawFanout.worktreeBase
              : null,
        }
      : null;

    // state (one plugin generation's live bookkeeping)
    const state = {
      closing: false,
      cfg,
      ownCreated: new Set(), // advisor session ids created by this plugin
      primaryToAdvisor: new Map(), // primarySessionID -> advisorSessionID
      advisorToPrimary: new Map(), // advisorSessionID -> primarySessionID
      primary: new Map(), // primarySessionID -> per-primary state
      activeAdvisorRuns: new Set(), // advisor session ids with a review in flight
      registrations: [],
      // activation gating (Part B): per-session /advisor overrides and the
      // global review circuit breaker
      override: new Map(), // primarySessionID -> "on" | "off"
      pausedUntil: 0, // epoch ms; 0 = breaker armed
      failureStreak: 0, // consecutive advisor review failures
      totalReviews: 0, // completed advisor reviews across all primaries
    };

    log({
      module: "advisor",
      level: "info",
      msg: "setup (load/reload)",
      enabled: cfg.enabled,
      model: cfg.model,
      scope: cfg.scope,
      maxNotesPerUpdate: cfg.maxNotesPerUpdate,
      reviewTimeoutMs: cfg.reviewTimeoutMs,
      maxDeltaChars: cfg.maxDeltaChars,
      activation: cfg.activation,
      minStepsTurn: cfg.minStepsTurn,
      minTurnDeltaChars: cfg.minTurnDeltaChars,
      failurePauseMs: cfg.failurePauseMs,
    });

    // ---------------- steer module (always registered) ----------------
    // Independent of advisor.enabled: registers whenever the plugin loads.
    const steer = createSteerModule({ ctx });
    try {
      const regSteer = await ctx.command.transform((editor) => {
        editor.add(steer.command);
      });
      if (regSteer) state.registrations.push(regSteer);
      log({ module: "steer", level: "info", msg: "steer registered" });
    } catch (err) {
      log({
        module: "steer",
        level: "error",
        msg: "steer command registration failed",
        error: String(err && err.stack ? err.stack : err),
      });
    }

    // ---------------- fanout module (Phase 2; own gate) ----------------
    // Independent of advisor.enabled: fanout has its own options.fanout
    // enabled flag and must stay registered when the advisor is disabled.
    let fanoutModule = null;
    if (!fanoutCfg || !fanoutCfg.enabled) {
      log({ module: "fanout", level: "info", msg: "fanout disabled; registering nothing" });
    } else {
      try {
        fanoutModule = createFanoutModule({ ctx, cfg: fanoutCfg, storage, shared: state });
        const regFanout = await ctx.tool.transform((editor) => {
          editor.add(fanoutModule.tools.fanout);
          editor.add(fanoutModule.tools.submitResult);
        });
        if (regFanout) state.registrations.push(regFanout);
        log({
          module: "fanout",
          level: "info",
          msg: "fanout registered",
          registrations: state.registrations.length,
          maxConcurrency: fanoutCfg.maxConcurrency,
          defaultAgent: fanoutCfg.defaultAgent,
          defaultTimeoutMs: fanoutCfg.defaultTimeoutMs,
          worktreeBase: fanoutModule.config.worktreeBase,
        });
        await fanoutModule.orphanSweep();
      } catch (err) {
        log({
          module: "fanout",
          level: "error",
          msg: "fanout registration failed",
          error: String(err && err.stack ? err.stack : err),
        });
        fanoutModule = null;
      }
    }

    if (!cfg.enabled) {
      log({ module: "advisor", level: "info", msg: "advisor disabled; registering nothing" });
    }

    function getPrimaryPrimary(sessionID) {
      let p = state.primary.get(sessionID);
      if (!p) {
        p = {
          busy: false,
          busyReview: false,
          pending: false,
          agent: null, // last in-scope agent observed by the context hook
          queue: [],
          guard: createGuardState(cfg.maxNotesPerUpdate),
          // per-turn metrics (Part B): reset at each session.idle boundary
          turn: { steps: 0, deltaChars: 0 },
          reviews: 0, // completed advisor reviews for this primary
          lastReviewAt: null, // ISO timestamp of the last completed review
        };
        state.primary.set(sessionID, p);
      }
      return p;
    }

    function resetTurn(p) {
      p.turn.steps = 0;
      p.turn.deltaChars = 0;
    }

    // ---------------- activation gating (Part B) ----------------
    // Effective mode for one primary: the /advisor override wins, otherwise
    // the global activation config. "forced-on" maps to the "always"
    // behavior for that session (mid-turn reviews + every idle turn,
    // thresholds bypassed); "forced-off" suppresses everything for it.
    function effectiveMode(sessionID) {
      const ovr = state.override.get(sessionID);
      if (ovr === "on") return "always";
      if (ovr === "off") return "forced-off";
      return cfg.activation;
    }

    // Circuit breaker: 3 consecutive advisor review failures (prompt/wait
    // errors of any kind, e.g. insufficient funds) pause ALL reviews for
    // cfg.failurePauseMs. A success resets the counter. While paused,
    // triggers skip with one log line.
    function breakerExpired() {
      if (state.pausedUntil > 0 && Date.now() >= state.pausedUntil) {
        state.pausedUntil = 0;
        state.failureStreak = 0;
        log({
          module: "advisor",
          level: "info",
          msg: "advisor breaker pause expired (re-armed)",
        });
      }
    }

    function breakerPaused() {
      breakerExpired();
      return state.pausedUntil > 0;
    }

    function breakerFailure(err) {
      if (state.pausedUntil > 0) return; // already tripped
      state.failureStreak += 1;
      if (state.failureStreak >= 3) {
        state.pausedUntil = Date.now() + cfg.failurePauseMs;
        log({
          module: "advisor",
          level: "warn",
          msg: "advisor breaker tripped (reviews paused)",
          failures: state.failureStreak,
          pausedUntil: new Date(state.pausedUntil).toISOString(),
          lastError: String(err).slice(0, 200),
        });
      }
    }

    function breakerSuccess() {
      if (state.failureStreak !== 0 || state.pausedUntil !== 0) {
        log({
          module: "advisor",
          level: "info",
          msg: "advisor breaker reset (review succeeded)",
          previousFailures: state.failureStreak,
        });
      }
      state.failureStreak = 0;
      state.pausedUntil = 0;
    }

    // Advance the review cursor to "now" (the newest transcript message) so
    // the next real review does not re-read a turn that was skipped.
    async function advanceCursorToNow(primarySessionID) {
      try {
        const messages = await ctx.session.context({ sessionID: primarySessionID });
        const list = Array.isArray(messages) ? messages : [];
        const last = list.length > 0 ? list[list.length - 1] : null;
        const id = last && last.id ? last.id : null;
        if (id) {
          await storage.setJSON(CURSOR_PREFIX + primarySessionID, { lastMessageID: id });
        }
      } catch (err) {
        log({
          module: "advisor",
          level: "warn",
          msg: "cursor advance failed",
          primarySessionID,
          error: String(err),
        });
      }
    }

    // /advisor command feedback: synthetic aside with fusionTools metadata
    // (the render self-filter drops those from reviews).
    async function commandFeedback(sessionID, text) {
      try {
        await ctx.session.synthetic({
          sessionID,
          text,
          description: "advisor command",
          metadata: { fusionTools: "advisor-note" },
          resume: false,
        });
      } catch (err) {
        log({
          module: "advisor",
          level: "warn",
          msg: "advisor command feedback failed",
          sessionID: sessionID || null,
          error: String(err),
        });
      }
    }

    function advisorStatusText(sessionID) {
      breakerExpired();
      const p = state.primary.get(sessionID);
      const ovr = state.override.get(sessionID);
      const paused = state.pausedUntil > 0;
      const lines = [];
      lines.push("advisor status:");
      lines.push(
        "- activation: " +
          cfg.activation +
          (ovr ? " (session override: " + ovr + ")" : " (no session override)"),
      );
      if (cfg.activation === "off") {
        lines.push("- reviews are globally disabled (advisor.activation = off)");
        if (ovr === "on") {
          lines.push("- note: the session override cannot enable reviews while activation is off");
        }
      }
      lines.push(
        "- this session: " +
          (p ? p.reviews : 0) +
          " completed review(s)" +
          (p && p.lastReviewAt ? ", last at " + p.lastReviewAt : ""),
      );
      lines.push("- total completed reviews: " + state.totalReviews);
      lines.push(
        "- breaker: " +
          (paused
            ? "PAUSED until " + new Date(state.pausedUntil).toISOString()
            : "armed") +
          " (consecutive failures " +
          state.failureStreak +
          "/3)",
      );
      lines.push(
        "- idle-complex thresholds: turnSteps >= " +
          cfg.minStepsTurn +
          " OR turnDeltaChars >= " +
          cfg.minTurnDeltaChars,
      );
      return lines.join("\n");
    }

    function isFusionToolsAgent(agent) {
      if (typeof agent !== "string") return false;
      return agent === "advisor" || agent.startsWith("worker") || agent.startsWith("fanout");
    }

    function safeSeverity(s) {
      return s === "concern" || s === "blocker" ? s : "nit";
    }

    // runtime transport back into the primary session
    const realTransport = {
      prompt: async (primarySessionID, note, severity) => {
        await ctx.session.prompt({
          sessionID: primarySessionID,
          text: noteText(note, severity),
          delivery: "steer",
          metadata: { fusionTools: "advisor-note" },
        });
      },
      synthetic: async (primarySessionID, note, severity) => {
        await ctx.session.synthetic({
          sessionID: primarySessionID,
          text: noteText(note, severity),
          description: "advisor note",
          metadata: { fusionTools: "advisor-note" },
          resume: false,
        });
      },
    };

    // transportFor(severity) binds the severity for routeNote's transport
    // interface; realTransport carries it into the actual session calls.
    const transportFor = (severity) => ({
      prompt: (sid, note) => realTransport.prompt(sid, note, severity),
      synthetic: (sid, note) => realTransport.synthetic(sid, note, severity),
      defer: (sid, note, sev) => {
        const p = getPrimaryPrimary(sid);
        p.queue.push({ note: note, severity: safeSeverity(sev) });
        if (p.queue.length > QUEUE_HARD_CAP) p.queue.shift();
      },
    });

    // ---------------- deferred queue flush (A9) ----------------
    async function flushQueue(primarySessionID) {
      const p = getPrimaryPrimary(primarySessionID);
      if (p.queue.length === 0) return;
      const parked = p.queue.splice(0, p.queue.length);
      for (const item of parked) {
        const verdict = runEmissionGuard(p.guard, item.note, item.severity, {
          flush: true,
        });
        if (verdict.action === "drop") {
          log({
            module: "advisor",
            level: "info",
            msg: "deferred note dropped at flush",
            primarySessionID,
            reason: verdict.reason,
          });
          continue;
        }
        try {
          const ack = await routeNote({
            severity: item.severity,
            busy: p.busy,
            note: item.note,
            primarySessionID,
            transport: transportFor(item.severity),
          });
          if (ack === ACK_DELIVERED) markDelivered(p.guard, verdict.normalized);
          if (ack === ACK_QUEUED && item.severity !== "blocker") refundBudget(p.guard);
          log({
            module: "advisor",
            level: "info",
            msg: "delivery decision (flush)",
            primarySessionID,
            ack,
            severity: item.severity,
          });
        } catch (err) {
          log({
            module: "advisor",
            level: "error",
            msg: "flush routing failed",
            primarySessionID,
            error: String(err),
          });
        }
      }
    }

    // ---------------- review pipeline (A3..A7) ----------------
    async function reviewPrimary(primarySessionID) {
      if (state.closing) return; // shutdown: no new review cycles
      const p = getPrimaryPrimary(primarySessionID);
      if (p.busyReview) {
        p.pending = true; // coalesce: one more review after the current one
        log({
          module: "advisor",
          level: "info",
          msg: "review coalesced (mutex busy)",
          primarySessionID,
        });
        return;
      }
      p.busyReview = true;
      let advisorSessionID = null;
      let promptAdmitted = false;
      try {
        // budget for this cycle: deferred flush first, then live advise calls
        resetBudget(p.guard, cfg.maxNotesPerUpdate);
        await flushQueue(primarySessionID);

        let messages = null;
        try {
          messages = await ctx.session.context({ sessionID: primarySessionID });
        } catch (err) {
          log({
            module: "advisor",
            level: "error",
            msg: "context read failed",
            primarySessionID,
            error: String(err),
          });
          return;
        }
        const list = Array.isArray(messages) ? messages : [];
        const cursor = await storage.getJSON(CURSOR_PREFIX + primarySessionID, null);
        const { slice, reset } = computeDelta(list, cursor);
        if (reset && cursor) {
          log({
            module: "advisor",
            level: "info",
            msg: "cursor miss -> full context (compaction/rewrite)",
            primarySessionID,
          });
        }
        const capped = capMessages(slice, cfg.maxDeltaChars);
        const deltaRaw = renderSlice(capped);
        const delta = redactText(deltaRaw);
        // Empty rendered delta: no advisor prompt. The flush above already
        // ran - at an idle boundary it delivered parked notes; mid-turn a
        // busy primary may have re-parked them (they flush at the next
        // boundary, now also triggered by the idle event). The skip message
        // distinguishes a true no-op (no delta AND no deferred notes) from a
        // re-park.
        if (!delta || !delta.trim()) {
          log({
            module: "advisor",
            level: "info",
            msg:
              p.queue.length === 0
                ? "review skipped (no delta, no deferred)"
                : "review skipped (no delta; deferred re-parked)",
            primarySessionID,
          });
          return;
        }
        log({
          module: "advisor",
          level: "info",
          msg: "review-started",
          primarySessionID,
          deltaChars: delta.length,
          deltaMessages: capped.length,
          fullDeltaMessages: slice.length,
        });

        // advisor session (one per primary, lazy)
        advisorSessionID = state.primaryToAdvisor.get(primarySessionID);
        if (!advisorSessionID) {
          let created;
          try {
            created = await ctx.session.create({
              agent: "advisor",
              metadata: { fusionTools: "advisor", primarySessionID },
            });
          } catch (createErr) {
            breakerFailure(createErr);
            throw createErr;
          }
          advisorSessionID = created && created.id;
          if (!advisorSessionID) throw new Error("advisor session create returned no id");
          state.ownCreated.add(advisorSessionID);
          state.advisorToPrimary.set(advisorSessionID, primarySessionID);
          state.primaryToAdvisor.set(primarySessionID, advisorSessionID);
          await storage.setJSON(SESSION_PREFIX + primarySessionID, {
            advisorSessionID,
          });
          log({
            module: "advisor",
            level: "info",
            msg: "advisor session created",
            primarySessionID,
            advisorSessionID,
          });
        }
        state.activeAdvisorRuns.add(advisorSessionID);

        // wait is attached after prompt admission (spec order); the wait is
        // then raced against reviewTimeoutMs.
        try {
          await ctx.session.prompt({
            sessionID: advisorSessionID,
            text: delta,
          });
        } catch (promptErr) {
          breakerFailure(promptErr);
          if (advisorSessionID) {
            // stale advisor session: drop the mapping so the next review
            // creates a fresh advisor session.
            state.ownCreated.delete(advisorSessionID);
            state.advisorToPrimary.delete(advisorSessionID);
            if (state.primaryToAdvisor.get(primarySessionID) === advisorSessionID) {
              state.primaryToAdvisor.delete(primarySessionID);
            }
            void storage.removeJSON(SESSION_PREFIX + primarySessionID);
          }
          throw promptErr;
        }
        promptAdmitted = true;
        log({
          module: "advisor",
          level: "info",
          msg: "advisor prompt admitted",
          advisorSessionID,
          primarySessionID,
        });

        // advance the cursor only after successful admission, then persist
        const last = slice.length > 0 ? slice[slice.length - 1] : null;
        const newCursor = { lastMessageID: last && last.id ? last.id : null };
        if (newCursor.lastMessageID) {
          await storage.setJSON(CURSOR_PREFIX + primarySessionID, newCursor);
        }

        const waitP = ctx.session
          .wait({ sessionID: advisorSessionID })
          .then(() => "done")
          .catch((err) => {
            // prompt/wait errors of any kind (e.g. provider.quota) feed the
            // circuit breaker; the review counts as failed.
            breakerFailure(err);
            log({
              module: "advisor",
              level: "error",
              msg: "advisor wait errored",
              advisorSessionID,
              error: String(err),
            });
            return "wait-error";
          });

        const outcome = await Promise.race([
          waitP,
          sleep(cfg.reviewTimeoutMs).then(() => "timeout"),
        ]);
        if (outcome === "timeout") {
          try {
            await ctx.session.interrupt({ sessionID: advisorSessionID });
          } catch (err) {
            log({
              module: "advisor",
              level: "warn",
              msg: "interrupt on timeout failed",
              advisorSessionID,
              error: String(err),
            });
          }
          log({
            module: "advisor",
            level: "warn",
            msg: "advisor review timed out",
            advisorSessionID,
            primarySessionID,
            timeoutMs: cfg.reviewTimeoutMs,
          });
        } else if (outcome === "wait-error") {
          log({
            module: "advisor",
            level: "warn",
            msg: "advisor review ended with wait error",
            advisorSessionID,
            primarySessionID,
            failureStreak: state.failureStreak,
          });
        } else {
          breakerSuccess();
          p.reviews += 1;
          p.lastReviewAt = new Date().toISOString();
          state.totalReviews += 1;
          log({
            module: "advisor",
            level: "info",
            msg: "advisor review finished",
            advisorSessionID,
            primarySessionID,
          });
        }
      } catch (err) {
        log({
          module: "advisor",
          level: "error",
          msg: "review run failed",
          primarySessionID,
          error: String(err && err.stack ? err.stack : err),
        });
      } finally {
        if (advisorSessionID) state.activeAdvisorRuns.delete(advisorSessionID);
        p.busyReview = false;
        if (p.pending && !state.closing) {
          p.pending = false;
          // fire-and-forget coalesced pass
          void (async () => {
            try {
              await reviewPrimary(primarySessionID);
            } catch (err) {
              log({
                module: "advisor",
                level: "error",
                msg: "coalesced review failed",
                primarySessionID,
                error: String(err),
              });
            }
          })();
        }
      }
    }

    // ---------------- context hook (A1) ----------------
    // Registered when the advisor is enabled OR fanout is enabled (the hook
    // also shapes fusion-agent session tools for the fanout module and
    // enforces the build/plan-only fanout restriction).
    const contextHook = (input) => {
      try {
        const agent = input && input.agent;
        const sessionID = input && input.sessionID;
        // Recursion gate: fusion-tools agents AND any plugin-created session
        // (advisor sessions in ownCreated; fanout workers via the
        // cross-generation worker registry) never see the fanout tool. The
        // sessionID checks catch sessions whose agent name is not
        // fusion-tools-shaped.
        const pluginSession =
          isFusionToolsAgent(agent) ||
          (sessionID ? state.ownCreated.has(sessionID) : false) ||
          (fanoutModule && sessionID ? fanoutModule.hasWorkerRecord(sessionID) : false);
        if (pluginSession) {
          // Hide the fanout tool; inject submit_result for fanout workers
          // (the session tools record is the seam where plugin tools become
          // direct tools for a session).
          if (fanoutModule) fanoutModule.shapeSessionTools(input, agent);
          return;
        }
        // Orchestrator-only fanout (user decision: delegation runs only
        // through the orchestrator primaries): the fanout tool is deleted
        // for every agent that is NOT build or plan (in addition to the
        // fusion-tools-agent and plugin-created-sessionID conditions
        // above). Only fanout is stripped here - submit_result injection
        // stays exclusive to the fusion-agent path above.
        if (
          agent !== "build" &&
          agent !== "plan" &&
          input &&
          input.tools &&
          input.tools.fanout
        ) {
          delete input.tools.fanout;
        }
        if (!agent || !cfg.scope.includes(agent)) return;
        if (!cfg.enabled) return;
        const p = getPrimaryPrimary(sessionID);
        p.busy = true;
        p.agent = agent;
        // Per-turn metrics (Part B): every provider step adds one step and
        // the outbound request payload size as the delta-char estimate.
        // Recorded in every mode; consumed by the idle-complex gating.
        p.turn.steps += 1;
        try {
          p.turn.deltaChars += JSON.stringify(
            input && Array.isArray(input.messages) ? input.messages : [],
          ).length;
        } catch {
          // metrics are best-effort; never block the hook
        }
        log({
          module: "advisor",
          level: "info",
          msg: "context hook (primary turn)",
          primarySessionID: sessionID,
          agent,
          turnSteps: p.turn.steps,
          turnDeltaChars: p.turn.deltaChars,
        });
        // Mid-turn reviews only in "always" mode (or a forced-on session,
        // which effectiveMode maps to "always"). idle-complex reviews at the
        // idle boundary only; "off"/"forced-off" never review. A global
        // activation "off" kills all triggers, overrides included.
        if (cfg.activation === "off") return;
        if (effectiveMode(sessionID) !== "always") return;
        if (breakerPaused()) {
          log({
            module: "advisor",
            level: "warn",
            msg: "advisor reviews paused (breaker); review skipped",
            primarySessionID: sessionID,
            pausedUntil: new Date(state.pausedUntil).toISOString(),
          });
          return;
        }
        // fire-and-forget with its own catch: the hook must return
        // synchronously and never throw.
        void (async () => {
          try {
            await reviewPrimary(sessionID);
          } catch (err) {
            log({
              module: "advisor",
              level: "error",
              msg: "review trigger failed",
              primarySessionID: sessionID,
              error: String(err),
            });
          }
        })();
      } catch (err) {
        log({
          module: "advisor",
          level: "error",
          msg: "context hook guard error",
          error: String(err),
        });
      }
    };

    // ---------------- event subscription (A2) ----------------
    // One subscription dispatches every event to the steer tracker (always)
    // and to the advisor idle handling (only when the advisor is enabled).
    async function handleEvent(event) {
      if (state.closing) return; // shutdown: stop processing events
      try {
        if (!event || typeof event.type !== "string") return;
        steer.handleEvent(event);
        if (!cfg.enabled) return; // advisor idle handling off
        if (event.type === "session.idle") {
          const sessionID = event.data && event.data.sessionID;
          if (!sessionID) return;
          const p = state.primary.get(sessionID);
          if (!p) return;
          p.busy = false;
          log({
            module: "advisor",
            level: "info",
            msg: "primary idle -> busy cleared",
            primarySessionID: sessionID,
          });

          // Terminal turn boundary (omp semantics): request one final review
          // so notes deferred while the primary was busy flush here instead
          // of sitting queued until the NEXT review (or indefinitely, if the
          // turn just ended was the last one).
          //
          // The idle event carries only sessionID, so the scope gates are the
          // ones already recorded in per-primary state: state exists solely
          // through the context hook's full gate (agent in scope, not an
          // advisor/worker session, enabled) and own-created sessions are
          // gated there too.
          if (state.ownCreated.has(sessionID)) {
            resetTurn(p);
            return; // self-review guard
          }
          if (!p.agent || !cfg.scope.includes(p.agent)) return;

          // Activation gating (Part B). The turn's metrics are consumed at
          // this boundary regardless of the outcome.
          const turnSteps = p.turn.steps;
          const turnDeltaChars = p.turn.deltaChars;
          resetTurn(p);
          const mode = effectiveMode(sessionID);
          if (cfg.activation === "off" || mode === "forced-off") {
            if (mode === "forced-off") {
              log({
                module: "advisor",
                level: "info",
                msg: "idle review suppressed (session override off)",
                primarySessionID: sessionID,
              });
            }
            return; // reviews disabled for this session (or globally)
          }
          if (breakerPaused()) {
            log({
              module: "advisor",
              level: "warn",
              msg: "advisor reviews paused (breaker); review skipped",
              primarySessionID: sessionID,
              pausedUntil: new Date(state.pausedUntil).toISOString(),
            });
            return;
          }
          if (mode === "idle-complex") {
            // Only substantial turns earn a review; small ones advance the
            // cursor so their content is not re-read by the next real review.
            const substantial =
              turnSteps >= cfg.minStepsTurn || turnDeltaChars >= cfg.minTurnDeltaChars;
            if (!substantial) {
              await advanceCursorToNow(sessionID);
              log({
                module: "advisor",
                level: "info",
                msg: "idle review skipped (below threshold)",
                primarySessionID: sessionID,
                turnSteps,
                turnDeltaChars,
                minStepsTurn: cfg.minStepsTurn,
                minTurnDeltaChars: cfg.minTurnDeltaChars,
              });
              return;
            }
          }
          void (async () => {
            try {
              await reviewPrimary(sessionID);
            } catch (err) {
              log({
                module: "advisor",
                level: "error",
                msg: "idle-triggered review failed",
                primarySessionID: sessionID,
                error: String(err),
              });
            }
          })();
        }
      } catch (err) {
        log({
          module: "advisor",
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
            module: "advisor",
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

    // ---------------- /advisor command (Part B) ----------------
    // Per-session override: "on" forces reviews for the session (thresholds
    // bypassed, activation mode ignored), "off" suppresses all reviews for
    // it. Persisted best-effort under fusion-tools/advisor/override/.
    async function setOverride(sessionID, value) {
      if (!sessionID) return;
      if (value) {
        state.override.set(sessionID, value);
        try {
          await storage.setJSON(OVERRIDE_PREFIX + sessionID, { override: value });
        } catch (err) {
          log({
            module: "advisor",
            level: "warn",
            msg: "override persistence failed (memory only)",
            sessionID,
            error: String(err),
          });
        }
      } else {
        state.override.delete(sessionID);
        try {
          await storage.removeJSON(OVERRIDE_PREFIX + sessionID);
        } catch (err) {
          log({
            module: "advisor",
            level: "warn",
            msg: "override removal failed (memory only)",
            sessionID,
            error: String(err),
          });
        }
      }
    }

    const advisorCommand = {
      name: "advisor",
      description: "Advisor reviews for this session: /advisor on | off | status",
      execute: async (input) => {
        try {
          const sessionID = input && input.sessionID;
          const rawText =
            input && input.prompt && typeof input.prompt.text === "string"
              ? input.prompt.text
              : "";
          // Accept both the bare args ("on") and the full line ("/advisor on").
          const arg = String(rawText)
            .trim()
            .replace(/^\/advisor\b/i, "")
            .trim()
            .split(/\s+/)[0]
            .toLowerCase();
          if (arg === "on") {
            await setOverride(sessionID, "on");
            await commandFeedback(
              sessionID,
              "advisor: reviews forced ON for this session (every idle turn, thresholds bypassed).",
            );
          } else if (arg === "off") {
            await setOverride(sessionID, "off");
            await commandFeedback(
              sessionID,
              "advisor: reviews suppressed for this session.",
            );
          } else if (arg === "status") {
            await commandFeedback(sessionID, advisorStatusText(sessionID));
          } else {
            await commandFeedback(
              sessionID,
              "advisor: unknown argument" +
                (arg ? " \"" + arg + "\"" : "") +
                ". Usage: /advisor on | off | status",
            );
          }
        } catch (err) {
          log({
            module: "advisor",
            level: "error",
            msg: "advisor command failed",
            error: String(err && err.stack ? err.stack : err),
          });
        }
      },
    };

    // ---------------- rehydrate from storage (hot-reload safety) ----------------
    // Advisor-only: skipped entirely when the advisor is disabled.
    if (cfg.enabled) {
      try {
        const stored = await storage.scanPrefix(STORAGE_PREFIX);
        for (const [key, value] of stored) {
          if (!key.startsWith(SESSION_PREFIX)) continue;
          const primarySessionID = key.slice(SESSION_PREFIX.length);
          const advisorSessionID =
            value && typeof value === "object" ? value.advisorSessionID : null;
          if (!advisorSessionID || !primarySessionID) continue;
          state.primaryToAdvisor.set(primarySessionID, advisorSessionID);
          state.advisorToPrimary.set(advisorSessionID, primarySessionID);
          state.ownCreated.add(advisorSessionID);
        }
        // Part B: restore /advisor per-session overrides ("on" | "off").
        for (const [key, value] of stored) {
          if (!key.startsWith(OVERRIDE_PREFIX)) continue;
          const primarySessionID = key.slice(OVERRIDE_PREFIX.length);
          const override = value && typeof value === "object" ? value.override : null;
          if (!primarySessionID || (override !== "on" && override !== "off")) continue;
          state.override.set(primarySessionID, override);
        }
        if (stored.size > 0) {
          log({
            module: "advisor",
            level: "info",
            msg: "rehydrated advisor mappings from storage",
            sessions: stored.size,
            overrides: state.override.size,
          });
        }
      } catch (err) {
        log({
          module: "advisor",
          level: "warn",
          msg: "storage rehydrate failed (memory only)",
          error: String(err),
        });
      }
    }
    // ---------------- advise tool (A8, A9, A12) ----------------
    const adviseTool = {
      name: "advise",
      description: ADVISE_DESCRIPTION,
      input: ADVISE_INPUT_SCHEMA,
      execute: async (input, context) => {
        try {
          const note =
            typeof input === "object" && input !== null && typeof input.note === "string"
              ? input.note
              : "";
          const severity = safeSeverity(
            typeof input === "object" && input !== null ? input.severity : undefined,
          );
          const advisorSessionID = context && context.sessionID;
          const primarySessionID = state.advisorToPrimary.get(advisorSessionID);
          if (!primarySessionID || state.closing) {
            log({
              module: "advisor",
              level: "info",
              msg: "advise from untracked session",
              advisorSessionID: advisorSessionID ? String(advisorSessionID) : null,
            });
            return { content: ACK_NO_SESSION };
          }
          log({
            module: "advisor",
            level: "info",
            msg: "advise received",
            primarySessionID,
            severity,
            note: redactText(note.slice(0, 80)),
          });
          const p = getPrimaryPrimary(primarySessionID);
          const verdict = runEmissionGuard(p.guard, note, severity);
          if (verdict.action === "drop") {
            const ack = ACK_BY_REASON[verdict.reason] || ACK_NOISE;
            log({
              module: "advisor",
              level: "info",
              msg: "advise dropped by emission guard",
              primarySessionID,
              reason: verdict.reason,
            });
            return { content: ack };
          }
          const ack = await routeNote({
            severity,
            busy: p.busy,
            note,
            primarySessionID,
            transport: transportFor(severity),
          });
          if (ack === ACK_DELIVERED) {
            markDelivered(p.guard, verdict.normalized);
          } else if (ack === ACK_QUEUED && severity !== "blocker") {
            refundBudget(p.guard);
          }
          log({
            module: "advisor",
            level: "info",
            msg: "delivery decision (advise)",
            primarySessionID,
            severity,
            ack,
          });
          return { content: ack };
        } catch (err) {
          log({
            module: "advisor",
            level: "error",
            msg: "advise execute failed",
            error: String(err && err.stack ? err.stack : err),
          });
          throw err;
        }
      },
    };

    // ---------------- registrations ----------------
    // The advise tool and /advisor command are advisor-only; the context
    // hook also shapes fanout session tools, so it registers whenever the
    // advisor OR the fanout module is active.
    if (cfg.enabled) {
      try {
        const regTools = await ctx.tool.transform((editor) => {
          editor.add(adviseTool);
        });
        if (regTools) state.registrations.push(regTools);
      } catch (err) {
        log({
          module: "advisor",
          level: "error",
          msg: "advise tool registration failed",
          error: String(err),
        });
      }
    }
    if (cfg.enabled || fanoutModule) {
      try {
        const regHook = await ctx.session.hook("context", contextHook);
        if (regHook) state.registrations.push(regHook);
      } catch (err) {
        log({
          module: cfg.enabled ? "advisor" : "fanout",
          level: "error",
          msg: "context hook registration failed",
          error: String(err),
        });
      }
    }
    if (cfg.enabled) {
      try {
        const regCmd = await ctx.command.transform((editor) => {
          editor.add(advisorCommand);
        });
        if (regCmd) state.registrations.push(regCmd);
      } catch (err) {
        log({
          module: "advisor",
          level: "error",
          msg: "advisor command registration failed",
          error: String(err),
        });
      }
      log({
        module: "advisor",
        level: "info",
        msg: "advisor registered",
        registrations: state.registrations.length,
      });
    }

    let unloaded = false;
    return async () => {
      log({ module: "advisor", level: "info", msg: "unloaded" });
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
      // interrupt in-flight advisor sessions (best-effort)
      for (const advisorSessionID of Array.from(state.activeAdvisorRuns)) {
        try {
          await ctx.session.interrupt({ sessionID: advisorSessionID });
        } catch {
          // ignore
        }
      }
      state.activeAdvisorRuns.clear();
      state.primaryToAdvisor.clear();
      state.advisorToPrimary.clear();
      state.ownCreated.clear();
      state.primary.clear();
      state.override.clear();
      // fanout teardown (Phase 2): interrupt in-flight workers, free records
      if (fanoutModule) {
        try {
          await fanoutModule.cleanup();
        } catch {
          // ignore
        }
        fanoutModule = null;
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
      log({ module: "advisor", level: "info", msg: "cleanup complete" });
    };
  },
});
