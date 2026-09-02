// ===========================================
// `ubs_archive_extract_traversal` — unsanitized archive extraction (zip-slip)
// ===========================================
// Extracting a tar/zip archive without validating member paths lets a crafted
// entry (`../../etc/cron.d/x`) write OUTSIDE the target directory — the "zip
// slip" / CVE-2007-4559 class. Python `tarfile.extractall()` was the canonical
// case (fixed in 3.12 by the `filter=` argument); `zipfile.extractall()` has no
// built-in guard; Node's `tar.x` / adm-zip `extractAllTo` need explicit path
// checks. High-signal, low-FP (the unguarded call IS the smell), so pre_warn.
//
// Mined from Dicklesworthstone's ultimate_bug_scanner (DW test-adoption P0.5
// class-breadth, 2026-07-17). Deterministic regex over the comment/string-
// stripped view; test files are exempt (fixtures extract throwaway archives).

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "./shared.js";

/** Python `.extractall(...)`. When the call carries a `filter=` argument (the
 *  3.12+ sanitizer) it is considered guarded and NOT flagged. */
const PY_EXTRACTALL_RE = /\.extractall\s*\(/;
/** Node archive extractors: `tar.x(` / `tar.extract(` (node-tar) and
 *  `.extractAllTo(` (adm-zip). No built-in path guard on these shapes. */
const NODE_EXTRACT_RE = /\btar\s*\.\s*(?:x|extract)\s*\(|\.extractAllTo\s*\(/;

/**
 * Flag an archive extraction with no member-path sanitizer (zip-slip). Python
 * `.extractall()` without `filter=`; Node `tar.x`/`tar.extract`/adm-zip
 * `extractAllTo`. Scans the strings/comments-blanked view so a mention in a
 * docstring or string literal never fires.
 */
export function checkArchiveExtractTraversal(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	const isPy = ext === ".py";
	const isJs = isSupportedJsExtension(ext);
	if (!isPy && !isJs) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length && matches.length < 10; i++) {
		const line = strippedLines[i] ?? "";
		const pyHit = isPy && PY_EXTRACTALL_RE.test(line) && !/\bfilter\s*=/.test(line);
		const jsHit = isJs && NODE_EXTRACT_RE.test(line);
		if (pyHit || jsHit) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/** JS/TS source extensions the Node extractor patterns apply to. */
function isSupportedJsExtension(ext: string): boolean {
	return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cts" || ext === ".mts" || ext === ".cjs";
}
