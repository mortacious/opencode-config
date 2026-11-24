#!/usr/bin/env node
/**
 * validate-config.mjs - static validation of the Fusion OpenCode config.
 *
 * Dependency-free (Node >= 20 stdlib). Usage:
 *
 *   node scripts/validate-config.mjs [rootDir]
 *
 * rootDir defaults to the repository root (the parent of scripts/). Point it
 * at a copy of the config to test the validator itself.
 *
 * Prints one PASS/FAIL line per check plus a final "N checks, M failures"
 * summary. Exit code is 0 when every check passes, 1 when any check fails,
 * 2 on a usage error (rootDir missing or not a directory).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildExpansion,
  diffOverlay,
  listTierProfiles,
  parseModelRef,
  validateTiersData,
} from './tiers-sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(HERE, '..'));

// Agents that exist in opencode defaults and therefore need no
// agents/<name>.md file of their own. All fused agents are local files;
// build and plan are built-in primaries the repo disables
// (`agents.<name>.disabled: true`) rather than overriding, so they have no
// local files. They are deliberately NOT here: a rename or deletion
// must fail loudly instead of silently falling back to the built-in.
const BUILTIN_AGENTS = new Set(['title', 'general', 'compaction', 'summary']);

// Canonical coarse-grained permission actions (opencode v2), plus tool-id
// actions: MCP tool ids such as ddgs_search_text and built-in/plugin tool ids
// that are bare lowercase words (grep, glob, prune from opencode-dcp).
// "*" is the blanket wildcard.
const CANONICAL_ACTIONS = new Set([
  'read',
  'edit',
  'shell',
  'subagent',
  'skill',
  'webfetch',
  'websearch',
  'external_directory',
  'execute',
  'grep',
  'glob',
  'prune',
  'steer',
  'report',
  '*',
]);

// V1 names that are silent no-ops inside a V2 permissions array.
const LEGACY_ACTIONS = new Set(['bash', 'task', 'write', 'apply_patch', 'patch']);

// MCP/plugin tool ids: lowercase words joined by underscores, at least one.
const TOOL_ACTION_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

const PLAN_LOG_LIMIT = 10240;
const SKILL_DESCRIPTION_LIMIT = 1024;
const AGENT_FRONTMATTER_KEYS = new Set(['description', 'mode', 'permissions']);

// A `{ "disabled": true }` entry removes a built-in agent from the config and
// carries no model pin, so the pin checks skip it. Opencode's own builtin ids
// (title, general, compaction, summary, plus the disabled build/plan primaries)
// are not roster data this repo authors, so they are the one permitted
// exception to the no-agent-name-literal rule enforced by the committer check.
function isDisabledPin(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      entry.disabled === true,
  );
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function rel(p) {
  const r = path.relative(ROOT, p);
  return r === '' ? '.' : r;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

// Directories never walked by any check: vendored dependencies (install.sh
// populates plugin-src/<pkg>/node_modules on deploy) and git internals.
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function skipDir(name) {
  return SKIP_DIRS.has(name);
}

function listFiles(dir, recursive) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDir(entry.name)) continue;
      if (recursive) out.push(...listFiles(full, true));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function firstLine(text) {
  return String(text).split(/\r?\n/)[0].slice(0, 160);
}

function summarize(bad, okReason) {
  if (bad.length === 0) return { ok: true, reason: okReason };
  const shown = bad.slice(0, 6).join('; ');
  const more = bad.length > 6 ? ` (+${bad.length - 6} more)` : '';
  return { ok: false, reason: shown + more };
}

// ---------------------------------------------------------------------------
// JSONC: strip // and /* */ comments and trailing commas, then JSON.parse.
// String state is tracked so "//" inside a URL value survives.
// ---------------------------------------------------------------------------

function stripJsoncComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      if (i < text.length) out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text)));
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser (block mappings, block sequences of
// mappings, plain/quoted scalars, inline {} maps). Enough for agent and
// skill frontmatter; not a general YAML implementation.
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('"')) {
    let end = -1;
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === '\\') {
        i += 1;
        continue;
      }
      if (s[i] === '"') {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      const literal = s.slice(0, end + 1);
      try {
        return JSON.parse(literal);
      } catch {
        return literal.slice(1, -1);
      }
    }
    return s;
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    if (end !== -1) return s.slice(1, end).replace(/''/g, "'");
    return s;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return s;
}

