// fusion-tools: minimal JSON-Schema subset validator for fanout results.
//
// Supported keywords: type, properties, required, enum, items, minimum,
// maximum, minLength, maxLength, pattern, additionalProperties. Unknown
// keywords are silently ignored. Never throws: a malformed schema node is
// treated as non-constraining.
//
// validateSchema(schema, value) -> { ok: boolean, errors: string[] }
// Error strings are model-facing (the worker retries on them), one entry
// per violation, paths rooted at "data".

const TYPE_NAMES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];

function typeMatches(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return (
        typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
      );
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      // Unknown type name: do not constrain.
      return true;
  }
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Structural equality (enum values may be objects/arrays).
function deepEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function walk(schema, value, path, errors) {
  if (!isPlainObject(schema)) return;

  // type (string or array of strings)
  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = names.some((t) => typeof t === "string" && typeMatches(t, value));
    if (!ok) {
      errors.push(
        path +
          ": expected type " +
          names.filter((t) => TYPE_NAMES.includes(t)).join(" | ") +
          ", got " +
          describeType(value),
      );
      // Further keyword checks rarely make sense on a type mismatch; stop
      // this subtree here to keep the error list focused.
      return;
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => deepEquals(v, value))) {
      errors.push(
        path +
          ": must be one of " +
          schema.enum
            .map((v) => {
              try {
                return JSON.stringify(v);
              } catch {
                return String(v);
              }
            })
            .join(", "),
      );
    }
  }

  // string constraints
  if (typeof value === "string") {
    if (schema.minLength !== undefined) {
      const min = asNumber(schema.minLength);
      if (min !== null && value.length < min) {
        errors.push(path + ": length " + value.length + " is below minLength " + min);
      }
    }
    if (schema.maxLength !== undefined) {
      const max = asNumber(schema.maxLength);
      if (max !== null && value.length > max) {
        errors.push(path + ": length " + value.length + " is above maxLength " + max);
      }
    }
    if (schema.pattern !== undefined && typeof schema.pattern === "string") {
      let re = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        // invalid pattern in the schema: ignore it
      }
      if (re && !re.test(value)) {
        errors.push(path + ": does not match pattern " + JSON.stringify(schema.pattern));
      }
    }
  }

  // numeric constraints
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined) {
      const min = asNumber(schema.minimum);
      if (min !== null && value < min) {
        errors.push(path + ": " + value + " is below minimum " + min);
      }
    }
    if (schema.maximum !== undefined) {
      const max = asNumber(schema.maximum);
      if (max !== null && value > max) {
        errors.push(path + ": " + value + " is above maximum " + max);
      }
    }
  }

  // object keywords
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(joinKey(path, key) + ": required property is missing");
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const key of keys) {
        const sub = schema.properties[key];
        if (sub !== undefined) {
          walk(sub, value[key], joinKey(path, key), errors);
        }
      }
    }
    const declared = isPlainObject(schema.properties)
      ? Object.keys(schema.properties)
      : [];
    const extra = keys.filter((k) => !declared.includes(k));
    if (extra.length > 0) {
      if (schema.additionalProperties === false) {
        for (const key of extra) {
          errors.push(joinKey(path, key) + ": unexpected property (additionalProperties is false)");
        }
      } else if (isPlainObject(schema.additionalProperties)) {
        for (const key of extra) {
          walk(schema.additionalProperties, value[key], joinKey(path, key), errors);
        }
      }
    }
  }

  // array keyword
  if (Array.isArray(value) && schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      // tuple form
      for (let i = 0; i < value.length && i < schema.items.length; i++) {
        walk(schema.items[i], value[i], joinIndex(path, i), errors);
      }
    } else {
      for (let i = 0; i < value.length; i++) {
        walk(schema.items, value[i], joinIndex(path, i), errors);
      }
    }
  }
}

function joinKey(path, key) {
  return path ? path + "." + key : key;
}

function joinIndex(path, i) {
  return path + "[" + i + "]";
}

export function validateSchema(schema, value) {
  const errors = [];
  try {
    walk(schema, value, "data", errors);
  } catch (err) {
    errors.push("data: validation crashed: " + String(err));
  }
  return { ok: errors.length === 0, errors };
}
