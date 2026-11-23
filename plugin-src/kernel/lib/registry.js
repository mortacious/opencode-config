/**
 * Per-session host registry with LRU eviction.
 *
 * `spawnHost({ sessionID, projectDir, selection, hostPython })` returns a host
 * object exposing `shutdown()` (async) and an `exited` flag. Callers own the
 * `busy` flag: `ensure` sets it while the session is in use and the caller
 * clears it when the execution finishes.
 *
 * `ensure` reserves the session slot synchronously, before awaiting the spawn,
 * so two concurrent calls for one session spawn exactly one host: the second
 * call rejects with `a cell is already running in this session`. A failed spawn
 * drops the reservation so a retry can spawn again.
 */
export function createRegistry({
  max = 4,
  spawnHost,
  now = Date.now,
  log = (message) => console.error(message),
} = {}) {
  if (typeof spawnHost !== "function") {
    throw new TypeError("createRegistry requires spawnHost");
  }

  const limit = Math.max(1, Math.floor(max) || 1);
  const entries = new Map();
  const order = new Map();
  let sequence = 0;

  const isLive = (entry) => Boolean(entry.host) && entry.host.exited !== true;

  const touch = (sessionID, entry) => {
    sequence += 1;
    order.set(sessionID, sequence);
    entry.lastUsed = now();
  };

  const pickVictim = (protectedID) => {
    let victim = null;
    let bestKey = Infinity;

    for (const [sessionID, entry] of entries) {
      if (sessionID === protectedID) continue;
      if (entry.spawning) continue;
      const live = isLive(entry);
      if (live && entry.busy) continue;
      const key = live ? (order.get(sessionID) ?? 0) : -Infinity;
      if (victim === null || key < bestKey) {
        victim = sessionID;
        bestKey = key;
      }
    }

    return victim;
  };

  const evict = async (sessionID) => {
    const entry = entries.get(sessionID);
    if (!entry) return false;
    entries.delete(sessionID);
    order.delete(sessionID);
    if (!entry.host) return true;
    try {
      await entry.host.shutdown();
    } catch (error) {
      log(
        `[kernel-registry] shutdown failed for session ${sessionID}: ${
          error?.message ?? String(error)
        }`,
      );
    }
    return true;
  };

  const makeRoom = async (protectedID) => {
    // The caller inserts its reservation first, so this loop counts that slot:
    // evict until the registry holds at most `limit` entries.
    while (entries.size > limit) {
      const victim = pickVictim(protectedID);
      if (victim === null) return;
      await evict(victim);
    }
  };

  const ensure = async (sessionID, { projectDir, selection, hostPython } = {}) => {
    if (typeof sessionID !== "string" || sessionID === "") {
      throw new TypeError("ensure requires a session id");
    }

    const existing = entries.get(sessionID);
    if (existing) {
      if (existing.busy) {
        throw new Error("a cell is already running in this session");
      }
      if (isLive(existing)) {
        touch(sessionID, existing);
        existing.busy = true;
        return existing;
      }
      entries.delete(sessionID);
      order.delete(sessionID);
    }

    // Reserve the slot before awaiting anything: a concurrent ensure for this
    // session now sees a busy entry and rejects instead of spawning again.
    const entry = { sessionID, host: null, lastUsed: 0, busy: true, spawning: true };
    entries.set(sessionID, entry);
    sequence += 1;
    order.set(sessionID, sequence);

    try {
      await makeRoom(sessionID);
      const host = await spawnHost({ sessionID, projectDir, selection, hostPython });
      entry.host = host;
      entry.spawning = false;
      if (entries.get(sessionID) !== entry) {
        // The session was deleted or evicted while the host was starting.
        try {
          await host.shutdown();
        } catch (error) {
          log(
            `[kernel-registry] shutdown failed for session ${sessionID}: ${
              error?.message ?? String(error)
            }`,
          );
        }
        throw new Error("kernel host was released while starting");
      }
      touch(sessionID, entry);
      return entry;
    } catch (error) {
      if (entries.get(sessionID) === entry) {
        entries.delete(sessionID);
        order.delete(sessionID);
      }
      throw error;
    }
  };

  const get = (sessionID) => entries.get(sessionID);

  const remove = async (sessionID) => evict(sessionID);

  const shutdownAll = async () => {
    const hosts = [...entries.entries()];
    entries.clear();
    order.clear();
    await Promise.allSettled(
      hosts.map(async ([sessionID, entry]) => {
        // A spawn-in-progress reservation has no host yet; nothing to stop.
        if (!entry.host) return;
        try {
          await entry.host.shutdown();
        } catch (error) {
          log(
            `[kernel-registry] shutdown failed for session ${sessionID}: ${
              error?.message ?? String(error)
            }`,
          );
        }
      }),
    );
  };

  return { ensure, get, delete: remove, shutdownAll };
}