function parseInlineMap(text) {
  const s = text.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const inner = s.slice(1, -1);
  const parts = [];
  let buf = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      buf += ch;
      if (ch === '\\' && quote === '"') {
        i += 1;
        buf += inner[i] ?? '';
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') parts.push(buf);
  const out = Object.create(null);
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === '') continue;
    out[key] = parseScalar(value);
  }
  return out;
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const keys = [];
  const values = Object.create(null);
  const permissions = [];
  let currentKey = null;
  let currentItem = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const m = /^([A-Za-z0-9_$@.-]+)\s*:\s*(.*)$/.exec(raw);
      if (!m) continue;
      currentKey = m[1];
      currentItem = null;
      keys.push(currentKey);
      values[currentKey] = parseScalar(m[2]);
      continue;
    }
    if (currentKey !== 'permissions') continue;
    const itemStart = /^\s*-\s*(.*)$/.exec(raw);
    if (itemStart) {
      currentItem = Object.create(null);
      permissions.push(currentItem);
      const rest = itemStart[1].trim();
      const inline = parseInlineMap(rest);
      if (inline) {
        Object.assign(currentItem, inline);
      } else {
        const kv = /^([A-Za-z0-9_$@.-]+)\s*:\s*(.*)$/.exec(rest);
        if (kv) currentItem[kv[1]] = parseScalar(kv[2]);
      }
      continue;
    }
    if (!currentItem) continue;
    const kv = /^\s*([A-Za-z0-9_$@.-]+)\s*:\s*(.*)$/.exec(raw);
    if (kv) currentItem[kv[1]] = parseScalar(kv[2]);
  }
  return { keys, values, permissions };
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

let baseConfigCache = null;

function loadBaseConfig() {
  if (baseConfigCache) return baseConfigCache;
  const file = path.join(ROOT, 'opencode.jsonc');
  const text = readText(file);
  baseConfigCache = { file, text, config: parseJsonc(text) };
  return baseConfigCache;
}

let overlayCache = null;

function loadOverlays() {
  if (overlayCache) return overlayCache;
  const dir = path.join(ROOT, 'profiles');
  const out = [];
  if (isDir(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (skipDir(entry.name)) continue;
      const file = path.join(dir, entry.name, 'opencode.jsonc');
      if (!isFile(file)) continue;
      try {
        out.push({ file, config: parseJsonc(readText(file)), error: null });
      } catch (error) {
        out.push({ file, config: null, error: error.message });
      }
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  overlayCache = out;
  return out;
}

function agentMarkdownFiles() {
  const dir = path.join(ROOT, 'agents');
  if (!isDir(dir)) return [];
  return listFiles(dir, false).filter((f) => f.endsWith('.md'));
}

const frontmatterCache = new Map();

function agentFrontmatter(file) {
  if (frontmatterCache.has(file)) return frontmatterCache.get(file);
  let result = null;
  try {
    result = parseFrontmatter(readText(file));
  } catch {
    result = null;
  }
  frontmatterCache.set(file, result);
  return result;
}

function permissionSources() {
  const sources = [];
  for (const file of agentMarkdownFiles()) {
    const fm = agentFrontmatter(file);
    if (fm && Array.isArray(fm.permissions)) {
      sources.push({ label: rel(file), rules: fm.permissions });
    }
  }
  try {
    const cfg = loadBaseConfig().config;
    if (cfg && Array.isArray(cfg.permissions)) {
      sources.push({ label: rel(baseConfigCache.file), rules: cfg.permissions });
    }
  } catch {
    // parse failure is reported by check 1
  }
  for (const overlay of loadOverlays()) {
    if (overlay.config && Array.isArray(overlay.config.permissions)) {
      sources.push({ label: rel(overlay.file), rules: overlay.config.permissions });
    }
  }
  return sources;
}

// Provider ids declared by the config. opencode v2 renamed the block to
// "providers"; accept the singular spelling too so both layouts are checked.
function providerIds(cfg) {
  const ids = new Set();
  if (!cfg || typeof cfg !== 'object') return ids;
  for (const key of ['provider', 'providers']) {
    const block = cfg[key];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const id of Object.keys(block)) ids.add(id);
  }
  return ids;
}

// "<provider>/<model>" with an optional "#variant". Provider and model must be
// non-empty; the variant only has to be non-empty (models.dev validation is a
// network concern and stays out of this static validator).
function parseModelPin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slash).trim();
  let model = trimmed.slice(slash + 1).trim();
  if (provider === '' || model === '') return null;
  const hash = model.indexOf('#');
  if (hash !== -1) {
    const variant = model.slice(hash + 1).trim();
    model = model.slice(0, hash).trim();
    if (model === '' || variant === '') return null;
  }
  return { provider, model };
}

// Declared variant ids per provider/model, but only where opencode.jsonc
// declares a variants array for that model (shape: [{ id, settings|body }]).
// A model with no variants array is not variant-constrained here.
function declaredVariants(cfg) {
  const out = new Map();
  if (!cfg || typeof cfg !== 'object') return out;
  for (const key of ['provider', 'providers']) {
    const block = cfg[key];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [provider, providerCfg] of Object.entries(block)) {
      if (!providerCfg || typeof providerCfg !== 'object' || Array.isArray(providerCfg)) continue;
      const models = providerCfg.models;
      if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
      for (const [model, modelCfg] of Object.entries(models)) {
        if (!modelCfg || typeof modelCfg !== 'object' || !Array.isArray(modelCfg.variants)) continue;
        const ids = new Set();
        for (const entry of modelCfg.variants) {
          if (typeof entry === 'string') ids.add(entry);
          else if (entry && typeof entry === 'object' && typeof entry.id === 'string') ids.add(entry.id);
        }
        if (!out.has(provider)) out.set(provider, new Map());
        out.get(provider).set(model, ids);
      }
    }
  }
  return out;
}

