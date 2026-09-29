// fusion-tools tests: emission guard + redaction + delta cursor + cap.
// Run: node --test plugin-src/fusion-tools/test/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createGuardState,
  runEmissionGuard,
  markDelivered,
  resetBudget,
  refundBudget,
  normalizeNote,
  SEVERITY_RANK,
  BLOCKLIST,
} from "../lib/guard.js";

import { redactText, redactPatterns } from "../lib/redact.js";

import {
  computeDelta,
  capMessages,
  renderSlice,
  renderMessage,
  isSelfMessage,
} from "../lib/render.js";

// ---------------- emission guard ----------------

test("guard: blocklist hits are dropped as noise", () => {
  for (const phrase of ["stop", "done", "LGTM!", "looks good", "No issue.", "continue", "proceed", "all good", "nothing to add", "no issues"]) {
    const st = createGuardState(4);
    const verdict = runEmissionGuard(st, phrase, "nit");
    assert.equal(verdict.action, "drop", phrase);
    assert.equal(verdict.reason, "noise");
  }
});

test("guard: normalization (NFKC, lowercase, non-alnum collapse) is applied", () => {
  assert.equal(normalizeNote("Hello,  World!!"), "hello world");
  assert.equal(normalizeNote("  BUTTON-CLICK SCEEN  "), "button click sceen");
  assert.equal(normalizeNote(""), "");
  // "looks good!" normalizes into the blocklist phrase
  assert.equal(normalizeNote("looks!!! good---"), "looks good");
  assert.equal(BLOCKLIST.has(normalizeNote("looks!!! good---")), true);
});

test("guard: dedupe drops a repeat at equal severity", () => {
  const st = createGuardState(8);
  assert.equal(runEmissionGuard(st, "Check the retry loop", "concern").action, "route");
  assert.equal(runEmissionGuard(st, "check the retry loop", "concern").action, "drop");
  assert.equal(runEmissionGuard(st, "CHECK -- the retry loop...", "nit").action, "drop");
});

test("guard: dedupe drops a repeat at LOWER severity", () => {
  const st = createGuardState(8);
  assert.equal(runEmissionGuard(st, "Check the retry loop", "blocker").action, "route");
  assert.equal(runEmissionGuard(st, "Check the retry loop", "concern").action, "drop");
});

test("guard: escalation to higher severity is allowed and updates the stored rank", () => {
  const st = createGuardState(8);
  assert.equal(runEmissionGuard(st, "File named wrong", "concern").action, "route");
  assert.equal(runEmissionGuard(st, "file named wrong", "blocker").action, "route");
  // now the blocker-severity version is stored; a concern repeat drops again
  assert.equal(runEmissionGuard(st, "file named wrong", "concern").action, "drop");
  const entry = st.dedupe.get(normalizeNote("file named wrong"));
  assert.equal(entry.rank, SEVERITY_RANK.blocker);
});

test("guard: budget enforcement caps non-blocker notes per cycle", () => {
  const st = createGuardState(2);
  assert.equal(runEmissionGuard(st, "note one", "concern").action, "route");
  assert.equal(runEmissionGuard(st, "note two", "nit").action, "route");
  const third = runEmissionGuard(st, "note three", "concern");
  assert.equal(third.action, "drop");
  assert.equal(third.reason, "budget spent");
  // a fresh cycle restores the budget while dedupe still applies per note
  resetBudget(st, 2);
  assert.equal(runEmissionGuard(st, "note four fresh", "concern").action, "route");
});

test("guard: blockers are exempt from the budget", () => {
  const st = createGuardState(1);
  assert.equal(runEmissionGuard(st, "budget filler", "concern").action, "route");
  for (let i = 0; i < 3; i++) {
    assert.equal(runEmissionGuard(st, "blocker " + i, "blocker").action, "route");
  }
  assert.equal(runEmissionGuard(st, "still over budget", "nit").action, "drop");
});

test("guard: 4096-entry FIFO bound on the dedupe store", () => {
  const st = createGuardState(100000);
  for (let i = 0; i < 4096; i++) {
    assert.equal(runEmissionGuard(st, "unique note " + i, "nit").action, "route");
  }
  // the boundary: filling 4096 keeps everything
  assert.equal(st.dedupe.size, 4096);
  assert.equal(runEmissionGuard(st, "unique note 0", "nit").action, "drop");
  // one more note evicts the oldest entry (note 0)
  assert.equal(runEmissionGuard(st, "unique note 999999", "nit").action, "route");
  assert.equal(st.dedupe.size, 4096);
  assert.equal(st.dedupe.has("unique note 0"), false);
  // evicted entry is allowed again
  assert.equal(runEmissionGuard(st, "unique note 0", "nit").action, "route");
});

