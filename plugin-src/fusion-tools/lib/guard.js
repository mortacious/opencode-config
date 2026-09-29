// fusion-tools: emission guard, ported from the oh-my-pi advisor
// (normalization, content-free blocklist, rank-aware dedupe with a 4096-entry
// FIFO, per-review-cycle advice budget with blocker exemption).
//
// Pure module: no I/O here, so node:test can drive it directly.

export const SEVERITY_RANK = { nit: 1, concern: 2, blocker: 3 };

export const BLOCKLIST = new Set([
  "stop",
  "done",
  "lgtm",
  "looks good",
  "no issue",
  "no issues",
  "continue",
  "proceed",
  "all good",
  "nothing to add",
]);

// NFKC, lowercase, collapse every non-alphanumeric run to one space, trim.
export function normalizeNote(text) {
  return String(text === null || text === undefined ? "" : text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DEDUPE_LIMIT = 4096;

// One guard state per watched primary session.
export function createGuardState(maxNotesPerUpdate) {
  return {
    dedupe: new Map(), // normalized -> {rank, delivered}
    deliveredCount: 0, // non-blocker notes delivered this review cycle
    deliveredCeiling: maxNotesPerUpdate | 0,
  };
}

function fail(reason) {
  return { action: "drop", reason };
}

// opts.flush: true while replaying a note that is already parked in the
// deferred queue (A9 re-check). A pending (undelivered) dedupe entry is that
// same note, not a repeat, so it is allowed through; anything already
// delivered at equal-or-lower severity still drops.
export function runEmissionGuard(state, rawNote, severity, opts = {}) {
  if (typeof rawNote !== "string" || rawNote.trim() === "") {
    return fail("noise");
  }
  const rank = SEVERITY_RANK[severity] || SEVERITY_RANK.nit;
  const normalized = normalizeNote(rawNote);
  if (normalized === "" || BLOCKLIST.has(normalized)) {
    return fail("noise");
  }

  const entry = state.dedupe.get(normalized);
  if (entry) {
    if (opts.flush && !entry.delivered) {
      // replay of the parked note itself
      if (rank > entry.rank) entry.rank = rank; // allow escalation to stand
      return { action: "route", normalized, rank };
    }
    if (rank <= entry.rank) {
      return fail("already raised");
    }
    entry.rank = rank; // escalation: update best severity seen
  } else {
    state.dedupe.set(normalized, { rank, delivered: false });
    if (state.dedupe.size > DEDUPE_LIMIT) {
      // Map preserves insertion order: the first key is the oldest.
      const oldest = state.dedupe.keys().next();
      if (!oldest.done) state.dedupe.delete(oldest.value);
    }
  }

  if (severity !== "blocker") {
    const budget = state.deliveredCeiling;
    if (!(budget > 0)) return fail("budget spent");
    if (state.deliveredCount >= budget) {
      return fail("budget spent");
    }
    state.deliveredCount += 1;
  }

  return { action: "route", normalized, rank };
}

// Mark a note as actually delivered (steer or synthetic). Escalations of the
// same normalized note hit the same entry.
export function markDelivered(state, normalized) {
  const entry = state.dedupe.get(normalized);
  if (entry) entry.delivered = true;
}

// Reset the per-cycle advice budget; called at the start of each review run
// (before deferred notes are flushed, so the flush competes with new advise
// calls on equal footing).
export function resetBudget(state, maxNotesPerUpdate) {
  state.deliveredCount = 0;
  state.deliveredCeiling = maxNotesPerUpdate | 0;
}

// Give back one non-blocker slot when a note ends up deferred (queued) instead
// of delivered: the budget counts deliveries, and the parked note re-checks
// the budget when it is flushed (A9). Floors at zero.
export function refundBudget(state) {
  if (state.deliveredCount > 0) state.deliveredCount -= 1;
}