// Configured MCP server ids. The block is either { servers: { ... } } or a
// direct map of server definitions.
function mcpServerIds(cfg) {
  const ids = new Set();
  const block = cfg && typeof cfg === 'object' ? cfg.mcp : undefined;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ids;
  const container =
    block.servers && typeof block.servers === 'object' && !Array.isArray(block.servers)
      ? block.servers
      : block;
  for (const id of Object.keys(container)) ids.add(id);
  return ids;
}

// File lines after the closing frontmatter delimiter, with 1-based line
// numbers so findings point at real file locations.
function bodyLines(text) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines.length > 0 && lines[0].trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end !== -1) start = end + 1;
  }
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    out.push({ lineNo: i + 1, text: lines[i] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

check('opencode.jsonc parses (JSONC comments + trailing commas stripped)', () => {
  const { text, config } = loadBaseConfig();
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, reason: 'top-level value is not an object' };
  }
  return { ok: true, reason: `${text.length} bytes` };
});

check('every agents.* pin resolves to agents/<name>.md or a built-in', () => {
  const cfg = loadBaseConfig().config;
  const pins = cfg ? cfg.agents : undefined;
  if (pins === undefined) return { ok: true, reason: 'no agents.* pins' };
  if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
    return { ok: false, reason: 'agents is not an object' };
  }
  const names = Object.keys(pins);
  const bad = [];
  for (const name of names) {
    if (BUILTIN_AGENTS.has(name)) continue;
    if (isDisabledPin(pins[name])) continue;
    if (!isFile(path.join(ROOT, 'agents', `${name}.md`))) {
      bad.push(`opencode.jsonc: agents.${name} has no agents/${name}.md and is not a built-in`);
    }
  }
  return summarize(bad, `${names.length} pins resolve`);
});

check('agent frontmatter: description + mode only (plus permissions)', () => {
  const dir = path.join(ROOT, 'agents');
  if (!isDir(dir)) return { ok: false, reason: 'agents/ directory not found' };
  const files = agentMarkdownFiles();
  if (files.length === 0) return { ok: false, reason: 'agents/ has no .md files' };
  const bad = [];
  for (const file of files) {
    const name = path.basename(file);
    const fm = agentFrontmatter(file);
    if (!fm) {
      bad.push(`${name}: missing or unclosed frontmatter`);
      continue;
    }
    const keySet = new Set(fm.keys);
    if (!keySet.has('description')) {
      bad.push(`${name}: missing description`);
    } else if (typeof fm.values.description !== 'string' || fm.values.description.trim() === '') {
      bad.push(`${name}: empty description`);
    }
    if (!keySet.has('mode')) {
      bad.push(`${name}: missing mode`);
    } else if (fm.values.mode !== 'primary' && fm.values.mode !== 'subagent') {
      bad.push(`${name}: mode "${String(fm.values.mode)}" is not primary|subagent`);
    }
    for (const key of fm.keys) {
      if (AGENT_FRONTMATTER_KEYS.has(key)) continue;
      if (key === 'mcps' || key === 'skills') {
        bad.push(`${name}: dead field "${key}" on opencode 2.2.6`);
      } else if (key === 'permission') {
        bad.push(`${name}: legacy "permission" map`);
      } else if (key === 'model') {
        bad.push(`${name}: "model" frontmatter (pins belong in opencode.jsonc/profiles)`);
      } else {
        bad.push(`${name}: unsupported field "${key}"`);
      }
    }
  }
  return summarize(bad, `${files.length} agents valid`);
});

check('V2 permission actions are canonical (no legacy bash/task/write/apply_patch)', () => {
  const bad = [];
  let total = 0;
  for (const { label, rules } of permissionSources()) {
    for (const rule of rules) {
      total += 1;
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        bad.push(`${label}: permission entry is not an object`);
        continue;
      }
      const action = rule.action;
      if (typeof action !== 'string' || action.trim() === '') {
        bad.push(`${label}: permission entry without action`);
        continue;
      }
      if (LEGACY_ACTIONS.has(action)) {
        bad.push(`${label}: legacy action "${action}" is a no-op in a V2 array`);
      } else if (!CANONICAL_ACTIONS.has(action) && !TOOL_ACTION_RE.test(action)) {
        bad.push(`${label}: action "${action}" is not canonical`);
      }
    }
  }
  return summarize(bad, `${total} permission rules use canonical actions`);
});