test("guard: resetBudget restores the per-cycle budget", () => {
  const st = createGuardState(2);
  assert.equal(runEmissionGuard(st, "b1", "concern").action, "route");
  assert.equal(runEmissionGuard(st, "b2", "concern").action, "route");
  assert.equal(runEmissionGuard(st, "b3", "concern").action, "drop");
  resetBudget(st, 2);
  assert.equal(runEmissionGuard(st, "b4", "concern").action, "route");
});

test("guard: refundBudget returns a slot to the pool and floors at zero", () => {
  const st = createGuardState(1);
  assert.equal(runEmissionGuard(st, "r1", "concern").action, "route");
  refundBudget(st);
  assert.equal(runEmissionGuard(st, "r2", "concern").action, "route");
  // floor at zero: refunds below zero must not go negative
  resetBudget(st, 1);
  refundBudget(st);
  refundBudget(st);
  assert.equal(st.deliveredCount, 0);
  assert.equal(runEmissionGuard(st, "r3", "concern").action, "route");
});

test("guard: markDelivered makes a repeat drop; empty notes are noise", () => {
  const st = createGuardState(8);
  const v = runEmissionGuard(st, "use await here", "concern");
  markDelivered(st, v.normalized);
  assert.equal(st.dedupe.get("use await here").delivered, true);
  assert.equal(runEmissionGuard(st, "use await here", "concern").action, "drop");

  assert.equal(runEmissionGuard(st, "   ", "nit").action, "drop");
  assert.equal(runEmissionGuard(st, "!!!???---", "nit").action, "drop");
});

// ---------------- redaction ----------------

test("redaction: API-key shapes are replaced", () => {
  assert.match(redactText("key sk-abc123def4567890XYZ"), /\[REDACTED\]/);
  assert.equal(redactText("probably fine sk-abc123def4567890XYZ").includes("sk-abc123def4567890XYZ"), false);
});

test("redaction: github tokens", () => {
  assert.equal(redactText("token ghp_0123456789abcdefghij").includes("ghp_0123456789abcdefghij"), false);
  assert.match(redactText("token gho_0123456789abcdefghij"), /\[REDACTED\]/);
  assert.match(redactText("github_pat_11ABCDEFG0123456789_0123456789"), /\[REDACTED\]/);
});

test("redaction: AWS access key id", () => {
  assert.match(redactText("AKIAIOSFODNN7EXAMPLE style"), /\[REDACTED\]/);
  assert.equal(redactText("AKIAIOSFODNN7EXAMPLE style").includes("AKIAIOSFODNN7EXAMPLE"), false);
});

test("redaction: bearer tokens", () => {
  assert.match(redactText("Authorization: Bearer abc.def1234567890XYZ"), /\[REDACTED\]/);
});

test("redaction: password/secret/token assignments", () => {
  assert.match(redactText("MY_PASSWORD=hunter2secret"), /\[REDACTED\]/);
  assert.match(redactText('set secret = "hunter2secret"'), /\[REDACTED\]/);
  assert.match(redactText("the token: abcdef123456"), /\[REDACTED\]/);
  assert.match(redactText("api key: yyyyyyyyyyyy"), /\[REDACTED\]/);
});

