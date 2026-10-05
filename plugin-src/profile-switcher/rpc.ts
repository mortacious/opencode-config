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
}

export interface ProfilePopulateInput {
  sessions: ProfilePopulateSession[];
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
              },
              required: ["sessionID"],
              additionalProperties: false,
            },
          },
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
              },
              required: ["sessionID"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
});