check('every non-wildcard subagent permission resource resolves to agents/<name>.md', () => {
  const bad = [];
  let resolved = 0;
  for (const { label, rules } of permissionSources()) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || rule.action !== 'subagent') continue;
      const resource = rule.resource;
      if (resource === '*') continue;
      if (typeof resource !== 'string' || resource === '') {
        bad.push(`${label}: subagent rule without resource`);
        continue;
      }
      if (!/^[A-Za-z0-9_.-]+$/.test(resource)) {
        bad.push(`${label}: subagent resource "${resource}" is not a plain agent name`);
        continue;
      }
      if (!isFile(path.join(ROOT, 'agents', `${resource}.md`))) {
        bad.push(`${label}: subagent "${resource}" has no agents/${resource}.md`);
        continue;
      }
      resolved += 1;
    }
  }
  return summarize(bad, `${resolved} named subagent resources resolve`);
});

check('every skills/<dir>/SKILL.md exists with matching name and short description', () => {
  const dir = path.join(ROOT, 'skills');
  if (!isDir(dir)) return { ok: false, reason: 'skills/ directory not found' };
  const skillDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !skipDir(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (skillDirs.length === 0) return { ok: true, reason: 'no skill directories' };
  const bad = [];
  for (const name of skillDirs) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!isFile(file)) {
      bad.push(`${name}: missing SKILL.md`);
      continue;
    }
    let fm;
    try {
      fm = parseFrontmatter(readText(file));
    } catch (error) {
      bad.push(`${name}: unreadable SKILL.md (${firstLine(error.message)})`);
      continue;
    }
    if (!fm) {
      bad.push(`${name}: missing or unclosed frontmatter`);
      continue;
    }
    const keySet = new Set(fm.keys);
    if (!keySet.has('name')) {
      bad.push(`${name}: frontmatter missing name`);
    } else if (fm.values.name !== name) {
      bad.push(`${name}: frontmatter name "${String(fm.values.name)}" does not match directory`);
    }
    if (!keySet.has('description')) {
      bad.push(`${name}: frontmatter missing description`);
    } else if (typeof fm.values.description !== 'string') {
      bad.push(`${name}: description is not a string`);
    } else if (fm.values.description.length > SKILL_DESCRIPTION_LIMIT) {
      bad.push(
        `${name}: description ${fm.values.description.length} chars > ${SKILL_DESCRIPTION_LIMIT}`,
      );
    }
  }
  return summarize(bad, `${skillDirs.length} skills valid`);
});

check('ASCII-only across agents/, skills/, AGENTS.md, opencode.jsonc, scripts/*.mjs, plugin-src/**/*.js', () => {
  const targets = [];
  targets.push(...listFiles(path.join(ROOT, 'agents'), true));
  targets.push(...listFiles(path.join(ROOT, 'skills'), true));
  targets.push(...listFiles(path.join(ROOT, 'plugin-src'), true).filter((f) => f.endsWith('.js')));
  const scriptsDir = path.join(ROOT, 'scripts');
  if (isDir(scriptsDir)) {
    targets.push(
      ...fs
        .readdirSync(scriptsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
        .map((entry) => path.join(scriptsDir, entry.name)),
    );
  }
  for (const name of ['AGENTS.md', 'opencode.jsonc']) {
    const file = path.join(ROOT, name);
    if (isFile(file)) targets.push(file);
  }
  const bad = [];
  let checked = 0;
  for (const file of targets) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (error) {
      bad.push(`${rel(file)}: unreadable (${firstLine(error.message)})`);
      continue;
    }
    checked += 1;
    let index = -1;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 0x7f) {
        index = i;
        break;
      }
    }
    if (index === -1) continue;
    let line = 1;
    for (let i = 0; i < index; i += 1) {
      if (buf[i] === 0x0a) line += 1;
    }
    bad.push(`${rel(file)}:${line}`);
  }
  return summarize(bad, `${checked} files ASCII-only`);
});

check(`every .plans/*.md is <= ${PLAN_LOG_LIMIT} bytes`, () => {
  const dir = path.join(ROOT, '.plans');
  if (!isDir(dir)) return { ok: true, reason: 'no .plans/ directory' };
  const files = listFiles(dir, false).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return { ok: true, reason: 'no .plans/*.md files' };
  const bad = [];
  let largest = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    largest = Math.max(largest, size);
    if (size > PLAN_LOG_LIMIT) {
      bad.push(`${rel(file)} is ${size} bytes (limit ${PLAN_LOG_LIMIT})`);
    }
  }
  return summarize(bad, `${files.length} plan logs, largest ${largest} bytes`);
});

