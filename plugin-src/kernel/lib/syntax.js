// Theme -> SyntaxStyle.fromStyles map for the /kernel panel.
//
// This reproduces the host's generateSyntax mapping (packages/theme/src/tui/
// syntax.ts) from the resolved theme, because the installed 2.3.2 CLI does not
// expose "@opencode/theme/tui" to plugins. It is pure data so node --test can
// cover it without a renderer or a native syntax style.
//
// All files ASCII only.

/**
 * Build the style map passed to `SyntaxStyle.fromStyles`. Keys are tree-sitter
 * capture names; values carry a foreground color plus any attributes the host
 * gives that capture. A theme without `syntax` (or without a usable text
 * color) yields only `default`, so the panel never throws on a partial theme.
 */
export function syntaxStyles(theme) {
  const source = theme && typeof theme === "object" ? theme : {};
  const text = source.text && typeof source.text === "object" ? source.text : {};
  const base = typeof text.base === "string" ? text.base : undefined;
  const styles = { default: { fg: base } };

  const syntax = source.syntax;
  if (!syntax || typeof syntax !== "object") return styles;

  const pick = (value) =>
    typeof value === "string" && value !== "" ? value : base;
  const feedback = text.feedback && typeof text.feedback === "object" ? text.feedback : {};
  const error = feedback.error && typeof feedback.error === "object" ? feedback.error : {};
  const warning = feedback.warning && typeof feedback.warning === "object" ? feedback.warning : {};
  const markdown = source.markdown && typeof source.markdown === "object" ? source.markdown : {};

  function add(names, fg, attributes) {
    for (const name of names) {
      const style = { fg };
      if (attributes) {
        if (attributes.bold) style.bold = true;
        if (attributes.italic) style.italic = true;
        if (attributes.underline) style.underline = true;
      }
      styles[name] = style;
    }
  }

  add(["comment", "comment.documentation"], pick(syntax.comment), { italic: true });
  add(["string", "symbol", "character", "character.special"], pick(syntax.string));
  add(["number", "boolean", "constant", "float"], pick(syntax.number));
  add(
    [
      "keyword",
      "keyword.return",
      "keyword.conditional",
      "keyword.repeat",
      "keyword.coroutine",
      "keyword.exception",
      "keyword.directive",
      "keyword.modifier",
    ],
    pick(syntax.keyword),
    { italic: true },
  );
  add(["keyword.type"], pick(syntax.type), { bold: true, italic: true });
  add(["keyword.function"], pick(syntax.function));
  add(
    ["keyword.import", "keyword.export", "string.escape", "string.regexp", "tag.attribute"],
    pick(syntax.keyword),
  );
  add(
    [
      "operator",
      "keyword.operator",
      "punctuation.delimiter",
      "punctuation.special",
      "tag.delimiter",
      "keyword.conditional.ternary",
    ],
    pick(syntax.operator),
  );
  add(
    [
      "variable",
      "variable.parameter",
      "parameter",
      "property",
      "field",
      "function.call",
      "function.method.call",
    ],
    pick(syntax.variable),
  );
  add(
    ["variable.member", "function", "function.method", "constructor"],
    pick(syntax.function),
  );
  add(["type", "module", "class", "namespace"], pick(syntax.type));
  add(["type.definition"], pick(syntax.type), { bold: true });
  add(["punctuation", "punctuation.bracket"], pick(syntax.punctuation));
  add(
    [
      "variable.builtin",
      "type.builtin",
      "function.builtin",
      "module.builtin",
      "constant.builtin",
      "variable.super",
      "tag",
    ],
    pick(error.base),
  );
  add(["attribute", "annotation"], pick(warning.base));
  add(
    ["markup.link", "markup.link.url", "string.special", "string.special.url"],
    pick(markdown.link),
    { underline: true },
  );

  return styles;
}
