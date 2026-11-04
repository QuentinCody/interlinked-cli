NAME = "ultrahtml"
P = "src/index.ts"
B = ["test/basic.test.ts", "test/html.test.ts"]
FAULTS = [
 (P, "\t'&': '&amp;',", "\t'&': '&',", "killed", "escape-amp", "html`` escapes & in interpolated strings", B, "wrong value in escape table"),
 (P, "\t\tattrStr += ` ${key}=\"${value}\"`;", "\t\tattrStr += ` ${key}=${value}`;", "killed", "attr-quote", "rendered attribute values are double-quoted", B + ["test/jsx.test.tsx"], "dropped quoting"),
 (P, "for (let currentIndex = 0; currentIndex < str.length; currentIndex++) {", "for (let currentIndex = 1; currentIndex < str.length; currentIndex++) {", "killed", "attr-first-char", "attribute names are parsed from their first character", B, "off-by-one"),
 (P, "\t\t\t\t\t\tstate = 'value';\n\t\t\t\t\t} else {\n\t\t\t\t\t\tstate = 'none';", "\t\t\t\t\t\tstate = 'none';\n\t\t\t\t\t} else {\n\t\t\t\t\t\tstate = 'none';", "killed", "attr-value", "key=\"value\" attributes keep their value", B, "dropped branch"),
 (P, "\t\t\tif (n.name === 'svg') return true;", "\t\t\tif (n.name === 'svg') return false;", "killed", "svg-self-close", "empty elements inside svg render self-closed", ["test/svg.test.ts"], "flipped return"),
 (P, "\t'wbr',\n]);", "]);", "killed", "void-wbr", "wbr is a void tag", B, "dropped set member (weakly tested tags may survive)"),
 (P, "\t\t} else if (expr || expr === 0) {", "\t\t} else if (expr) {", "killed", "html-zero", "html`` renders the number 0", B, "dropped disjunct"),
 (P, "\t\t\treturn `<!--${node.value}-->`;\n\t\tcase DOCTYPE_NODE:\n\t\t\treturn `<!${node.value}>`;\n\t}\n}\n\nexport async function render", "\t\t\treturn `<!-${node.value}-->`;\n\t\tcase DOCTYPE_NODE:\n\t\t\treturn `<!${node.value}>`;\n\t}\n}\n\nexport async function render", "killed", "comment-render-sync", "renderSync keeps comments", B, "wrong literal"),
 (P, "const CHAR_AT = 64; // @", "const CHAR_AT = 64; // at-sign", "survived", "comment", "comment-only change", B, "comment change"),
 (P, "const quote = currentChar === CHAR_DOUBLE_QUOTE ? '\"' : \"'\";", "const quote = currentChar !== CHAR_DOUBLE_QUOTE ? \"'\" : '\"';", "survived", "equiv-quote", "same quote selected", B, "equivalent rewrite"),
 (P, "const HTMLString = Symbol('HTMLString');\nconst AttrString = Symbol('AttrString');", "const AttrString = Symbol('AttrString');\nconst HTMLString = Symbol('HTMLString');", "survived", "reorder", "independent declarations reordered", B, "reorder of independent declarations"),
 (P, "export const DOCUMENT_NODE = 0;", "throw new Error('fault: index throws at import');\nexport const DOCUMENT_NODE = 0;", "inconclusive", "load", "module loads", B, "module throws at import"),
 (P, "export function parse(input: string | ReturnType<typeof html>): any {", "function parse(input: string | ReturnType<typeof html>): any {", "inconclusive", "export", "parse is exported", B, "exported function removed while tests import it"),
]
