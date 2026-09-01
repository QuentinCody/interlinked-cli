// UBS language-specific detectors — Python temporal-correctness checks.
// A distinct bug CLASS from the security-focused siblings: timezone-naive
// datetime construction is the classic source of "works on my machine, wrong in
// prod / wrong for other users" defects. Ext-gated to .py / .pyi; returns
// InlineMatch[]. Kept in its own file (python-checks.ts is at the line cap and
// this is a cohesive new class).

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "../shared.js";
import { isPyFile, MATCH_LIMIT } from "./_shared.js";

/**
 * Detect timezone-naive `datetime` construction:
 *   - `datetime.utcnow()` / `datetime.utcfromtimestamp(...)` — naive AND
 *     deprecated since Python 3.12 (they return a naive datetime that LOOKS
 *     like UTC, the #1 tz footgun).
 *   - `datetime.now()` with EMPTY parens — naive local time. `datetime.now(tz)`
 *     / `datetime.now(timezone.utc)` is correct and NOT flagged.
 *
 * Operates on comment/string-stripped content (these are method calls, not
 * string literals). Test files are skipped (fixed naive datetimes are idiomatic
 * in tests). `# noqa` on the call line suppresses. Heuristic → advisory.
 */
export function checkNaiveDatetime(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Either a naive+deprecated utc helper, or `datetime.now()` with no tz arg.
	const re = /\bdatetime\.(?:utcnow|utcfromtimestamp)\s*\(|\bdatetime\.now\s*\(\s*\)/g;
	for (const m of stripped.matchAll(re)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_naive_datetime")) {
			continue;
		}
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}
