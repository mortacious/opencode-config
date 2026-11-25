// Shared active-profile resolution for the Fusion tree.
//
// The same precedence order is applied by the bootstrap's tier table, the
// subagent cap, and the profile switcher:
//   launched OPENCODE_CONFIG overlay
//   > OC_PROFILE (one-off launch override, only when the profile is usable)
//   > location record for the session directory (canonical match, later wins)
//   > raw location record (later wins)
//   > last usable global record
//   > "default"
//
// Consumers pass profileExists to apply their own notion of usable: the
// bootstrap requires profiles/<name>/tiers.json, the switcher requires the
// profile overlay. A candidate the callback rejects is skipped and resolution
// continues with the next one, so a stale record never shadows a usable
// profile. This module is read-only: it never writes .active-profile.

import fs from "node:fs";
import { join } from "node:path";

export function isSafeProfileName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

// A launched overlay sets OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/
// opencode.jsonc (the retired `oc` launcher did this).
// Returns the profile name, or null when the value is absent or shaped
// differently (base config, another file).
export function detectLaunchedProfile(env = process.env) {
  const raw = env && typeof env.OPENCODE_CONFIG === "string" ? env.OPENCODE_CONFIG : "";
  if (!raw) return null;
  const parts = raw.replace(/\\/g, "/").split("/");
  const file = parts.pop();
  const name = parts.pop();
  const container = parts.pop();
  if (file !== "opencode.jsonc" || container !== "profiles") return null;
  return isSafeProfileName(name) ? name : null;
}

// Parse <config>/.active-profile content (format v1) without rewriting it:
//   global\t<name>
//   location\t<absDir>\t<name>
// A file whose text contains no tab is the legacy single-line global form.
// Later records override earlier ones. Invalid/unsafe names and unparseable
// lines are skipped; the file is never rewritten. Mirrors the management
// script's active_parse and profile-switcher's parseActiveStateFile.
export function parseActiveProfileText(text) {
  const state = { global: null, locations: [] };
  if (typeof text !== "string") return state;
  const trimmed = text.trim();
  if (!trimmed) return state;
  if (!text.includes("\t")) {
    if (isSafeProfileName(trimmed)) state.global = trimmed;
    return state;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] === "global" && fields.length === 2) {
      const name = fields[1].trim();
      if (isSafeProfileName(name)) state.global = name;
      continue;
    }
    if (fields[0] === "location" && fields.length === 3) {
      const directory = fields[1];
      const name = fields[2].trim();
      if (directory === "" || !isSafeProfileName(name)) continue;
      state.locations.push({ directory, name });
    }
  }
  return state;
}

// Reads and parses <configDir>/.active-profile. A missing, empty, or
// unreadable file reads as no records (the normal default state).
export function parseActiveProfile(configDir) {
  if (typeof configDir !== "string" || configDir === "") {
    return { global: null, locations: [] };
  }
  let text;
  try {
    text = fs.readFileSync(join(configDir, ".active-profile"), "utf8");
  } catch {
    return { global: null, locations: [] };
  }
  return parseActiveProfileText(text);
}

// The physical (symlink-resolved) spelling of a directory, falling back to the
// raw spelling when it cannot be resolved.
export function canonicalDirectory(directory) {
  if (typeof directory !== "string" || directory === "") return "";
  try {
    return fs.realpathSync(directory);
  } catch {
    return directory;
  }
}

// The profile that applies to one launch/directory. profileExists (optional)
// decides whether a candidate can actually be used; candidates it rejects are
// skipped. Never writes.
export function resolveProfile(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const env = opts.env && typeof opts.env === "object" ? opts.env : process.env;
  const configDir = typeof opts.configDir === "string" ? opts.configDir : "";
  const directory = typeof opts.directory === "string" ? opts.directory.trim() : "";
  const profileExists =
    typeof opts.profileExists === "function" ? opts.profileExists : null;

  const usable = (name) =>
    isSafeProfileName(name) && (profileExists === null || Boolean(profileExists(name)));

  const launched = detectLaunchedProfile(env);
  if (launched) return launched;

  const oneOff = typeof env.OC_PROFILE === "string" ? env.OC_PROFILE.trim() : "";
  if (oneOff && usable(oneOff)) return oneOff;

  const state = parseActiveProfile(configDir);
  if (directory) {
    const canonical = canonicalDirectory(directory);
    let match = null;
    if (canonical) {
      for (const record of state.locations) {
        if (record.directory === canonical && usable(record.name)) {
          match = record.name;
        }
      }
    }
    if (match === null) {
      for (const record of state.locations) {
        if (record.directory === directory && usable(record.name)) {
          match = record.name;
        }
      }
    }
    if (match !== null) return match;
  }
  if (state.global && usable(state.global)) return state.global;
  return "default";
}
