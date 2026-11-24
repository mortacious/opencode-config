// kernel: shared RPC definition (rpc id "kernel") used by the server plugin
// (index.js) and a future TUI plugin (/kernel panel).
//
// Methods:
//  - cells: the session journal for the panel - meta.json plus the last
//    `limit` cell/boundary records (default 100, cap 500). Reads only; the
//    TUI formats and highlights.
//
// Events (server -> TUI):
//  - cell:  one completed journal cell record, emitted after a successful
//    kernel tool call. The record is passed through untransformed, including
//    display_data outputs with base64 image/* payloads.
//  - reset: `{ selection }` after a kernel reset, so the panel can mark the
//    state wipe.
//
// Schema format: JSON Schema (no validator dependency), per the installed
// @opencode/plugin/rpc typings.
//
// All files ASCII only.

import { Rpc } from "@opencode/plugin/rpc";

export const Kernel = Rpc.define({
  id: "kernel",
  methods: {
    cells: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          meta: { type: ["object", "null"] },
          cells: {
            type: "array",
            items: { type: "object" },
          },
        },
        required: ["meta", "cells"],
        additionalProperties: false,
      },
    },
  },
  events: {
    cell: {
      schema: {
        type: "object",
        properties: {
          v: { type: "integer" },
          type: { type: "string", enum: ["cell"] },
          execution_count: { type: "integer" },
          source: { type: "string" },
          outputs: { type: "array", items: { type: "object" } },
          truncated: { type: "boolean" },
        },
      },
    },
    reset: {
      schema: {
        type: "object",
        properties: {
          selection: { type: "string" },
        },
        required: ["selection"],
        additionalProperties: false,
      },
    },
  },
});
