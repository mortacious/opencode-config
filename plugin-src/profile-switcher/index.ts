// profile-switcher: OpenCode v2 server plugin (plugin id "profile-switcher").
//
// In-session profile switching with hot-swapped agent models - no service
// restart. Profiles stay declarative overlay files under
// profiles/<name>/opencode.jsonc; this plugin applies the MODEL SUBSET of an
// overlay as live runtime transforms:
//   - An agent model transform owned by this plugin applies a CAPTURED
//     per-agent model map. Transforms run in registration order over a shared
//     editor, and the core config-agent plugin registers its own model
//     transform only AFTER plugin setup, so applyProfile() disposes the
//     previous registration and registers a fresh one each time (Set
//     re-insertion appends it): the profile transform always runs last and
//     wins. For "default" the captured map is the BASE refs captured at
//     setup, restoring base models explicitly.
//   - applyProfile(name) reads profiles/<name>/opencode.jsonc (JSONC: full-line
//     // comments, /* */ blocks, trailing commas - never throws), maps
//     agents.<id>.model (+optional variant) and small_model -> the built-in
//     "title" agent, warns "not hot-swappable: <key>" for any other top-level
//     key, re-resolves each target against an availability snapshot, updates
//     the captured map, re-registers the agent transform, writes
//     .active-profile and emits the
//     "changed" RPC event.
//   - Availability + fallback: every target is checked against a snapshot Set
//     of "providerID/modelID" from ctx.model.list(). Exact-match miss with a
//     modelFallbacks hit substitutes the fallback (applied: fallback:true);
//     a miss without fallback warns and leaves the agent unchanged.
//   - provider.updated / model.updated events (ctx.event.subscribe) refresh the
//     snapshot and re-run applyProfile for the current active profile -
//     debounced ~2s, and ONLY when the re-resolved outcome differs from what
//     is applied. Skipped entirely when the active profile came from launch
//     detection.
//
// State sharing: CONFIG_DIR/.active-profile (single line, name or
// absent/"default") is the SAME file bin/oc reads and writes, so the bash
// launcher and this plugin stay in sync. The file is never rewritten at
// setup; only rpc set() persists.
//
// Launch detection: when the service was started by bin/oc,
// OPENCODE_CONFIG points at CONFIG_DIR/profiles/<name>/opencode.jsonc - the
// overlay is already merged into the base config, so runtimeActive = <name>
// and NO transforms are applied (and no state file is read or written).
//
// Logging: console.log AND appendFileSync to
// ~/.local/state/profile-switcher/profile-switcher.log (JSONL, lazy mkdir,
// never-throw) - mirrors the lumo-supervisor log() pattern. Never logs key
// material (this plugin never reads keys).
//
// Options (ctx.options): profilesDir (default CONFIG_DIR/profiles), modelFallbacks
// (default { "lumo-tamer/lumo-max": "Amenable Thor 1/qwen38-flash-next" }).
//
// Agent model contract (verified against the installed @opencode/plugin
// typings): Agent.Info.model is a STRUCTURED Model.Ref
// ({ id, providerID, variant? }) - not a "provider/model#variant" string - so
// the transform assigns Model.Ref.parse(ref) output verbatim.
//
// All files ASCII only.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Model, Plugin } from "@opencode/plugin";

import { readProfileFile, type ProfileModelEntry } from "./parse.js";
import {
  Profile,
  type ProfileAppliedEntry,
  type ProfileListEntry,
  type ProfileSetResult,
} from "./rpc.js";

const SERVICE = "profile-switcher";

// CONFIG_DIR from import.meta.url: this file lives at
// <CONFIG_DIR>/plugin-src/profile-switcher/index.ts, so ../.. is CONFIG_DIR -
// the same "script dir -> parent" walk bin/oc does with readlink -f.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(PLUGIN_DIR, "..", "..");

const DEFAULT_PROFILES_DIR = join(CONFIG_DIR, "profiles");
// Shared single-line state file with bin/oc (bin/oc: ACTIVE_FILE).
const ACTIVE_FILE = join(CONFIG_DIR, ".active-profile");

const STATE_DIR = join(homedir(), ".local", "state", SERVICE);
const LOG_FILE = join(STATE_DIR, SERVICE + ".log");

const DEFAULT_MODEL_FALLBACKS: Readonly<Record<string, string>> = {
  "lumo-tamer/lumo-max": "Amenable Thor 1/qwen38-flash-next",
};

