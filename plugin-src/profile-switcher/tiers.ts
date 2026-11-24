// profile-switcher: switch-time tier sync.
//
// A tier-managed profile (profiles/<name>/tiers.json) has a GENERATED overlay:
// scripts/tiers-sync.mjs renders profiles/<name>/opencode.jsonc from the
// authored {tiers, agents} mapping. A profile switch and a plain/OC_PROFILE
// launch must run that sync first, so the overlay they apply is never stale.
// The sync is skipped for profiles with no tiers.json (legacy hand-written
// overlays). A switch refuses on failure (the caller persists nothing); a
// launch logs and applies the existing overlay because setup cannot abort it.
// Either way it runs BEFORE anything is persisted or applied.
//
// Cost: one dynamic import of a dependency-free ESM script (cached after the
// first switch) plus synchronous file IO - no child process, no event-loop
// blocking beyond that.
//
// Kept free of plugin imports so a plain-node test can import it directly.
//
// All files ASCII only.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface TiersSyncOutcome {
  // False when tiers-sync rejected the profile or could not write the overlay.
  ok: boolean;
  // tiers-sync's success line, or its error message when ok is false.
  output: string;
}

// The subset of scripts/tiers-sync.mjs this module calls.
interface TiersSyncModule {
  syncProfile(
    rootDir: string,
    name: string
  ): { name: string; file: string; changed: boolean };
}

export interface TiersSyncOptions {
  // CONFIG_DIR: owns scripts/tiers-sync.mjs, profiles/, and agents/ - the
  // root layout tiers-sync expands.
  configDir: string;
  // Profile name (already validated by the caller).
  profile: string;
}

export async function syncProfileTiers(
  opts: TiersSyncOptions
): Promise<TiersSyncOutcome> {
  const tiersFile = join(
    opts.configDir,
    "profiles",
    opts.profile,
    "tiers.json"
  );
  if (!existsSync(tiersFile)) {
    return { ok: true, output: "" };
  }
  const script = join(opts.configDir, "scripts", "tiers-sync.mjs");
  try {
    const mod = (await import(
      pathToFileURL(script).href
    )) as unknown as TiersSyncModule;
    const result = mod.syncProfile(opts.configDir, opts.profile);
    return {
      ok: true,
      output:
        "tiers-sync: profiles/" +
        opts.profile +
        "/opencode.jsonc " +
        (result.changed ? "regenerated" : "up to date"),
    };
  } catch (err) {
    return { ok: false, output: errorText(err) };
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface LaunchTierSyncOptions {
  // CONFIG_DIR (owns scripts/tiers-sync.mjs and profiles/).
  configDir: string;
  // Profile name (already validated by the caller).
  profile: string;
  // True when an OPENCODE_CONFIG overlay was launched: that overlay is already
  // merged into the base config, so nothing is regenerated.
  launchSuppressed: boolean;
  // Plugin logger; receives one warn line when the sync fails.
  log: (
    level: "warn",
    message: string,
    extra?: Record<string, unknown>
  ) => void;
}

// Regenerate the resolved profile's overlay before its first application on a
// plain or OC_PROFILE launch. A failed sync only logs: setup cannot abort the
// launch, so the existing overlay is applied as-is. Never writes
// .active-profile.
export async function syncLaunchTierOverlay<T>(
  opts: LaunchTierSyncOptions,
  apply: () => Promise<T>
): Promise<T> {
  if (!opts.launchSuppressed) {
    const result = await syncProfileTiers({
      configDir: opts.configDir,
      profile: opts.profile,
    });
    if (!result.ok) {
      opts.log(
        "warn",
        "launch tier sync failed; applying the existing overlay",
        { profile: opts.profile, output: result.output }
      );
    }
  }
  return apply();
}
