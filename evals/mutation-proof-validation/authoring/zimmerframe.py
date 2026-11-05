NAME = "zimmerframe"
T = ["test/traversal.js", "test/transformation.js"]
P = "src/walk.js"
FAULTS = [
 (P, "if (stopped) return;", "if (false) return;", "killed", "stop", "context.stop() halts the walk", T, "dropped branch: stop() ignored"),
 (P, "\t\tpath.pop();\n\n\t\tif (mutations) {", "\n\t\tif (mutations) {", "killed", "path", "context.path lists only the ancestors of the current node", T, "dropped statement: path never popped after children"),
 (P, "(mutated_array ??= child_node.slice())[i] = result;", "(mutated_array ??= child_node)[i] = result;", "killed", "immutable", "transformations never mutate the input tree", T, "dropped copy: array mutated in place"),
 (P, "for (let i = 0; i < len; i++) {", "for (let i = 1; i < len; i++) {", "killed", "arrays", "every element of an array child is visited", T, "off-by-one: first array element skipped"),
 (P, "if (!result && next_result) {", "if (!result && !next_result) {", "killed", "next-result", "a transformed subtree returned through next() is kept", T, "flipped condition"),
 (P, "\t\tobj[key] = mutations[key];", "\t\tobj[key] = node[key];", "killed", "apply", "child replacements appear in the returned node", T, "wrong operand: mutations dropped"),
 (P, "if (!node.type) return;", "if (node.type) return;", "killed", "typed", "nodes with a type are visited", T, "negated condition"),
 (P, "return visit(node, [], state) ?? node;", "return visit(node, [], state);", "killed", "return-root", "walk returns the original node when nothing changes", T, "dropped default"),
 (P, "// avoid manipulating the prototype", "// skip the prototype key", "survived", "comment", "comment-only change", T, "comment change"),
 (P, "if (Array.isArray(child_node)) {", "if (child_node instanceof Array) {", "survived", "equiv-array", "same-realm arrays detected", T, "equivalent rewrite for same-realm arrays"),
 (P, "\tconst universal = visitors._;\n\n\tlet stopped = false;", "\tlet stopped = false;\n\n\tconst universal = visitors._;", "survived", "reorder", "independent declarations reordered", T, "reorder of independent declarations"),
 (P, "/** @import { Context, Visitor, Visitors } from './types.js' */", "/** @import { Context, Visitor, Visitors } from './types.js' */\nthrow new Error('fault: walk.js throws at import');", "inconclusive", "load", "module loads", T, "module throws at import"),
 (P, "export function walk(node, state, visitors) {", "function walk(node, state, visitors) {", "inconclusive", "export", "walk is exported", T, "exported function removed while tests import it"),
]
