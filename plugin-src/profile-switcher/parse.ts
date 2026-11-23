// profile-switcher: JSONC strip + profile overlay parsing.
//
// Kept free of relative imports so the verification script (and any other
// plain-node consumer) can import this module directly under
// `node --experimental-strip-types`; index.ts delegates here via "./parse.js".
//
// stripJsonc(text): single-pass, string-aware comment stripper. It scans the
// input character by character, tracking whether it is inside a string (and
// which quote opened it), escaping, a line comment, or a block comment, and
// removes comments only OUTSIDE strings. Everything else is preserved
// byte-for-byte; newlines inside a block comment are kept as newlines so line
// structure survives. Trailing commas are stripped in the same pass, but only
// when the scanner is outside a string and the next significant character
// (whitespace and comments skipped) closes an object or array. Never throws.
// parseProfileText(text, label): never throws. Malformed/empty/non-object
// input and profiles with no hot-swappable model settings all produce an
// empty entry list plus a warning (identity by construction); any other
// top-level key yields one "not hot-swappable: <key>" warning while the
// recognized keys still map.
//
// Recognized top-level keys: $schema (ignored), agents (agents.<id>.model
// plus optional agents.<id>.variant), small_model (maps to the built-in
// "title" agent; agents.title.model overrides it when both are present).
//
// All files ASCII only.

import { readFileSync } from "node:fs";

export interface ProfileModelEntry {
  agent: string;
  ref: string;
}

export interface ParsedProfile {
  entries: ProfileModelEntry[];
  warnings: string[];
}

const RECOGNIZED_KEYS = new Set(["$schema", "agents", "small_model"]);

export function stripJsonc(text: string): string {
  // Single pass over the input. States are implicit in the control flow: the
  // cursor is either in normal JSON text, inside a quoted string (inner loop),
  // inside a line comment, or inside a block comment.
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    // String: copy verbatim until the matching quote. A backslash escapes the
    // next character (so `\"` cannot close the string and `\\` is literal).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = text[i];
        out.push(c);
        i++;
        if (c === "\\") {
          if (i < n) {
            out.push(text[i]);
            i++;
          }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "/" && i + 1 < n) {
      const next = text[i + 1];
      // Line comment: drop to (but not including) the line terminator, which
      // is left in place to preserve line structure.
      if (next === "/") {
        i += 2;
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      // Block comment: drop the body but keep newlines so line structure
      // survives. `//` inside a block comment is part of the comment.
      if (next === "*") {
        i += 2;
        while (i < n) {
          if (text[i] === "*" && i + 1 < n && text[i + 1] === "/") {
            i += 2;
            break;
          }
          if (text[i] === "\n" || text[i] === "\r") out.push(text[i]);
          i++;
        }
        continue;
      }
    }
    // Trailing comma: this branch is only reached outside a string (the
    // string inner loop above copies its contents verbatim, so a value like
    // ",]" never gets here). Drop the comma only when the next significant
    // character - skipping whitespace and comments - closes an object/array.
    if (ch === ",") {
      const next = nextSignificant(text, i + 1);
      if (next >= 0 && (text[next] === "}" || text[next] === "]")) {
        i++;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

// Returns the index of the next non-whitespace, non-comment character at or
// after `from`, or -1 if none remains. Used by stripJsonc's trailing-comma
// check so a comma followed by a comment (then } or ]) is still recognized.
function nextSignificant(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && i + 1 < n) {
      const next = text[i + 1];
      if (next === "/") {
        i += 2;
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      if (next === "*") {
        i += 2;
        while (i < n) {
          if (text[i] === "*" && i + 1 < n && text[i + 1] === "/") {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }
    }
    return i;
  }
  return -1;
}

export function parseProfileText(text: string, label: string): ParsedProfile {
  const warnings: string[] = [];
  const entries: ProfileModelEntry[] = [];
  const stripped = stripJsonc(text);
  if (!stripped.trim()) {
    warnings.push(label + ": file is empty; identity applied");
    return { entries, warnings };
  }
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (err) {
    warnings.push(
      label + ": malformed JSON (" + errorText(err) + "); identity applied"
    );
    return { entries, warnings };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    warnings.push(label + ": not a JSON object; identity applied");
    return { entries, warnings };
  }
  const obj = data as Record<string, unknown>;

  // small_model maps to the built-in "title" agent (applied first so an
  // explicit agents.title.model entry below wins when both are present).
  if (typeof obj.small_model === "string" && obj.small_model) {
    entries.push({ agent: "title", ref: obj.small_model });
  }

  for (const key of Object.keys(obj)) {
    if (RECOGNIZED_KEYS.has(key)) continue;
    warnings.push("not hot-swappable: " + key);
  }

  if ("agents" in obj) {
    const agents = obj.agents;
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
      warnings.push(label + ": \"agents\" is not an object; ignored");
    } else {
      for (const [id, raw] of Object.entries(
        agents as Record<string, unknown>
      )) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          warnings.push(label + ": agents." + id + " is not an object; skipped");
          continue;
        }
        const entry = raw as Record<string, unknown>;
        if (typeof entry.model !== "string" || !entry.model) {
          warnings.push(label + ": agents." + id + " has no model; skipped");
          continue;
        }
        let ref = entry.model;
        if (typeof entry.variant === "string" && entry.variant) {
          ref += "#" + entry.variant;
        }
        const existing = entries.findIndex((e) => e.agent === id);
        if (existing >= 0) {
          entries[existing] = { agent: id, ref };
        } else {
          entries.push({ agent: id, ref });
        }
      }
    }
  }

  if (entries.length === 0 && warnings.length === 0) {
    warnings.push(label + ": no model settings found; identity applied");
  }
  return { entries, warnings };
}

export function readProfileFile(file: string): ParsedProfile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return {
      entries: [],
      warnings: ["cannot read " + file + ": " + errorText(err)],
    };
  }
  return parseProfileText(text, file);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
