// ============================================================
// Cloudflare D1 footgun detectors
// ============================================================
// SQL-injection class: `env.DB.exec(string)` with interpolated
// user input is one of the highest-severity Workers bugs.
// The safe form is `db.prepare(literal).bind(params).run()`.

import type { InlineMatch } from "../checks/shared.js";
import { collectRegexLineMatches, shouldSkipFootgunScan } from "./scan-helpers.js";
import type { LibraryFootgunCheck } from "./types.js";

// Match `<binding>.exec(...)` where the argument is a template literal
// with `${...}` interpolation, or a string with `+` concat.
const D1_EXEC_INTERPOLATED_RE =
	/\b(?:DB|D1|env\.\w+|env\[[^\]]+\])\s*\.\s*exec\s*\(\s*(`[^`]*\$\{[^`]*`|"[^"]*"\s*\+|'[^']*'\s*\+)/g;

function detectExecStringConcat(content: string, filePath: string): InlineMatch[] {
	if (shouldSkipFootgunScan(filePath, content)) return [];
	return collectRegexLineMatches(content, D1_EXEC_INTERPOLATED_RE);
}

export const D1_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "d1_exec_string_concat",
		name: "D1 exec() with interpolated SQL",
		library: "d1",
		detect: detectExecStringConcat,
		fixInstruction:
			"`db.exec(`...${userInput}...`)` is SQL injection. Use the prepared-statement form: `await db.prepare('SELECT * FROM x WHERE id = ?').bind(userInput).run()`. The `?` placeholder + `.bind()` keeps SQL and data separate.",
	},
];
