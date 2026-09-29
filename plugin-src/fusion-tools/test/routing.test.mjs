// fusion-tools tests: routing table (all 6 cells) with a mocked transport.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideRoute,
  routeNote,
  ACK_DELIVERED,
  ACK_QUEUED,
  ACK_NO_SESSION,
} from "../lib/routing.js";

function makeTransport() {
  const calls = { prompt: [], synthetic: [], defer: [] };
  return {
    calls,
    prompt: async (sid, note) => {
      calls.prompt.push([sid, note]);
    },
    synthetic: async (sid, note) => {
      calls.synthetic.push([sid, note]);
    },
    defer: (sid, note, severity) => {
      calls.defer.push([sid, note, severity]);
    },
  };
}

test("routing table: busy x blocker -> prompt steer", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "blocker", busy: true, note: "n", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_DELIVERED);
  assert.deepEqual(t.calls.prompt, [["P", "n"]]);
  assert.equal(t.calls.synthetic.length, 0);
  assert.equal(t.calls.defer.length, 0);
});

test("routing table: busy x concern -> defer", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "concern", busy: true, note: "n1", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_QUEUED);
  assert.deepEqual(t.calls.defer, [["P", "n1", "concern"]]);
});

test("routing table: busy x nit -> defer", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "nit", busy: true, note: "n2", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_QUEUED);
  assert.deepEqual(t.calls.defer, [["P", "n2", "nit"]]);
});

test("routing table: idle x blocker -> prompt steer (starts a run)", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "blocker", busy: false, note: "n3", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_DELIVERED);
  assert.deepEqual(t.calls.prompt, [["P", "n3"]]);
});

test("routing table: idle x concern -> synthetic resume:false", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "concern", busy: false, note: "n4", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_DELIVERED);
  assert.deepEqual(t.calls.synthetic, [["P", "n4"]]);
});

test("routing table: idle x nit -> synthetic resume:false", async () => {
  const t = makeTransport();
  const ack = await routeNote({ severity: "nit", busy: false, note: "n5", primarySessionID: "P", transport: t });
  assert.equal(ack, ACK_DELIVERED);
  assert.deepEqual(t.calls.synthetic, [["P", "n5"]]);
});

test("decideRoute: all six cells directly", () => {
  assert.equal(decideRoute("blocker", true), "prompt");
  assert.equal(decideRoute("concern", true), "defer");
  assert.equal(decideRoute("nit", true), "defer");
  assert.equal(decideRoute("blocker", false), "prompt");
  assert.equal(decideRoute("concern", false), "synthetic");
  assert.equal(decideRoute("nit", false), "synthetic");
});

test("routeNote: routing failure propagates as a tool error", async () => {
  const t = {
    prompt: async () => {
      throw new Error("session gone");
    },
    synthetic: async () => {},
    defer: () => {},
  };
  await assert.rejects(
    routeNote({ severity: "blocker", busy: true, note: "n", primarySessionID: "P", transport: t }),
    /routing failed/,
  );
});
