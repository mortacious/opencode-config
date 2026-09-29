// fusion-tools: best-effort storage wrapper around ctx.storage.
// Values must be JSON-serializable (Schema.Json). Every call is wrapped so a
// broken or missing storage domain degrades to the in-memory map instead of
// throwing. Successes are mirrored into memory so reads stay consistent even
// if a later write fails.

export function createStorageAdapter(storage) {
  const memory = new Map(); // key -> JSON value

  async function getJSON(key, fallback = undefined) {
    if (storage) {
      try {
        const v = await storage.get(key);
        if (v !== undefined) {
          memory.set(key, v);
          return v;
        }
        // absent key: fall back to the last mirror, else explicit undefined
        return memory.has(key) ? memory.get(key) : fallback;
      } catch {
        // fall through to memory
      }
    }
    return memory.has(key) ? memory.get(key) : fallback;
  }

  async function setJSON(key, value) {
    memory.set(key, value);
    if (storage) {
      try {
        await storage.set(key, value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async function removeJSON(key) {
    memory.delete(key);
    if (storage) {
      try {
        await storage.remove(key);
      } catch {
        // ignore
      }
    }
  }

  // best-effort prefix scan; on failure the memory map is the only view
  async function scanPrefix(prefix) {
    if (storage) {
      try {
        const out = new Map();
        let after;
        for (;;) {
          const page = await storage.scan({ prefix, after });
          if (!page || !Array.isArray(page.entries)) break;
          for (const e of page.entries) {
            if (e && typeof e.key === "string") out.set(e.key, e.value);
          }
          if (!page.next || !page.next.after) break;
          after = page.next.after;
        }
        return out;
      } catch {
        // fall through
      }
    }
    const out = new Map();
    for (const [k, v] of memory) {
      if (k.startsWith(prefix)) out.set(k, v);
    }
    return out;
  }

  return { getJSON, setJSON, removeJSON, scanPrefix };
}
