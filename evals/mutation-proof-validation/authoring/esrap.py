NAME = "esrap"
I = "src/index.js"; C = "src/context.js"; TS = "src/languages/ts/index.js"
T = ["test/esrap.test.js", "test/indent.test.js"]
TM = ["test/esrap.test.js", "test/sourcemap-keywords.test.js"]
FAULTS = [
 (I, "const indent_str = opts.indent ?? '\\t';", "const indent_str = opts.indent ?? '  ';", "killed", "indent-default", "default indentation is a tab", T, "wrong default"),
 (I, "append(needs_margin ? '\\n' + current_newline : current_newline);", "append(current_newline);", "killed", "margin", "a margin command emits a blank line", T, "dropped branch"),
 (I, "\t\t\t} else if (needs_space) {\n\t\t\t\tappend(' ');\n\t\t\t}", "\t\t\t}", "killed", "space", "a space command emits a space before the next text", T, "dropped branch"),
 (I, "\t\t\tlocation.line - 1,", "\t\t\tlocation.line,", "killed", "map-line", "source map lines are zero-based", TM, "off-by-one"),
 (I, "\t\t\t\tcurrent_column = 0;", "\t\t\t\tcurrent_column = 1;", "killed", "map-column", "generated columns restart at 0 after a newline", TM, "off-by-one"),
 (C, "if (this.#has_newline || context.multiline) {", "if (this.#has_newline && context.multiline) {", "killed", "multiline", "appending a multiline context makes the parent multiline", T, "flipped logical operator"),
 (TS, "const quote_char = options.quotes === 'double' ? '\"' : \"'\";", "const quote_char = options.quotes === 'double' ? \"'\" : '\"';", "killed", "quotes", "quotes option selects the string delimiter (single by default)", ["test/quotes.test.js"], "swapped arms"),
 (C, "\t\tif (this.#visitors._) {", "\t\tif (false) {", "killed", "universal", "a `_` visitor wraps every node visit", ["test/pluggability.test.js"], "dropped branch"),
 (I, "0, // source index is always zero", "0, // single source", "survived", "comment", "comment-only change", TM, "comment change"),
 (I, "\tfor (let i = 0; i < commands.length; i += 1) {\n\t\trun(commands[i]);\n\t}", "\trun(commands);", "survived", "equiv-run", "run() iterates arrays itself", T, "equivalent rewrite"),
 (I, "\tlet needs_newline = false;\n\tlet needs_margin = false;", "\tlet needs_margin = false;\n\tlet needs_newline = false;", "survived", "reorder", "independent declarations reordered", T, "reorder of independent declarations"),
 (C, "export const margin = 0;", "throw new Error('fault: context.js throws at import');\nexport const margin = 0;", "inconclusive", "load", "module loads", T, "module throws at import"),
 (I, "export function print(node, visitors, opts = {}) {", "function print(node, visitors, opts = {}) {", "inconclusive", "export", "print is exported", T, "exported function removed while tests import it"),
]