check('profile overlays parse and their agents.* pins resolve', () => {
  const overlays = loadOverlays();
  if (overlays.length === 0) return { ok: true, reason: 'no profile overlays' };
  const bad = [];
  for (const overlay of overlays) {
    const label = rel(overlay.file);
    if (overlay.error) {
      bad.push(`${label}: parse error: ${firstLine(overlay.error)}`);
      continue;
    }
    const pins = overlay.config ? overlay.config.agents : undefined;
    if (pins === undefined) continue;
    if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
      bad.push(`${label}: agents is not an object`);
      continue;
    }
    for (const name of Object.keys(pins)) {
      if (BUILTIN_AGENTS.has(name)) continue;
      if (!isFile(path.join(ROOT, 'agents', `${name}.md`))) {
        bad.push(`${label}: agents.${name} has no agents/${name}.md and is not a built-in`);
      }
    }
  }
  return summarize(bad, `${overlays.length} overlays parse and pin resolvable agents`);
});

check('every agents.* model pin is <provider>/<model>[#variant] with a configured provider', () => {
  const cfg = loadBaseConfig().config;
  const pins = cfg ? cfg.agents : undefined;
  if (pins === undefined) return { ok: true, reason: 'no agents.* pins' };
  if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
    return { ok: false, reason: 'agents is not an object' };
  }
  const providers = providerIds(cfg);
  const bad = [];
  let resolved = 0;
  for (const name of Object.keys(pins)) {
    const entry = pins[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      bad.push(`agents.${name} is not an object`);
      continue;
    }
    if (entry.model === undefined) continue; // missing pin is check 11's job
    const parsed = parseModelPin(entry.model);
    if (!parsed) {
      bad.push(
        `agents.${name}.model "${String(entry.model)}" is not <provider>/<model>[#variant]`,
      );
      continue;
    }
    if (!providers.has(parsed.provider)) {
      bad.push(`agents.${name}.model provider "${parsed.provider}" is not a configured provider`);
      continue;
    }
    resolved += 1;
  }
  return summarize(bad, `${resolved} model pins resolve to configured providers`);
});

check('reverse pin check: agents/ files and agents.* pins agree', () => {
  const cfg = loadBaseConfig().config;
  const pins =
    cfg && cfg.agents && typeof cfg.agents === 'object' && !Array.isArray(cfg.agents)
      ? cfg.agents
      : {};
  const pinned = new Set(
    Object.keys(pins).filter((name) => {
      const entry = pins[name];
      return (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof entry.model === 'string' &&
        entry.model.trim() !== ''
      );
    }),
  );
  const files = agentMarkdownFiles().map((file) => path.basename(file, '.md'));
  const fileSet = new Set(files);
  const bad = [];
  for (const name of files) {
    if (BUILTIN_AGENTS.has(name)) continue;
    if (!pinned.has(name)) bad.push(`agents/${name}.md has no agents.${name} model pin`);
  }
  for (const name of Object.keys(pins)) {
    if (BUILTIN_AGENTS.has(name)) continue;
    if (isDisabledPin(pins[name])) continue;
    if (!fileSet.has(name)) bad.push(`agents.${name} pin has no agents/${name}.md`);
  }
  return summarize(bad, `${files.length} agent files, ${pinned.size} model pins agree`);
});

check('every fusion-* reference in agent/skill bodies resolves to a skill or local plugin', () => {
  const skillsDir = path.join(ROOT, 'skills');
  const targets = [...agentMarkdownFiles()];
  if (isDir(skillsDir)) {
    targets.push(...listFiles(skillsDir, true).filter((file) => file.endsWith('.md')));
  }
  // The fusion- prefix is shared by skills and by the local plugin packages
  // (agent and skill bodies name the fusion-channel plugin), so both
  // locations count.
  const REF_RE = /(?<![A-Za-z0-9_-])fusion-[a-z0-9][a-z0-9-]*/g;
  const resolvedNames = new Set();
  const bad = [];
  let refs = 0;
  for (const file of targets) {
    let lines;
    try {
      lines = bodyLines(readText(file));
    } catch (error) {
      bad.push(`${rel(file)}: unreadable (${firstLine(error.message)})`);
      continue;
    }
    for (const { lineNo, text } of lines) {
      const matches = text.match(REF_RE);
      if (!matches) continue;
      for (const raw of matches) {
        const token = raw.replace(/-+$/, '');
        refs += 1;
        if (resolvedNames.has(token)) continue;
        if (
          isFile(path.join(skillsDir, token, 'SKILL.md')) ||
          isDir(path.join(ROOT, 'plugin-src', token))
        ) {
          resolvedNames.add(token);
          continue;
        }
        bad.push(`${rel(file)}:${lineNo}: "${token}" has no skills/${token}/SKILL.md`);
      }
    }
  }
  return summarize(
    bad,
    `${targets.length} files, ${refs} references across ${resolvedNames.size} names resolve`,
  );
});

