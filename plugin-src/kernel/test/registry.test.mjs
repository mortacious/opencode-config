import assert from "node:assert/strict";
import test from "node:test";

import { createRegistry } from "../lib/registry.js";

function fakeSpawner() {
  const created = [];
  const spawnHost = async ({ sessionID }) => {
    const host = {
      sessionID,
      exited: false,
      shutdowns: 0,
      async shutdown() {
        this.shutdowns += 1;
        this.exited = true;
      },
      kill() {
        this.exited = true;
      },
    };
    created.push(host);
    return host;
  };
  return { created, spawnHost };
}

function clock() {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

const config = { projectDir: "/project", selection: "/python", hostPython: "/python" };

test("ensure creates one host per session and reuses a live one", async () => {
  const { created, spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const first = await registry.ensure("s1", config);
  const mark = first.lastUsed;
  first.busy = false;
  const second = await registry.ensure("s1", config);

  assert.equal(first, second);
  assert.equal(created.length, 1);
  assert.equal(first.sessionID, "s1");
  assert.equal(first.busy, true);
  assert.ok(first.lastUsed > mark);

  await registry.shutdownAll();
});

test("ensure replaces a host that exited", async () => {
  const { created, spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const first = await registry.ensure("s1", config);
  first.busy = false;
  first.host.exited = true;
  const second = await registry.ensure("s1", config);

  assert.notEqual(first, second);
  assert.equal(created.length, 2);
  assert.equal(registry.get("s1"), second);

  await registry.shutdownAll();
});

test("concurrent ensure calls spawn one host and reject the second as busy", async () => {
  const { created, spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const first = registry.ensure("s1", config);
  const second = registry.ensure("s1", config);
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);

  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "rejected");
  assert.match(secondResult.reason.message, /a cell is already running in this session/);
  assert.equal(created.length, 1);
  assert.equal(registry.get("s1"), firstResult.value);
  assert.equal(firstResult.value.busy, true);

  await registry.shutdownAll();
});

test("a failed spawn drops the reservation so a retry works", async () => {
  const created = [];
  let attempts = 0;
  const spawnHost = async ({ sessionID }) => {
    attempts += 1;
    if (attempts === 1) throw new Error("spawn exploded");
    const host = {
      sessionID,
      exited: false,
      async shutdown() {
        this.exited = true;
      },
    };
    created.push(host);
    return host;
  };
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  await assert.rejects(registry.ensure("s1", config), /spawn exploded/);
  assert.equal(registry.get("s1"), undefined);

  const entry = await registry.ensure("s1", config);
  assert.equal(entry.busy, true);
  assert.equal(registry.get("s1"), entry);
  assert.equal(created.length, 1);

  await registry.shutdownAll();
});

test("lru eviction removes the least recently used idle entry", async () => {
  const { created, spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 2, spawnHost, now: clock() });

  const a = await registry.ensure("a", config);
  const b = await registry.ensure("b", config);
  a.busy = false;
  b.busy = false;

  const c = await registry.ensure("c", config);

  assert.equal(registry.get("a"), undefined);
  assert.equal(a.host.shutdowns, 1);
  assert.equal(registry.get("b"), b);
  assert.equal(registry.get("c"), c);
  assert.equal(created.length, 3);

  await registry.shutdownAll();
});

test("lru keeps touch order across reuses", async () => {
  const { spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 2, spawnHost, now: clock() });

  const a = await registry.ensure("a", config);
  a.busy = false;
  const b = await registry.ensure("b", config);
  b.busy = false;

  await registry.ensure("a", config);
  a.busy = false;

  await registry.ensure("c", config);

  assert.equal(registry.get("a"), a);
  assert.equal(registry.get("b"), undefined);
  assert.equal(b.host.shutdowns, 1);

  await registry.shutdownAll();
});

test("busy entries are never evicted and overflow is allowed", async () => {
  const { created, spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 1, spawnHost, now: clock() });

  const a = await registry.ensure("a", config);
  const b = await registry.ensure("b", config);

  assert.equal(registry.get("a"), a);
  assert.equal(registry.get("b"), b);
  assert.equal(a.host.shutdowns, 0);
  assert.equal(created.length, 2);

  a.busy = false;
  const c = await registry.ensure("c", config);

  assert.equal(registry.get("a"), undefined);
  assert.equal(registry.get("b"), b);
  assert.equal(registry.get("c"), c);
  assert.equal(a.host.shutdowns, 1);
  assert.equal(b.host.shutdowns, 0);

  await registry.shutdownAll();
});

test("delete shuts the host down and drops the entry", async () => {
  const { spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const a = await registry.ensure("a", config);

  assert.equal(await registry.delete("a"), true);
  assert.equal(a.host.shutdowns, 1);
  assert.equal(registry.get("a"), undefined);
  assert.equal(await registry.delete("a"), false);
  assert.equal(await registry.delete("unknown"), false);
});

test("shutdownAll tears every entry down", async () => {
  const { spawnHost } = fakeSpawner();
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const a = await registry.ensure("a", config);
  const b = await registry.ensure("b", config);

  await registry.shutdownAll();

  assert.equal(a.host.shutdowns, 1);
  assert.equal(b.host.shutdowns, 1);
  assert.equal(registry.get("a"), undefined);
  assert.equal(registry.get("b"), undefined);
});

test("shutdownAll skips a pending spawn reservation without logging", async () => {
  let release;
  const spawnHost = ({ sessionID }) =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          sessionID,
          exited: false,
          async shutdown() {
            this.exited = true;
          },
        });
    });
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  const original = console.error;
  const logs = [];
  console.error = (message) => logs.push(String(message));
  try {
    const pending = registry.ensure("p", config);
    assert.equal(registry.get("p").host, null);
    await registry.shutdownAll();
    release();
    await assert.rejects(pending, /released while starting/);
  } finally {
    console.error = original;
  }

  assert.deepEqual(logs, []);
  assert.equal(registry.get("p"), undefined);
});

test("shutdown errors are swallowed after logging", async () => {
  const spawnHost = async ({ sessionID }) => ({
    sessionID,
    exited: false,
    async shutdown() {
      throw new Error("host already gone");
    },
  });
  const registry = createRegistry({ max: 4, spawnHost, now: clock() });

  await registry.ensure("a", config);

  const original = console.error;
  const logs = [];
  console.error = (message) => logs.push(String(message));
  try {
    assert.equal(await registry.delete("a"), true);
  } finally {
    console.error = original;
  }

  assert.equal(registry.get("a"), undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /host already gone/);
});
