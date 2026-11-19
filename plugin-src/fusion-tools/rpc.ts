// fusion-tools: shared RPC definition (rpc id "steer") used by the server
// plugin (index.js) and the TUI plugin (tui.tsx).
//
// Methods:
//  - children: direct children of a session, for the bare-/steer picker
//    (running first). Enumeration and running detection stay server-side.
//  - deliver:  the single delivery entry point for the TUI /steer command.
//    `input` carries the raw arguments after "/steer" (command parsing path);
//    `target` + `message` is the picker path. Delivery, target resolution, the
//    channel-log line and the orchestrator aside all live in lib/steer.js.
//
// Schema format: JSON Schema (no validator dependency), per the installed
// @opencode/plugin/rpc typings. JSON Schema values surface as `unknown` in
// TypeScript, so this module also exports the concrete result shapes for
// narrowing in the TUI.
//
// All files ASCII only.

import { Rpc } from "@opencode/plugin/rpc";

export interface SteerChild {
  sessionID: string;
  agent: string;
  running: boolean;
}

export interface SteerChildrenResult {
  children: SteerChild[];
}

export interface SteerDeliverInput {
  parentSessionID: string;
  /** Raw arguments after "/steer" (typed command path). */
  input?: string;
  /** Picker path: an agent name, session id, or session-id prefix. */
  target?: string;
  /** Picker path: the steering message. */
  message?: string;
  delivery?: "steer" | "queue";
  source?: "command" | "tool";
}

export interface SteerDeliverResult {
  ok: boolean;
  targetSessionID?: string;
  agent?: string;
  delivery?: "steer" | "queue";
  error?: string;
  candidates?: string[];
}

export const Steer = Rpc.define({
  id: "steer",
  methods: {
    children: {
      input: {
        type: "object",
        properties: {
          parentSessionID: { type: "string" },
        },
        required: ["parentSessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          children: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                agent: { type: "string" },
                running: { type: "boolean" },
              },
              required: ["sessionID", "agent", "running"],
              additionalProperties: false,
            },
          },
        },
        required: ["children"],
        additionalProperties: false,
      },
    },
    deliver: {
      input: {
        type: "object",
        properties: {
          parentSessionID: { type: "string" },
          input: { type: "string" },
          target: { type: "string" },
          message: { type: "string" },
          delivery: { type: "string", enum: ["steer", "queue"] },
          source: { type: "string", enum: ["command", "tool"] },
        },
        required: ["parentSessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          targetSessionID: { type: "string" },
          agent: { type: "string" },
          delivery: { type: "string", enum: ["steer", "queue"] },
          error: { type: "string" },
          candidates: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