check('MCP tool permission actions resolve to a configured MCP server', () => {
  const cfg = loadBaseConfig().config;
  const servers = mcpServerIds(cfg);
  const bad = [];
  let checked = 0;
  for (const { label, rules } of permissionSources()) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
      const action = rule.action;
      if (typeof action !== 'string' || CANONICAL_ACTIONS.has(action)) continue;
      const prefix = /^([a-z0-9-]+)_/.exec(action);
      if (!prefix) continue;
      checked += 1;
      if (!servers.has(prefix[1])) {
        bad.push(`${label}: action "${action}" has no configured mcp server "${prefix[1]}"`);
      }
    }
  }
  return summarize(bad, `${checked} tool actions resolve to ${servers.size} MCP servers`);
});

// Shell permission matching for the last-match simulation. opencode evaluates
// permissions findLast: the last rule whose resource pattern matches decides.
// `*` matches any run of characters, including none. Samples below drive the
// guarded git write surface end to end, not just the rule spelling.
function shellPatternMatches(pattern, command) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '[\\s\\S]*';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(command);
}

function shellDecision(shellRules, command) {
  let decision = null;
  for (const rule of shellRules) {
    if (typeof rule.resource !== 'string') continue;
    if (!shellPatternMatches(rule.resource, command)) continue;
    decision = rule.effect;
  }
  return decision;
}

// Capability discovery, not a roster: agent name, mode, and shell rules all
// come from agents/*.md. An agent with no shell rules carries no git surface
// to guard (it inherits the profile default, already deny/ask).
function agentShellSurfaces() {
  return agentMarkdownFiles().map((file) => {
    const name = path.basename(file, '.md');
    const fm = agentFrontmatter(file);
    const rules = fm && Array.isArray(fm.permissions) ? fm.permissions : [];
    const shellRules = rules.filter(
      (rule) => rule && typeof rule === 'object' && rule.action === 'shell',
    );
    return {
      name,
      mode: fm && fm.values ? fm.values.mode : undefined,
      shellRules,
      blanketAllow: shellRules.some(
        (rule) => rule.resource === '*' && rule.effect === 'allow',
      ),
    };
  });
}

// The committer is whichever agent's own findLast order allows both a commit
// and a push. Renaming or replacing that file needs no edit here; zero or two
// matches fail the committer check below.
const COMMIT_SAMPLE = 'git commit -m x';
const PUSH_SAMPLE = 'git push origin main';

function isCommitter(surface) {
  return (
    shellDecision(surface.shellRules, COMMIT_SAMPLE) === 'allow' &&
    shellDecision(surface.shellRules, PUSH_SAMPLE) === 'allow'
  );
}

// The contract for the committer role, proven through the discovered agent's
// own patterns: the safe forms allow, every escape hatch denies. This is a
// sample set, not a spelling whitelist, so an equally safe rule set passes.
const COMMITTER_GIT_SAMPLES = [
  { command: 'git commit -m x', effect: 'allow' },
  { command: 'git push origin main', effect: 'allow' },
  { command: 'git push --force origin main', effect: 'deny' },
  { command: 'git push -f origin main', effect: 'deny' },
  { command: 'git push --mirror origin', effect: 'deny' },
  { command: 'git push --delete origin b', effect: 'deny' },
  { command: 'git push origin +main', effect: 'deny' },
  { command: 'git push origin :b', effect: 'deny' },
  { command: 'git push -uf origin main', effect: 'deny' },
  { command: 'git push -fu origin main', effect: 'deny' },
  { command: 'git push --no-verify origin main', effect: 'deny' },
  { command: 'git commit --amend -m x', effect: 'deny' },
  { command: 'git commit --no-verify -m x', effect: 'deny' },
  { command: 'git -C . commit -m x', effect: 'deny' },
  { command: 'git -C . push origin main', effect: 'deny' },
  { command: 'git -c user.name=x commit -m x', effect: 'deny' },
  { command: 'git -c user.name=x push origin main', effect: 'deny' },
  { command: 'git --git-dir=.git commit -m x', effect: 'deny' },
  { command: 'git --git-dir=.git push origin main', effect: 'deny' },
  { command: 'sh -c "git push"', effect: 'deny' },
  { command: 'bash -c "git push"', effect: 'deny' },
  // Worktree create/remove/prune belongs to a primary; the committer never
  // creates, removes, or prunes one.
  { command: 'git worktree add ../wt', effect: 'deny' },
  { command: 'git worktree remove ../wt', effect: 'deny' },
  { command: 'git worktree prune', effect: 'deny' },
];

// A primary decides when and what to commit, never executes: every git write
// verb must resolve to deny under its own findLast order.
const PRIMARY_GIT_DENY_SAMPLES = [
  'git add -A',
  'git commit -m x',
  'git push origin main',
  'git merge x',
  'git cherry-pick abc123',
  'git revert abc123',
];

// Worktree create/remove/prune is primary-only. Every non-primary agent that
// carries shell rules must deny it.
const WORKTREE_WRITE_SAMPLES = [
  'git worktree add ../wt',
  'git worktree remove ../wt',
  'git worktree prune',
];

