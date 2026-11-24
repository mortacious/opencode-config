// Journal reader for the kernel plugin.
//
// The host writes one JSON object per line to cells.jsonl and rewrites
// meta.json atomically. This module reads both for the `kernel` RPC (the
// /kernel panel) and for tests. It deliberately does not transform records:
// cell and boundary objects come back exactly as the host wrote them, so a
// display_data output keeps its base64 images.
//
// Line semantics mirror host.py's journal loader: blank lines are skipped, a
// final line without a trailing newline is an in-progress write and is
// ignored, and a malformed complete line is an error.

import { readFile } from "node:fs/promises";

const RECORD_TYPES = new Set(["cell", "boundary"]);

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read the session journal and metadata.
 *
 * @param {{ meta: string, journal: string }} paths - sessionPaths() output
 * @returns {Promise<{ meta: object | null, cells: object[] }>}
 */
export async function readJournal(paths) {
  const metaText = await readIfPresent(paths.meta);
  let meta = null;
  if (metaText !== null) {
    const parsed = JSON.parse(metaText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed;
    }
  }

  const journalText = await readIfPresent(paths.journal);
  const cells = journalText === null ? [] : parseJournal(journalText);
  return { meta, cells };
}

/**
 * Parse a complete journal text. Records of any other type are skipped.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseJournal(text) {
  const records = [];
  const lines = text.split("\n");
  // The segment after the last newline is either empty (the file is fully
  // terminated) or an unterminated in-progress write; ignore it either way.
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    const record = JSON.parse(line);
    if (
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      RECORD_TYPES.has(record.type)
    ) {
      records.push(record);
    }
  }
  return records;
}