test("redaction: long hex and base64 runs", () => {
  assert.match(redactText("digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), /\[REDACTED\]/);
  assert.match(redactText("b64 dGhpc0lzQVZlcnlMb25nQmFzZTY0U3RyaW5nVmFsdWUxMjM0NQ=="), /\[REDACTED\]/);
});

test("redaction: normal prose survives", () => {
  const text = "The read tool returned status 200 and the agent retried the test run.";
  assert.equal(redactText(text), text);
});

test("redaction: pattern inventory has at least the required families", () => {
  const patterns = redactPatterns().join(" ");
  for (const frag of ["sk-", "gh[pousr]_", "github_pat_", "AKIA", "bearer", "password", "{40,}"]) {
    assert.ok(patterns.includes(frag), "missing pattern fragment: " + frag);
  }
});

// ---------------- delta cursor ----------------

const M = (id, type, extra) => Object.assign({ id, type, time: { created: 0 }, ...(extra || {}) });

test("cursor: found -> slice after cursor", () => {
  const list = [M("a", "user"), M("b", "assistant"), M("c", "user")];
  const r = computeDelta(list, { lastMessageID: "a" });
  assert.equal(r.reset, false);
  assert.deepEqual(r.slice.map((m) => m.id), ["b", "c"]);
});

test("cursor: not found -> full context with reset", () => {
  const list = [M("x", "user"), M("y", "assistant")];
  const r = computeDelta(list, { lastMessageID: "gone" });
  assert.equal(r.reset, true);
  assert.deepEqual(r.slice, list);
});

test("cursor: absent -> full context with reset", () => {
  const list = [M("x", "user")];
  const r = computeDelta(list, null);
  assert.equal(r.reset, true);
  assert.deepEqual(r.slice, list);
});

test("cap: only the most recent blocks fit", () => {
  const slice = [
    M("1", "user", { text: "a".repeat(40) }),
    M("2", "assistant", { content: [{ type: "text", text: "b".repeat(40) }] }),
    M("3", "user", { text: "c".repeat(40) }),
  ];
  // blocks for 2 and 3 cost ~49+55 chars with separators; 90 only fits newest
  let capped = capMessages(slice, 90);
  assert.equal(capped.length, 1);
  assert.deepEqual(capped.map((m) => m.id), ["3"]);
  // a larger cap fits 2 and 3 but not 1
  capped = capMessages(slice, 105);
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map((m) => m.id), ["2", "3"]);
  const text = renderSlice(capped);
  assert.ok(text.includes("[user] c"));
  assert.ok(text.includes("[assistant]"));
  assert.ok(!text.includes("a".repeat(40)));
});

test("cap: a single oversized newest message is still kept", () => {
  const slice = [M("1", "user", { text: "z".repeat(200) })];
  const capped = capMessages(slice, 10);
  assert.equal(capped.length, 1);
});

test("render: tool calls render as one line, no results or reasoning", () => {
  const msgs = [
    M("1", "assistant", {
      agent: "build",
      content: [
        { type: "reasoning", text: "secret internals" },
        { type: "text", text: "let me check" },
        {
          type: "tool",
          name: "read",
          state: { status: "completed", input: { path: "src/x.js" }, content: [{ type: "text", text: "RESULT SHOULD NEVER APPEAR" }] },
        },
      ],
    }),
  ];
  const text = renderSlice(msgs);
  assert.ok(text.includes('Tool read({"path":"src/x.js"})'));
  assert.ok(!text.includes("RESULT SHOULD NEVER APPEAR"));
  assert.ok(!text.includes("secret internals"));
});

test("render: advisor-note synthetic messages are excluded (self-filter)", () => {
  const msgs = [
    M("1", "synthetic", { text: "should appear", description: "system" }),
    M("2", "synthetic", { text: "advisor echo", metadata: { fusionTools: "advisor-note" } }),
    M("3", "synthetic", { text: "other echo", metadata: { fusionTools: "advisor" } }),
  ];
  assert.equal(isSelfMessage(msgs[1]), true);
  assert.equal(isSelfMessage(msgs[2]), true);
  assert.equal(isSelfMessage(msgs[0]), false);
  const text = renderSlice(msgs);
  assert.ok(!text.includes("advisor echo"));
  assert.ok(!text.includes("other echo"));
  assert.ok(text.includes("should appear"));
});

test("render: steered advisor-note user messages are excluded (self-filter covers user branch)", () => {
  const msgs = [
    M("1", "user", { text: "a normal user message stays visible" }),
    M("2", "user", { text: "steered note should not echo", metadata: { fusionTools: "advisor-note" } }),
    M("3", "user", { text: "self-echo under the other marker", metadata: { fusionTools: "advisor" } }),
  ];
  assert.equal(isSelfMessage(msgs[1]), true);
  assert.equal(isSelfMessage(msgs[2]), true);
  assert.equal(isSelfMessage(msgs[0]), false);
  assert.equal(renderMessage(msgs[1]), null, "advisor-note user message renders to null");
  assert.equal(renderMessage(msgs[2]), null, "advisor user message renders to null");
  assert.ok(String(renderMessage(msgs[0])).includes("a normal user message stays visible"));
  const text = renderSlice(msgs);
  assert.ok(!text.includes("steered note should not echo"));
  assert.ok(!text.includes("self-echo under the other marker"));
  assert.ok(text.includes("a normal user message stays visible"));
});