// Debounce for provider.updated / model.updated re-evaluation.
const REEVAL_DEBOUNCE_MS = 2000;

// One-shot delay before re-asserting the active profile after setup, once the
// core config-agent transform has registered (see the initial-application
// block in setup()).
const SETTLE_DELAY_MS = 4000;

// Last directory successfully created for LOG_FILE (lazy mkdir, mirrors
// lumo-supervisor's logDirReady).
let logDirReady = false;

// Structured logging: console AND appended JSONL line in LOG_FILE with fields
// {ts, service, level, message, ...extra} - the established lumo-supervisor
// pattern. Never throws, never prints key material.
function log(
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      service: SERVICE,
      level,
      message,
      ...(extra ?? {}),
    });
  } catch {
    return;
  }
  try {
    console.log(line);
  } catch {
    // logging must never break setup or cleanup
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  if (!logDirReady) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      logDirReady = true;
    } catch {
      // best-effort only
    }
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // still failing - give up silently
  }
}

function expandTilde(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return target;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Profile names come from rpc set() input and .active-profile: a single path
// segment, never a traversal.
function isSafeProfileName(name: string): boolean {
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes(sep)) return false;
  return true;
}

// Launched-profile detection: bin/oc exports
// OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/opencode.jsonc. Detected under
// CONFIG_DIR/profiles (the path bin/oc hardcodes as PROFILES_DIR), regardless
// of the profilesDir option.
function detectLaunchedProfile(): string | undefined {
  const raw = process.env.OPENCODE_CONFIG;
  if (!raw) return undefined;
  let target: string;
  try {
    target = resolve(expandTilde(raw));
  } catch {
    return undefined;
  }
  const prefix = join(CONFIG_DIR, "profiles") + sep;
  if (!target.startsWith(prefix)) return undefined;
  const parts = target.slice(prefix.length).split(sep);
  if (parts.length !== 2 || parts[1] !== "opencode.jsonc") return undefined;
  if (!isSafeProfileName(parts[0])) return undefined;
  return parts[0];
}

// Reads the shared .active-profile state file. Missing/empty -> "default"
// (no warning - the absent file is the normal default state). An unknown or
// invalid name warns and falls back to "default" WITHOUT rewriting the file
// (never rewrite at setup - bin/oc owns the file too).
function readActiveState(profilesDir: string): {
  name: string;
  warning?: string;
} {
  let rawText: string;
  try {
    rawText = readFileSync(ACTIVE_FILE, "utf8").trim();
  } catch {
    return { name: "default" };
  }
  if (!rawText) return { name: "default" };
  if (rawText === "default") return { name: "default" };
  if (!isSafeProfileName(rawText)) {
    return {
      name: "default",
      warning:
        "invalid profile name in .active-profile: " +
        JSON.stringify(rawText) +
        "; using default (file left unchanged)",
    };
  }
  if (existsSync(join(profilesDir, rawText, "opencode.jsonc"))) {
    return { name: rawText };
  }
  return {
    name: "default",
    warning:
      'unknown profile "' +
      rawText +
      '" in .active-profile; using default (file left unchanged)',
  };
}

function readFallbacks(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return { ...DEFAULT_MODEL_FALLBACKS };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [key, target] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (typeof target === "string" && target) out[key] = target;
    }
    return out;
  }
  log("warn", "modelFallbacks option is not an object; using defaults", {
    received: typeof value,
  });
  return { ...DEFAULT_MODEL_FALLBACKS };
}

