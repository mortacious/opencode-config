// fusion-tools: advisor module (Phase 1).
//
// A peer-reviewer that watches scoped primary agent sessions (currently
// build/plan), renders redacted deltas of their transcript, runs them through
// a second "advisor" agent on its own session, and routes the advisor's
// `advise` tool calls back into the primary as advisory notes with
// severity-based delivery.
//
// Config lives in opencode.jsonc plugins entry options: ctx.options.advisor =
// {enabled, model?, scope?, maxNotesPerUpdate?, reviewTimeoutMs?,
// maxDeltaChars?}. State lives in ctx.storage under "fusion-tools/advisor/"
// with an in-memory fallback. Structured logging goes to
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

const STORAGE_PREFIX = "fusion-tools/advisor/";
const CURSOR_PREFIX = STORAGE_PREFIX + "cursor/";
const SESSION_PREFIX = STORAGE_PREFIX + "session/";

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
    };

    const storage = createStorageAdapter(ctx.storage);

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
    });

    if (!cfg.enabled) {
      log({ module: "advisor", level: "info", msg: "advisor disabled; registering nothing" });
      return async () => {
        log({ module: "advisor", level: "info", msg: "unloaded" });
      };
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
        };
        state.primary.set(sessionID, p);
      }
      return p;
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
          const created = await ctx.session.create({
            agent: "advisor",
            metadata: { fusionTools: "advisor", primarySessionID },
          });
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
            log({
              module: "advisor",
              level: "error",
              msg: "advisor wait errored",
              advisorSessionID,
              error: String(err),
            });
            return "done";
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
        } else {
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
    const contextHook = (input) => {
      try {
        const agent = input && input.agent;
        const sessionID = input && input.sessionID;
        if (isFusionToolsAgent(agent)) return;
        if (sessionID && state.ownCreated.has(sessionID)) return;
        if (!agent || !cfg.scope.includes(agent)) return;
        if (!cfg.enabled) return;
        const p = getPrimaryPrimary(sessionID);
        p.busy = true;
        p.agent = agent;
        log({
          module: "advisor",
          level: "info",
          msg: "context hook (primary turn)",
          primarySessionID: sessionID,
          agent,
        });
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
    async function handleEvent(event) {
      if (state.closing) return; // shutdown: stop processing events
      try {
        if (!event || typeof event.type !== "string") return;
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
          // gated there too. Re-verify the two state-dependent gates, then
          // go through the SAME review pipeline (its per-primary mutex
          // coalesces a concurrent review into one pending pass).
          if (state.ownCreated.has(sessionID)) return; // self-review guard
          if (!p.agent || !cfg.scope.includes(p.agent)) return;
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

    // ---------------- rehydrate from storage (hot-reload safety) ----------------
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
      if (stored.size > 0) {
        log({
          module: "advisor",
          level: "info",
          msg: "rehydrated advisor mappings from storage",
          sessions: stored.size,
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

    // ---------------- registrations ----------------
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
    try {
      const regHook = await ctx.session.hook("context", contextHook);
      if (regHook) state.registrations.push(regHook);
    } catch (err) {
      log({
        module: "advisor",
        level: "error",
        msg: "context hook registration failed",
        error: String(err),
      });
    }

    log({
      module: "advisor",
      level: "info",
      msg: "advisor registered",
      registrations: state.registrations.length,
    });

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