// This script's own source, scanned for agent-name literals: capabilities and
// data files decide behavior, so a roster name in code is a bug. Opencode's
// builtin ids are the allowed exception (BUILTIN_AGENTS); they cannot appear
// here because surfaces come from agents/*.md, but the skip is explicit.
const SCRIPT_TEXT = readText(path.join(HERE, 'validate-config.mjs'));

function hardcodedAgentName(surface) {
  if (BUILTIN_AGENTS.has(surface.name)) return false;
  const escaped = surface.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(SCRIPT_TEXT);
}

check('one committer is discovered by capability; every other agent denies git writes', () => {
  const bad = [];
  const surfaces = agentShellSurfaces();
  const committers = surfaces.filter(isCommitter).map((surface) => surface.name);
  let committer = null;
  if (committers.length === 1) {
    committer = committers[0];
  } else {
    const list = committers.length === 0 ? 'none' : committers.sort().join(', ');
    bad.push(
      `${committers.length} agents allow both "${COMMIT_SAMPLE}" and "${PUSH_SAMPLE}" (${list}); expected exactly one committer`,
    );
  }

  for (const surface of surfaces) {
    if (surface.name === committer) continue;
    for (const command of [COMMIT_SAMPLE, PUSH_SAMPLE]) {
      const actual = shellDecision(surface.shellRules, command);
      if (actual === 'allow') {
        bad.push(
          `agents/${surface.name}.md: "${command}" resolves allow; only the committer may` +
            (committer ? ` (committer: ${committer})` : ''),
        );
      }
    }
  }

  for (const surface of surfaces) {
    if (surface.mode === 'primary') {
      for (const command of PRIMARY_GIT_DENY_SAMPLES) {
        const actual = shellDecision(surface.shellRules, command);
        if (actual !== 'deny') {
          bad.push(
            `agents/${surface.name}.md: primary "${command}" resolves ${actual ?? 'unmatched'}, expected deny`,
          );
        }
      }
      continue;
    }
    if (surface.shellRules.length === 0) continue;
    for (const command of WORKTREE_WRITE_SAMPLES) {
      const actual = shellDecision(surface.shellRules, command);
      if (actual !== 'deny') {
        bad.push(
          `agents/${surface.name}.md: non-primary "${command}" resolves ${actual ?? 'unmatched'}, expected deny`,
        );
      }
    }
  }

  // A blanket shell allow is a wide surface. Unless the agent is the
  // discovered committer it must explicitly deny commit and push; this is a
  // capability rule, not a name whitelist.
  for (const surface of surfaces) {
    if (!surface.blanketAllow || surface.name === committer) continue;
    for (const command of [COMMIT_SAMPLE, PUSH_SAMPLE]) {
      const actual = shellDecision(surface.shellRules, command);
      if (actual !== 'deny') {
        bad.push(
          `agents/${surface.name}.md: blanket shell allow requires "${command}" to deny (resolves ${actual ?? 'unmatched'})`,
        );
      }
    }
  }

  for (const surface of surfaces) {
    if (hardcodedAgentName(surface)) {
      bad.push(
        `validate-config.mjs: hardcodes agent name "${surface.name}"; discover agents from agents/*.md instead`,
      );
    }
  }

  if (bad.length === 0) {
    return {
      ok: true,
      reason: `committer "${committer}" discovered; ${surfaces.length} agent surfaces deny git writes outside it`,
    };
  }
  return summarize(bad);
});

check('the discovered committer: commit/push allow, force/amend/worktree escapes deny', () => {
  const surfaces = agentShellSurfaces();
  const committers = surfaces.filter(isCommitter).map((surface) => surface.name);
  if (committers.length !== 1) {
    const list = committers.length === 0 ? 'none' : committers.sort().join(', ');
    return {
      ok: false,
      reason: `${committers.length} committers (${list}); the committer samples need exactly one`,
    };
  }
  const committer = surfaces.find((surface) => surface.name === committers[0]);
  const bad = [];
  for (const { command, effect } of COMMITTER_GIT_SAMPLES) {
    const actual = shellDecision(committer.shellRules, command);
    if (actual !== effect) {
      bad.push(
        `agents/${committer.name}.md: "${command}" resolves ${actual ?? 'unmatched'}, expected ${effect}`,
      );
    }
  }
  return summarize(
    bad,
    `committer "${committer.name}" passes ${COMMITTER_GIT_SAMPLES.length} git samples`,
  );
});

