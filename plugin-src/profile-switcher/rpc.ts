// profile-switcher: shared RPC definition (rpc id "profile") used by the
// server plugin (index.ts) and the TUI plugin (tui.tsx).
//
// Schema format: JSON Schema (no validator dependency), per the installed
// @opencode/plugin/rpc typings (Tool.ValueSchema accepts JsonSchema). JSON
// Schema values surface as `unknown` in TypeScript, so this module also
// exports the concrete data shapes for narrowing at the call sites.
//
// All files ASCII only.

import { Rpc } from "@opencode/plugin/rpc";

export interface ProfileListEntry {
  name: string;
  file: string;
}

export interface ProfileListResult {
  active: string;
  profiles: ProfileListEntry[];
}

export interface ProfileAgentModelEntry {
  agent: string;
  model: string;
}

export interface ProfileCurrentResult {
  active: string;
  agents?: ProfileAgentModelEntry[];
}

export interface ProfileAppliedEntry {
  agent: string;
  model: string;
  fallback: boolean;
}

export interface ProfileSetResult {
  active: string;
  applied: ProfileAppliedEntry[];
  warnings: string[];
}

export interface ProfileChangedEvent {
  active: string;
  agents?: ProfileAgentModelEntry[];
}

export interface ProfilePopulateSession {
  sessionID: string;
  agent?: string;
  model?: string;
  parentID?: string;
  // The session's directory, sent by the TUI from its directory-filtered
  // session list so the server can route the seed to the instance that owns
  // that location. Absent on tabs-gap entries (resolved via session.get).
  location?: string;
  // The claiming TUI window's id: the TUI tags the sessions open in this
  // window as tabs so the server instance can scope migration targets to the
  // sessions a window actually holds. Absent on legacy payloads.
  window?: string;
}

export interface ProfilePopulateInput {
  sessions: ProfilePopulateSession[];
  // Explicit top-level claim-refresh target for THIS window. When present, the
  // named window's claim set is REPLACED wholesale by the sessions in
  // `sessions` tagged with that same window - so `sessions: []` with a
  // top-level `window` is a valid refresh that prunes the window's closed tabs
  // (per-entry `window` alone cannot express an empty set). Invalid/absent ->
  // legacy per-entry-only semantics.
  window?: string;
  // The TUI's own directory. An empty top-level-window refresh carries no
  // entries to route by, so this field tells each server instance whether the
  // refresh targets its location. Absent -> lenient (apply).
  location?: string;
}

export interface ProfilePopulateOutput {
  tracked: number;
}

export const Profile = Rpc.define({
  id: "profile",
  methods: {
    list: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          active: { type: "string" },
          profiles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                file: { type: "string" },
              },
              required: ["name", "file"],
              additionalProperties: false,
            },
          },
        },
        required: ["active", "profiles"],
        additionalProperties: false,
      },
    },
    current: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          active: { type: "string" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
              },
              required: ["agent", "model"],
              additionalProperties: false,
            },
          },
        },
        required: ["active", "agents"],
        additionalProperties: false,
      },
    },
    set: {
      input: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          active: { type: "string" },
          applied: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
                fallback: { type: "boolean" },
              },
              required: ["agent", "model", "fallback"],
              additionalProperties: false,
            },
          },
          warnings: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["active", "applied", "warnings"],
        additionalProperties: false,
      },
      errors: {
        unknown_profile: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    populate: {
      input: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                agent: { type: "string" },
                model: { type: "string" },
                parentID: { type: "string" },
                location: { type: "string" },
                window: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[A-Za-z0-9_-]+$",
                },
              },
              required: ["sessionID"],
              additionalProperties: false,
            },
          },
          window: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          location: { type: "string" },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          tracked: { type: "number" },
        },
        required: ["tracked"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          active: { type: "string" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
              },
              required: ["agent", "model"],
              additionalProperties: false,
            },
          },
        },
        required: ["active"],
        additionalProperties: false,
      },
    },
    populate: {
      schema: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                agent: { type: "string" },
                model: { type: "string" },
                parentID: { type: "string" },
                location: { type: "string" },
                window: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[A-Za-z0-9_-]+$",
                },
              },
              required: ["sessionID"],
              additionalProperties: false,
            },
          },
          window: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          location: { type: "string" },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
});
