// fusion-tools tests: JSON-Schema subset validator (lib/jsonschema.js).
//
// Run: node --test plugin-src/fusion-tools/test/

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../lib/jsonschema.js";

function ok(schema, value) {
  const v = validateSchema(schema, value);
  assert.deepEqual(v, { ok: true, errors: [] }, JSON.stringify(v.errors));
  return v;
}

function bad(schema, value, fragment) {
  const v = validateSchema(schema, value);
  assert.equal(v.ok, false, "expected failure for " + JSON.stringify(value));
  assert.match(v.errors.join("\n"), fragment);
  return v;
}

test("validator: string type accepts strings, rejects others", () => {
  const schema = { type: "string" };
  ok(schema, "hello");
  bad(schema, 42, /expected type string, got number/);
  bad(schema, null, /expected type string, got null/);
  bad(schema, { a: 1 }, /expected type string, got object/);
});

test("validator: union types (array type field)", () => {
  const schema = { type: ["string", "null"] };
  ok(schema, "x");
  ok(schema, null);
  bad(schema, 3, /expected type string \| null, got number/);
});

test("validator: integer accepts integral numbers only", () => {
  const schema = { type: "integer" };
  ok(schema, 5);
  ok(schema, -2);
  bad(schema, 5.5, /expected type integer, got number/);
  bad(schema, "5", /expected type integer, got string/);
});

test("validator: number excludes non-finite, includes integers", () => {
  const schema = { type: "number" };
  ok(schema, 3);
  ok(schema, 3.25);
  bad(schema, true, /expected type number, got boolean/);
});

test("validator: object and array types", () => {
  ok({ type: "object" }, {});
  bad({ type: "object" }, [], /expected type object, got array/);
  ok({ type: "array" }, [1, 2]);
  bad({ type: "array" }, {}, /expected type array, got object/);
  ok({ type: "boolean" }, false);
});

test("validator: required properties", () => {
  const schema = {
    type: "object",
    properties: { file: { type: "string" }, count: { type: "number" } },
    required: ["file"],
  };
  ok(schema, { file: "a.txt" });
  const v = bad(schema, {}, /data\.file: required property is missing/);
  assert.equal(v.errors.length, 1);
});

test("validator: nested property type errors list the path", () => {
  const schema = {
    type: "object",
    properties: {
      meta: { type: "object", properties: { depth: { type: "number" } } },
    },
  };
  bad(schema, { meta: { depth: "deep" } }, /data\.meta\.depth: expected type number, got string/);
});

test("validator: additionalProperties false flags extras", () => {
  const schema = {
    type: "object",
    properties: { file: { type: "string" } },
    additionalProperties: false,
  };
  ok(schema, { file: "a.txt" });
  bad(schema, { file: "a.txt", extra: 1 }, /data\.extra: unexpected property/);
});

test("validator: additionalProperties schema recurses into extras", () => {
  const schema = {
    type: "object",
    properties: {},
    additionalProperties: { type: "number" },
  };
  ok(schema, { a: 1, b: 2.5 });
  bad(schema, { a: "nope" }, /data\.a: expected type number, got string/);
});

test("validator: enum", () => {
  const schema = { type: "string", enum: ["permissive", "strict"] };
  ok(schema, "strict");
  bad(schema, "loose", /must be one of "permissive", "strict"/);
});

test("validator: enum compares objects structurally", () => {
  const schema = { enum: [{ a: 1 }, [1, 2]] };
  ok(schema, { a: 1 });
  ok(schema, [1, 2]);
  bad(schema, { a: 2 }, /must be one of/);
});

test("validator: items (uniform form) validates each element", () => {
  const schema = { type: "array", items: { type: "number", minimum: 0 } };
  ok(schema, [0, 1.5, 100]);
  const v = bad(schema, [1, -2], /data\[1\]: -2 is below minimum 0/);
  assert.equal(v.errors.length, 1);
});

test("validator: tuple items form", () => {
  const schema = { type: "array", items: [{ type: "string" }, { type: "number" }] };
  ok(schema, ["a", 1]);
  bad(schema, ["a", "b"], /data\[1\]: expected type number, got string/);
});

test("validator: string length and pattern constraints", () => {
  const schema = { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" };
  ok(schema, "ab");
  ok(schema, "abcd");
  bad(schema, "a", /is below minLength 2/);
  bad(schema, "abcde", /is above maxLength 4/);
  bad(schema, "AB1", /does not match pattern/);
});

test("validator: number minimum/maximum", () => {
  const schema = { type: "number", minimum: 1, maximum: 10 };
  ok(schema, 1);
  ok(schema, 10);
  bad(schema, 0.5, /is below minimum 1/);
  bad(schema, 11, /is above maximum 10/);
});

test("validator: multiple violations are ALL reported", () => {
  const schema = {
    type: "object",
    properties: {
      file: { type: "string" },
      count: { type: "integer", minimum: 1 },
    },
    required: ["file", "count"],
    additionalProperties: false,
  };
  const v = validateSchema(schema, { count: 0, junk: true });
  assert.equal(v.ok, false);
  const text = v.errors.join("\n");
  assert.match(text, /data\.file: required property is missing/);
  assert.match(text, /data\.count: 0 is below minimum 1/);
  assert.match(text, /data\.junk: unexpected property/);
  assert.equal(v.errors.length, 3);
});

test("validator: unknown keywords are ignored", () => {
  const schema = { type: "string", format: "uri", title: "x", $comment: "y" };
  ok(schema, "anything goes");
});

test("validator: malformed schema nodes never throw", () => {
  ok(null, { any: "thing" });
  ok("not a schema", 42);
  ok({ type: "nonsense" }, "still fine");
  ok({ pattern: "[" }, "unclosed regex pattern in schema is ignored");
});

test("validator: type mismatch stops subtree checks (focused errors)", () => {
  const schema = {
    type: "object",
    properties: { file: { type: "string", minLength: 100 } },
  };
  const v = bad(schema, { file: 12 }, /expected type string, got number/);
  assert.equal(v.errors.length, 1);
});