// One entry of the outcome that is "currently applied": the resolved model
// map (agent -> final ref) plus parallel applied[]/warnings for RPC results.
interface Resolution {
  map: Map<string, string>;
  applied: ProfileAppliedEntry[];
  warnings: string[];
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export default Plugin.define({
  id: "profile-switcher",
  async setup(ctx) {
    const raw = (ctx.options ?? {}) as Record<string, unknown>;
    const profilesDir = resolve(
      expandTilde(
        typeof raw.profilesDir === "string" && raw.profilesDir
          ? raw.profilesDir
          : DEFAULT_PROFILES_DIR
      )
    );
    const modelFallbacks = readFallbacks(raw.modelFallbacks);

    log("info", "setup (load/reload)", {
      configDir: CONFIG_DIR,
      profilesDir,
      fallbackKeys: Object.keys(modelFallbacks),
    });

    // ---- active profile resolution -------------------------------------
    let activeName = "default";
    // True only while the active profile came from launch detection: the base
    // config already carries that overlay, so no transforms and no event
    // re-evaluation. Cleared by a successful rpc set().
    let launchSuppressed = false;
    const launched = detectLaunchedProfile();
    if (launched !== undefined) {
      activeName = launched;
      launchSuppressed = true;
      log(
        "info",
        "launched under a profile overlay via OPENCODE_CONFIG; base config owns models - skipping transforms, state file untouched",
        { active: activeName }
      );
    } else {
      const state = readActiveState(profilesDir);
      activeName = state.name;
      if (state.warning) log("warn", state.warning, { active: activeName });
    }

    // ---- captured state -------------------------------------------------
    // Availability snapshot: "providerID/modelID" set from ctx.model.list().
    let availability = new Set<string>();
    // Captured per-agent model map applied by the current transform.
    let captured = new Map<string, string>();
    // Base per-agent model refs captured once BEFORE any profile transform is
    // registered; "default" restores these explicitly. Best-effort: an
    // early/partial registry captures fewer entries and the core config-agent
    // transform still supplies base models for anything not captured here.
    const baseModels = new Map<string, string>();

    async function captureBaseModels(): Promise<void> {
      try {
        const res = await ctx.agent.list();
        for (const agent of res.data) {
          const model = agent.model;
          if (!model) continue;
          baseModels.set(
            agent.id,
            model.providerID +
              "/" +
              model.id +
              (model.variant ? "#" + model.variant : "")
          );
        }
      } catch (err) {
        log("warn", "failed to capture base agent models", {
          error: errorText(err),
        });
      }
    }

    // The map a given profile should end up applying: the resolved overlay
    // targets, or the captured base refs for "default".
    function targetMap(
      name: string,
      resolvedMap: Map<string, string>
    ): Map<string, string> {
      return name === "default" ? new Map(baseModels) : resolvedMap;
    }

    let cleanedUp = false;
    let emitChanged: ((active: string) => Promise<void>) | undefined;
    let disposeRpc: (() => Promise<void>) | undefined;
    let reevalTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    async function refreshAvailability(): Promise<void> {
      try {
        const res = await ctx.model.list();
        availability = new Set(
          res.data.map((model) => model.providerID + "/" + model.modelID)
        );
      } catch (err) {
        log("warn", "failed to refresh model availability snapshot", {
          error: errorText(err),
        });
      }
    }

    // Resolve parsed targets against the current snapshot + fallback map.
    // Never throws: invalid refs are dropped with a warning.
    function resolveTargets(entries: ProfileModelEntry[]): Resolution {
      const map = new Map<string, string>();
      const applied: ProfileAppliedEntry[] = [];
      const warnings: string[] = [];
      for (const entry of entries) {
        const base = entry.ref.split("#")[0];
        let finalRef = entry.ref;
        let isFallback = false;
        if (!availability.has(base)) {
          const fallback = modelFallbacks[base];
          if (fallback) {
            finalRef = fallback;
            isFallback = true;
          } else {
            warnings.push(
              "model unavailable (no fallback): " +
                base +
                ' for agent "' +
                entry.agent +
                '"; agent left unchanged'
            );
            continue;
          }
        }
        try {
          Model.Ref.parse(finalRef);
        } catch {
          warnings.push(
            'invalid model reference for agent "' +
              entry.agent +
              '": ' +
              finalRef
          );
          continue;
        }
        map.set(entry.agent, finalRef);
        applied.push({
          agent: entry.agent,
          model: finalRef,
          fallback: isFallback,
        });
      }
      return { map, applied, warnings };
    }

    // The full apply sequence: refresh availability, read+parse the overlay,
    // resolve, update the captured map, re-register the agent transform,
    // write .active-profile, emit "changed". Never throws.
    async function applyProfile(
      name: string,
      opts: { persist: boolean; emit: boolean }
    ): Promise<ProfileSetResult> {
      await refreshAvailability();
      const parsed = readProfileFile(
        join(profilesDir, name, "opencode.jsonc")
      );
      const resolved = resolveTargets(parsed.entries);
      captured = targetMap(name, resolved.map);
      const warnings = [...parsed.warnings, ...resolved.warnings];
      for (const warning of warnings) {
        log("warn", warning, { profile: name });
      }
      try {
        // Re-register so our transform is last in the shared editor pipeline
        // (see registerAgentTransform). Registration invalidates the agent
        // state, and the registry rebuilds - replaying every transform onto a
        // fresh base value - on the next read, so no explicit reload() is
        // needed; calling it would only repeat that rebuild.
        await registerAgentTransform();
      } catch (err) {
        log("warn", "agent transform registration failed", {
          error: errorText(err),
        });
      }
      activeName = name;
      if (opts.persist) {
        try {
          // bin/oc-consistent state: absence IS the default. Writing the
          // literal "default" would also work, but removing the marker keeps
          // the file's meaning single-valued ("a non-default profile is
          // active") and matches the absent baseline bin/oc already treats
          // as default.
          if (name === "default") {
            rmSync(ACTIVE_FILE, { force: true });
          } else {
            writeFileSync(ACTIVE_FILE, name + "\n", "utf8");
          }
        } catch (err) {
          log("warn", "failed to write .active-profile", {
            error: errorText(err),
          });
        }
      }
      if (opts.emit && emitChanged) {
        try {
          await emitChanged(name);
        } catch (err) {
          log("warn", "failed to emit changed event", {
            error: errorText(err),
          });
        }
      }
      log("info", "profile applied", {
        active: name,
        applied: resolved.applied.length,
        warnings: warnings.length,
        persist: opts.persist,
      });
      return {
        active: name,
        applied: resolved.applied,
        warnings,
      };
    }

    // Cross-instance convergence: the agent registry is per LOCATION, and an
    // rpc set() reaches only the instance serving the caller's location. Every
    // instance subscribes to this plugin's "changed" event and re-applies the
    // named profile locally, so all loaded locations converge. Never emits
    // (no loop) and never persists (the setter already wrote the state file).
    async function convergeTo(next: string): Promise<void> {
      try {
        await refreshAvailability();
        const parsed = readProfileFile(
          join(profilesDir, next, "opencode.jsonc")
        );
        const resolved = resolveTargets(parsed.entries);
        if (
          next === activeName &&
          mapsEqual(targetMap(next, resolved.map), captured)
        ) {
          return;
        }
        launchSuppressed = false;
        await applyProfile(next, { persist: false, emit: false });
        log("info", "converged to active profile from another instance", {
          active: next,
        });
      } catch (err) {
        log("warn", "convergence apply failed", {
          profile: next,
          error: errorText(err),
        });
      }
    }

    // Provider/model event re-evaluation: refresh the snapshot, re-resolve
    // the active profile, and re-run the full apply ONLY when the re-resolved
    // outcome differs from what is currently applied.
    async function reevaluate(): Promise<void> {
      if (cleanedUp || launchSuppressed) return;
      try {
        await refreshAvailability();
        const parsed = readProfileFile(
          join(profilesDir, activeName, "opencode.jsonc")
        );
        const resolved = resolveTargets(parsed.entries);
        if (mapsEqual(targetMap(activeName, resolved.map), captured)) {
          log(
            "info",
            "provider/model change: re-resolved outcome unchanged; skipping",
            { active: activeName }
          );
          return;
        }
        log("info", "provider/model change: re-applying profile", {
          active: activeName,
        });
        await applyProfile(activeName, { persist: true, emit: true });
      } catch (err) {
        log("warn", "re-evaluation failed", { error: errorText(err) });
      }
    }

    // ---- agent transform registration ----------------------------------
    // Transforms run in registration order over a shared editor. The core
    // config-agent plugin registers its own model transform only AFTER
    // plugin setup (it awaits its config documents), so a transform
    // registered once here would run before it and be overwritten by it.
    // applyProfile() therefore disposes the previous registration and
    // registers a fresh one: Set re-insertion appends it, so the newest
    // (profile) transform always runs last and wins.
    let agentRegistration: { dispose: () => Promise<void> } | undefined;

    async function registerAgentTransform(): Promise<void> {
      if (agentRegistration) {
        try {
          await agentRegistration.dispose();
        } catch (err) {
          log("warn", "failed to dispose previous agent transform", {
            error: errorText(err),
          });
        }
        agentRegistration = undefined;
      }
      agentRegistration = await ctx.agent.transform((editor) => {
        for (const [agent, ref] of captured) {
          if (!editor.get(agent)) continue;
          try {
            const parsed = Model.Ref.parse(ref);
            editor.update(agent, (info) => {
              info.model = parsed;
            });
          } catch (err) {
            // refs are validated at resolve time; never break the transform
            log("warn", "transform skipped an entry", {
              agent,
              error: errorText(err),
            });
          }
        }
      });
    }

    // ---- initial application (never persists, never emits) -------------
    if (!launchSuppressed) {
      // Capture base refs BEFORE the first transform/apply so "default" can
      // restore them.
      await captureBaseModels();
      await applyProfile(activeName, { persist: false, emit: false });
      // The core config-agent transform registers only after plugin setup, so
      // a profile active at startup would be overwritten until the pipeline
      // settles. One idempotent re-register afterward keeps ours last.
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (cleanedUp || captured.size === 0) return;
        void (async () => {
          try {
            await registerAgentTransform();
            log("info", "settle re-apply after config pipeline", {
              active: activeName,
            });
          } catch (err) {
            log("warn", "settle re-apply failed", { error: errorText(err) });
          }
        })();
      }, SETTLE_DELAY_MS);
    }

    // ---- rpc registration ----------------------------------------------
    const rpcRegistration = await ctx.rpc.register(Profile, {
      list: async () => {
        const profiles: ProfileListEntry[] = [];
        try {
          for (const dirent of readdirSync(profilesDir, { withFileTypes: true })) {
            if (!dirent.isDirectory()) continue;
            const file = join(profilesDir, dirent.name, "opencode.jsonc");
            if (existsSync(file)) {
              profiles.push({ name: dirent.name, file });
            }
          }
        } catch (err) {
          log("warn", "failed to list profiles", { error: errorText(err) });
        }
        profiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { active: activeName, profiles };
      },
      current: async () => ({ active: activeName }),
      set: async (input, context) => {
        const name = (input as { name?: unknown } | undefined)?.name;
        if (typeof name !== "string" || !isSafeProfileName(name)) {
          return context.error(
            "unknown_profile",
            "invalid profile name: " + String(name),
            { name: String(name) }
          );
        }
        if (!existsSync(join(profilesDir, name, "opencode.jsonc"))) {
          return context.error(
            "unknown_profile",
            "unknown profile: " + name,
            { name }
          );
        }
        const result = await applyProfile(name, { persist: true, emit: true });
        // runtimeActive now came from this set, not from launch detection.
        launchSuppressed = false;
        return result;
      },
    });
    emitChanged = async (active: string) => {
      await rpcRegistration.events.emit("changed", { active });
    };
    disposeRpc = () => rpcRegistration.dispose();

    // ---- provider/model event subscription (debounced) -----------------
    const controller = new AbortController();
    const eventStream = ctx.event.subscribe({ signal: controller.signal });
    (async () => {
      try {
        for await (const event of eventStream) {
          if (!event) continue;
          // Cross-instance convergence: the agent registry is per LOCATION and
          // an rpc set() reaches only the serving instance, so re-apply the
          // broadcast profile locally (see convergeTo).
          if (event.type === "rpc.profile.changed") {
            const data = (event as { data?: { active?: unknown } }).data;
            const next =
              typeof data?.active === "string" ? data.active : undefined;
            if (next && isSafeProfileName(next) && !cleanedUp) {
              void convergeTo(next);
            }
            continue;
          }
          if (
            event.type !== "provider.updated" &&
            event.type !== "model.updated"
          ) {
            continue;
          }
          if (cleanedUp) break;
          if (reevalTimer) clearTimeout(reevalTimer);
          reevalTimer = setTimeout(() => {
            reevalTimer = undefined;
            void reevaluate();
          }, REEVAL_DEBOUNCE_MS);
        }
      } catch (err) {
        if (!cleanedUp) {
          log("warn", "event stream ended", { error: errorText(err) });
        }
      }
    })();

    // ---- cleanup (always safe, idempotent) -----------------------------
    return async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (reevalTimer) {
        clearTimeout(reevalTimer);
        reevalTimer = undefined;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      try {
        controller.abort();
      } catch {
        // best-effort only
      }
      if (agentRegistration) {
        try {
          await agentRegistration.dispose();
        } catch (err) {
          log("warn", "failed to dispose agent transform", {
            error: errorText(err),
          });
        }
        agentRegistration = undefined;
      }
      if (disposeRpc) {
        try {
          await disposeRpc();
        } catch (err) {
          log("warn", "failed to dispose rpc registration", {
            error: errorText(err),
          });
        }
      }
      log("info", "cleanup: plugin unloaded", { active: activeName });
    };
  },
});
