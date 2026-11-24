// Tests for the /kernel panel's theme -> syntax style mapping.

import assert from "node:assert/strict";
import test from "node:test";

import { syntaxStyles } from "../lib/syntax.js";

function fakeTheme() {
  return {
    text: {
      base: "#101010",
      feedback: {
        error: { base: "#ff0000" },
        warning: { base: "#ffaa00" },
      },
    },
    markdown: { link: "#00aaff" },
    syntax: {
      comment: "#888888",
      string: "#22aa22",
      number: "#aa5522",
      keyword: "#aa22aa",
      type: "#2266aa",
      function: "#cc8800",
      operator: "#227777",
      variable: "#447744",
      punctuation: "#777777",
    },
  };
}

test("default uses the theme text color", () => {
  const styles = syntaxStyles(fakeTheme());
  assert.deepEqual(styles.default, { fg: "#101010" });
});

test("the nine syntax tokens map to their colors", () => {
  const theme = fakeTheme();
  const styles = syntaxStyles(theme);
  assert.deepEqual(styles.comment.fg, theme.syntax.comment);
  assert.deepEqual(styles.string.fg, theme.syntax.string);
  assert.deepEqual(styles.number.fg, theme.syntax.number);
  assert.deepEqual(styles.keyword.fg, theme.syntax.keyword);
  assert.deepEqual(styles.type.fg, theme.syntax.type);
  assert.deepEqual(styles.function.fg, theme.syntax.function);
  assert.deepEqual(styles.operator.fg, theme.syntax.operator);
  assert.deepEqual(styles.variable.fg, theme.syntax.variable);
  assert.deepEqual(styles.punctuation.fg, theme.syntax.punctuation);
});

test("comment captures are italic", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of ["comment", "comment.documentation"]) {
    assert.deepEqual(styles[name], { fg: "#888888", italic: true });
  }
});

test("string, number, variable, and function capture groups share their token", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of ["string", "symbol", "character", "character.special"]) {
    assert.equal(styles[name].fg, "#22aa22");
  }
  for (const name of ["number", "boolean", "constant", "float"]) {
    assert.equal(styles[name].fg, "#aa5522");
  }
  for (const name of [
    "variable",
    "variable.parameter",
    "parameter",
    "property",
    "field",
    "function.call",
    "function.method.call",
  ]) {
    assert.equal(styles[name].fg, "#447744");
  }
  for (const name of ["variable.member", "function", "function.method", "constructor"]) {
    assert.equal(styles[name].fg, "#cc8800");
  }
});

test("keyword captures are italic except the type/function/import splits", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of [
    "keyword",
    "keyword.return",
    "keyword.conditional",
    "keyword.repeat",
    "keyword.coroutine",
    "keyword.exception",
    "keyword.directive",
    "keyword.modifier",
  ]) {
    assert.deepEqual(styles[name], { fg: "#aa22aa", italic: true });
  }
  assert.deepEqual(styles["keyword.type"], { fg: "#2266aa", bold: true, italic: true });
  assert.deepEqual(styles["keyword.function"], { fg: "#cc8800" });
  for (const name of [
    "keyword.import",
    "keyword.export",
    "string.escape",
    "string.regexp",
    "tag.attribute",
  ]) {
    assert.deepEqual(styles[name], { fg: "#aa22aa" });
  }
});

test("operator captures use the operator color", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of [
    "operator",
    "keyword.operator",
    "punctuation.delimiter",
    "punctuation.special",
    "tag.delimiter",
    "keyword.conditional.ternary",
  ]) {
    assert.deepEqual(styles[name], { fg: "#227777" });
  }
});

test("type captures use the type color; definitions are bold", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of ["type", "module", "class", "namespace"]) {
    assert.deepEqual(styles[name], { fg: "#2266aa" });
  }
  assert.deepEqual(styles["type.definition"], { fg: "#2266aa", bold: true });
});

test("punctuation captures use the punctuation color", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of ["punctuation", "punctuation.bracket"]) {
    assert.deepEqual(styles[name], { fg: "#777777" });
  }
});

test("builtins, super, and tags fall back to the error color", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of [
    "variable.builtin",
    "type.builtin",
    "function.builtin",
    "module.builtin",
    "constant.builtin",
    "variable.super",
    "tag",
  ]) {
    assert.deepEqual(styles[name], { fg: "#ff0000" });
  }
});

test("attributes and annotations use the warning color", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of ["attribute", "annotation"]) {
    assert.deepEqual(styles[name], { fg: "#ffaa00" });
  }
});

test("link captures use the markdown link color and are underlined", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const name of [
    "markup.link",
    "markup.link.url",
    "string.special",
    "string.special.url",
  ]) {
    assert.deepEqual(styles[name], { fg: "#00aaff", underline: true });
  }
});

test("a missing syntax block returns only default", () => {
  const styles = syntaxStyles({ text: { base: "#101010" } });
  assert.deepEqual(styles, { default: { fg: "#101010" } });
  assert.deepEqual(syntaxStyles({}), { default: { fg: undefined } });
  assert.deepEqual(syntaxStyles(null), { default: { fg: undefined } });
});

test("a missing syntax token falls back to the text color", () => {
  const theme = fakeTheme();
  delete theme.syntax.string;
  const styles = syntaxStyles(theme);
  assert.equal(styles.string.fg, "#101010");
  assert.equal(styles["character.special"].fg, "#101010");
});

test("every mapped style value is an object", () => {
  const styles = syntaxStyles(fakeTheme());
  for (const [name, value] of Object.entries(styles)) {
    assert.equal(typeof value, "object", `${name} must be an object`);
    assert.notEqual(value, null, `${name} must not be null`);
  }
});
