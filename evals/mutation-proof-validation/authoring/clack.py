NAME = "clack"
CU = "packages/core/src/utils/cursor.ts"; SE = "packages/core/src/utils/settings.ts"; ST = "packages/core/src/utils/string.ts"
TC = ["packages/core/test/utils/cursor.test.ts"]
TS = ["packages/core/test/utils/settings.test.ts", "packages/core/test/utils.test.ts"]
FAULTS = [
 (CU, "const clampedCursor = newCursor < 0 ? maxCursor : newCursor > maxCursor ? 0 : newCursor;", "const clampedCursor = newCursor < 0 ? 0 : newCursor > maxCursor ? 0 : newCursor;", "killed", "wrap-up", "moving up from the first option wraps to the last", TC, "wrong branch value"),
 (CU, "return findCursor(clampedCursor, delta < 0 ? -1 : 1, options);", "return clampedCursor;", "killed", "skip-disabled", "the cursor skips disabled options", TC, "dropped branch"),
 (CU, "\t\treturn cursor;\n\t}\n\tconst newCursor", "\t\treturn 0;\n\t}\n\tconst newCursor", "killed", "all-disabled", "with every option disabled the cursor stays put", TC, "wrong return value"),
 (CU, "\t\tcursorX -= line.length + 1;", "\t\tcursorX -= line.length;", "killed", "text-newline", "text cursor accounts for the newline between lines", TC, "off-by-one"),
 (SE, "if (!settings.aliases.has(alias)) {", "if (settings.aliases.has(alias)) {", "killed", "alias-add", "updateSettings adds new aliases", TS, "negated condition"),
 (SE, "settings.withGuide = updates.withGuide !== false;", "settings.withGuide = true;", "killed", "with-guide", "withGuide: false disables the guide", TS, "dropped value"),
 (SE, "['j', 'down'],", "['j', 'up'],", "killed", "vim-j", "j is aliased to down", TS, "swapped value"),
 (SE, "settings.messages.cancel = messages.cancel;", "settings.messages.error = messages.cancel;", "killed", "cancel-msg", "messages.cancel updates the cancel message", TS, "wrong target"),
 (SE, "// opinionated defaults!", "// defaults", "survived", "comment", "comment-only change", TS, "comment change"),
 (CU, "const maxCursor = Math.max(options.length - 1, 0);", "const maxCursor = options.length - 1;", "survived", "equiv-max", "options is non-empty past the early return", TC, "equivalent rewrite"),
 (ST, "\tconst aLines = a.split('\\n');\n\tconst bLines = b.split('\\n');", "\tconst bLines = b.split('\\n');\n\tconst aLines = a.split('\\n');", "survived", "reorder", "independent declarations reordered", TS, "reorder of independent declarations"),
 (CU, "export function findCursor<", "throw new Error('fault: cursor.ts throws at import');\nexport function findCursor<", "inconclusive", "load", "module loads", TC, "module throws at import"),
 (CU, "export function findTextCursor(", "function findTextCursor(", "inconclusive", "export", "findTextCursor is exported", TC, "exported function removed while tests import it"),
]
