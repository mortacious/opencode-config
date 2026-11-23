import assert from "node:assert/strict";
import test from "node:test";

import { createHostClient } from "../lib/host-client.js";

const FAKE_HOST = new URL("./fixtures/fake-host.mjs", import.meta.url).pathname;

function startClient(mode, { onStderr, ...options } = {}) {
  const events = [];
  const stderr = [];
  const client = createHostClient({
    command: process.execPath,
    args: [FAKE_HOST, mode],
    onEvent: (event) => events.push(event),
    onStderr: (chunk) => {
      stderr.push(String(chunk));
      if (onStderr) onStderr(chunk);
    },
    ...options,
  });
  return { client, events, stderr };
}

function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("exec resolves on the matching done event", async () => {
  const { client, events, stderr } = startClient("echo");

  assert.equal(client.exited, false);
  assert.equal(typeof client.pid, "number");

  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  const result = await client.exec({ id: "call-1", code: "1 + 1", timeoutSec: 5 });

  assert.deepEqual(result, { status: "ok", executionCount: 1, lost: false });
  assert.ok(events.some((event) => event.op === "stream" && event.text === "echo:1 + 1"));
  assert.ok(events.some((event) => event.op === "result"));
  assert.ok(stderr.join("").includes("[fake-host] started"));

  await client.shutdown();
  assert.equal(client.exited, true);
});

test("done with error status resolves rather than rejects", async () => {
  const { client, events } = startClient("echo-error");
  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  const result = await client.exec({ id: "boom", code: "1/0", timeoutSec: 5 });
  assert.equal(result.status, "error");

  await client.shutdown();
});

test("partial stdout lines are buffered until the newline arrives", async () => {
  const { client, events } = startClient("frames");

  const ready = await waitFor(() => events.find((event) => event.op === "ready"), {
    label: "ready",
  });
  assert.equal(ready.kernel, "fake");

  const result = await client.exec({ id: "split", code: "42" });
  assert.deepEqual(result, { status: "ok", executionCount: 7, lost: true });

  await client.shutdown();
});

test("malformed stdout lines are ignored", async () => {
  const { client, events } = startClient("garbage");
  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  const result = await client.exec({ id: "after-garbage", code: "1" });
  assert.equal(result.status, "ok");

  await client.shutdown();
});

test("fatal rejects pending calls and later calls", async () => {
  const { client, events } = startClient("fatal");
  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  await assert.rejects(
    client.exec({ id: "fatal-call", code: "raise SystemExit", timeoutSec: 5 }),
    /kernel host fatal: boom/,
  );
  await assert.rejects(
    client.exec({ id: "after-fatal", code: "1", timeoutSec: 5 }),
    /kernel host fatal: boom/,
  );

  await waitFor(() => client.exited, { label: "host exit" });
});

test("a child that exits before done rejects the pending call", async () => {
  const { client } = startClient("silent");

  const pending = client.exec({ id: "lost-call", code: "1", timeoutSec: 0 });
  const settled = assert.rejects(pending, /kernel host exited/);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.kill(), true);
  await settled;
  await waitFor(() => client.exited, { label: "host exit" });

  await assert.rejects(
    client.exec({ id: "late", code: "1", timeoutSec: 5 }),
    /kernel host has exited/,
  );
});

test("an already exited child rejects exec with the exit reason", async () => {
  const { client } = startClient("exit-early");

  await waitFor(() => client.exited, { label: "host exit" });

  await assert.rejects(
    client.exec({ id: "too-late", code: "1", timeoutSec: 5 }),
    /kernel host (has )?exited/,
  );
});

test("no client-side cap when timeoutSec is absent or zero", async () => {
  for (const timeoutSec of [undefined, 0]) {
    const { client } = startClient("silent");

    const pending = client.exec({
      id: `uncapped-${String(timeoutSec)}`,
      code: "sleep()",
      timeoutSec,
    });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, `exec with timeoutSec=${String(timeoutSec)} was capped`);

    client.kill();
    await assert.rejects(pending, /kernel host exited/);
    await waitFor(() => client.exited, { label: "host exit" });
  }
});

test("timeoutSec drives the hard timeout budget", async () => {
  const { client } = startClient("silent", { graceMs: 20 });

  const started = Date.now();
  await assert.rejects(
    client.exec({ id: "tiny-timeout", code: "sleep()", timeoutSec: 0.001 }),
    /timed out after 21 ms/,
  );
  assert.ok(Date.now() - started < 2000, "grace injection kept the cap small");

  client.kill();
  await waitFor(() => client.exited, { label: "host exit" });
});

test("interrupt writes the interrupt op and the call completes interrupted", async () => {
  const { client, events } = startClient("pending");

  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  const pending = client.exec({ id: "interrupt-me", code: "while True: pass", timeoutSec: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(client.interrupt(), true);
  const result = await pending;
  assert.equal(result.status, "interrupted");

  await client.shutdown();
});

test("shutdown resolves when the child exits", async () => {
  const { client, events } = startClient("echo");
  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  assert.equal(client.exited, false);
  const exit = await client.shutdown();
  assert.equal(exit.code, 0);
  assert.equal(client.exited, true);

  const second = await client.shutdown();
  assert.equal(second.code, 0);
});

test("a missing command rejects instead of throwing", async () => {
  const client = createHostClient({
    command: "/definitely/not/a/binary",
    args: [],
    onEvent: () => {},
  });

  await assert.rejects(
    client.exec({ id: "no-binary", code: "1", timeoutSec: 5 }),
    /kernel host (failed|exited)/,
  );
  assert.equal(client.interrupt(), false);
  await client.shutdown();
  assert.equal(client.exited, true);
});

test("exec requires an id and rejects a duplicate", async () => {
  const { client, events } = startClient("pending");
  await waitFor(() => events.some((event) => event.op === "ready"), { label: "ready" });

  await assert.rejects(client.exec({ id: "", code: "1" }), /requires an id/);

  const first = client.exec({ id: "dup", code: "1", timeoutSec: 0 });
  await assert.rejects(client.exec({ id: "dup", code: "2", timeoutSec: 0 }), /duplicate exec id/);

  client.interrupt();
  await first;
  await client.shutdown();
});
