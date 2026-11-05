NAME = "entities"
X = "src/escape.ts"; D = "src/decode-codepoint.ts"
TE = ["src/escape.spec.ts", "src/encode.spec.ts", "src/index.spec.ts"]
TD = ["src/decode.spec.ts", "src/decode-codepoint.spec.ts"]
FAULTS = [
 (X, '? "&apos;"', '? "&#39;"', "killed", "xml-apos", "encodeXML escapes ' as &apos;", TE, "wrong replacement literal"),
 (D, "        codePoint === 0 ||\n", "", "killed", "nul-invalid", "code point 0 decodes to U+FFFD", TD, "dropped branch"),
 (X, "if (cp !== char) index++; // Skip trailing surrogate", "// Skip trailing surrogate", "killed", "astral", "astral characters encode as one numeric reference", TE, "dropped statement"),
 (X, "const textEscapeRegex = /[&<>\\u{A0}]/gu;", "const textEscapeRegex = /[&<>]/gu;", "killed", "text-nbsp", "escapeText escapes U+00A0 as &nbsp;", TE, "dropped character class member"),
 (X, "        last = index + 1;", "        last = index;", "killed", "escape-advance", "an escaped character is not repeated in the output", TE, "off-by-one"),
 (D, "if (codePoint >= 128 && codePoint <= 159) {", "if (codePoint >= 128 && codePoint < 159) {", "killed", "c1-159", "&#159; decodes to U+0178 per the C1 table", TD, "boundary flip"),
 (X, "if (last < length) out += input.substr(last);", "if (last < length - 1) out += input.substr(last);", "killed", "tail", "a one-character tail after the last escape is kept", TE, "off-by-one"),
 (X, 'const attributeEscapeRegex = /["&<>\\u{A0}]/gu;', "const attributeEscapeRegex = /[&<>\\u{A0}]/gu;", "killed", "attr-quote", "escapeAttribute escapes double quotes", TE, "dropped character class member"),
 (X, "// Skip trailing surrogate", "// skip the low surrogate", "survived", "comment", "comment-only change", TE, "comment change"),
 (X, "    if (out === undefined) return input;", "    if (out == undefined) return input;", "survived", "equiv-undef", "out is string | undefined, never null", TE, "equivalent rewrite"),
 (X, "    let last = 0;\n    let index = 0;", "    let index = 0;\n    let last = 0;", "survived", "reorder", "independent declarations reordered", TE, "reorder of independent declarations"),
 (D, "export function replaceCodePoint(", "throw new Error(\"fault: decode-codepoint throws at import\");\nexport function replaceCodePoint(", "inconclusive", "load", "module loads", TD, "module throws at import"),
 (X, "export function escapeText(", "function escapeText(", "inconclusive", "export", "escapeText is exported", TE, "exported function removed while index re-exports it"),
]