check('profile tiers.json validates, providers/variants resolve, and overlays match', () => {
  const profiles = listTierProfiles(ROOT);
  if (profiles.length === 0) return { ok: true, reason: 'no tier files' };
  const cfg = loadBaseConfig().config;
  const providers = providerIds(cfg);
  const variants = declaredVariants(cfg);
  const agentNames = agentMarkdownFiles().map((file) => path.basename(file, '.md'));
  const bad = [];
  let pins = 0;
  for (const name of profiles) {
    const tiersFile = path.join(ROOT, 'profiles', name, 'tiers.json');
    let data;
    try {
      data = JSON.parse(readText(tiersFile));
    } catch (error) {
      bad.push(`${rel(tiersFile)}: not valid JSON (${firstLine(error.message)})`);
      continue;
    }
    const shapeErrors = validateTiersData(data, agentNames);
    if (shapeErrors.length > 0) {
      for (const error of shapeErrors) bad.push(`${rel(tiersFile)}: ${error}`);
      continue;
    }
    for (const tier of Object.keys(data.tiers)) {
      const model = data.tiers[tier].model;
      // An empty model makes the tier unavailable in this profile; shape
      // validation already guarantees no agent maps to it, so there is no
      // provider/model/variant pin to resolve.
      if (typeof model === 'string' && model.trim() === '') continue;
      const parsed = parseModelRef(model);
      if (!parsed) continue; // shape validation already reported it
      if (!providers.has(parsed.provider)) {
        bad.push(
          `${rel(tiersFile)}: tier "${tier}" provider "${parsed.provider}" is not a configured provider`,
        );
        continue;
      }
      // A referenced #variant must exist when the model declares variants in
      // opencode.jsonc; models with no variants array are not constrained.
      const declared = variants.get(parsed.provider);
      const ids = declared ? declared.get(parsed.model) : undefined;
      if (parsed.variant !== null && ids && !ids.has(parsed.variant)) {
        bad.push(
          `${rel(tiersFile)}: tier "${tier}" variant "#${parsed.variant}" is not declared for ` +
            `${parsed.provider}/${parsed.model} (declared: ${[...ids].join(', ') || 'none'})`,
        );
      }
    }
    const overlayFile = path.join(ROOT, 'profiles', name, 'opencode.jsonc');
    let overlayConfig;
    try {
      overlayConfig = parseJsonc(readText(overlayFile));
    } catch (error) {
      bad.push(`${rel(overlayFile)}: parse error: ${firstLine(error.message)}`);
      continue;
    }
    const drifts = diffOverlay(buildExpansion(data), overlayConfig);
    for (const drift of drifts) bad.push(`${rel(overlayFile)}: ${drift}`);
    if (drifts.length === 0) pins += Object.keys(data.agents).length;
  }
  return summarize(
    bad,
    `${profiles.length} tier profiles validate, ${pins} agent pins match their generated overlays`,
  );
});

check('default_agent resolves to agents/<name>.md and exactly one agent is primary', () => {
  const cfg = loadBaseConfig().config;
  const bad = [];
  const defaultAgent = cfg ? cfg.default_agent : undefined;
  if (typeof defaultAgent !== 'string' || defaultAgent.trim() === '') {
    bad.push('opencode.jsonc: default_agent is not a non-empty string');
  } else {
    const name = defaultAgent.trim();
    if (!isFile(path.join(ROOT, 'agents', `${name}.md`))) {
      bad.push(`opencode.jsonc: default_agent "${name}" has no agents/${name}.md`);
    }
    const pins =
      cfg && cfg.agents && typeof cfg.agents === 'object' && !Array.isArray(cfg.agents)
        ? cfg.agents
        : {};
    if (isDisabledPin(pins[name])) {
      bad.push(`opencode.jsonc: default_agent "${name}" is disabled (agents.${name}.disabled: true)`);
    }
  }
  const primaries = [];
  for (const file of agentMarkdownFiles()) {
    const fm = agentFrontmatter(file);
    if (fm && fm.values.mode === 'primary') primaries.push(path.basename(file, '.md'));
  }
  if (primaries.length !== 1) {
    const list = primaries.length === 0 ? '' : ` (${primaries.sort().join(', ')})`;
    bad.push(`${primaries.length} agents/*.md files declare mode: primary${list}`);
  }
  return summarize(bad, `default_agent "${String(defaultAgent)}" and one primary agent agree`);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let rootStat;
try {
  rootStat = fs.statSync(ROOT);
} catch {
  console.error(`validate-config: root directory not found: ${ROOT}`);
  process.exit(2);
}
if (!rootStat.isDirectory()) {
  console.error(`validate-config: not a directory: ${ROOT}`);
  process.exit(2);
}

console.log(`validate-config: root ${ROOT}`);

let failures = 0;
checks.forEach((entry, index) => {
  let result;
  try {
    result = entry.fn();
  } catch (error) {
    result = { ok: false, reason: firstLine(error && error.message ? error.message : error) };
  }
  if (!result || typeof result.ok !== 'boolean') {
    result = { ok: false, reason: 'check returned no result' };
  }
  if (!result.ok) failures += 1;
  const label = `${index + 1}. ${entry.name}`;
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label}${result.reason ? `: ${result.reason}` : ''}`);
});

console.log(`${checks.length} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
