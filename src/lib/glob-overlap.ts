// ===========================================
// Glob Overlap — Local port of server's patternsOverlap()
// ===========================================
// Used for offline reservation conflict checking against cached reservations.
// Ported from src/utils/glob.ts to avoid importing server code.

/**
 * Check if two glob patterns potentially overlap.
 * Used to determine if a file path conflicts with a reservation pattern.
 *
 * @param pattern1 First glob pattern (or file path)
 * @param pattern2 Second glob pattern (or reservation pattern)
 * @param ignoreCase Whether to ignore case (macOS/Windows default)
 */
export function patternsOverlap(pattern1: string, pattern2: string, ignoreCase = false): boolean {
	const p1 = ignoreCase ? pattern1.toLowerCase() : pattern1;
	const p2 = ignoreCase ? pattern2.toLowerCase() : pattern2;

	if (p1 === p2) return true;

	const p1Parts = p1.split("/");
	const p2Parts = p2.split("/");
	const minLen = Math.min(p1Parts.length, p2Parts.length);

	for (let i = 0; i < minLen; i++) {
		const part1 = p1Parts[i];
		const part2 = p2Parts[i];
		if (part1 === undefined || part2 === undefined) continue;

		const verdict = segmentOverlapVerdict(part1, part2, ignoreCase);
		if (verdict === "overlap-all") return true;
		if (verdict === "diverge") return false;
		// verdict === "continue" falls through to the next path segment
	}

	return true;
}

/**
 * Compare one path segment pair and decide how the outer scan should react.
 * - "overlap-all": either side is "**" — the whole comparison overlaps
 * - "continue": this segment doesn't rule out overlap; keep scanning
 * - "diverge": this segment proves the patterns don't overlap
 */
function segmentOverlapVerdict(
	part1: string,
	part2: string,
	ignoreCase: boolean,
): "overlap-all" | "continue" | "diverge" {
	// ** matches any number of directories
	if (part1 === "**" || part2 === "**") {
		return "overlap-all";
	}

	// * matches within a single path segment
	if (part1 === "*" || part2 === "*") {
		return "continue";
	}

	// Glob pattern in part (e.g., *.ts, test_*).
	if ((part1.includes("*") || part2.includes("*")) && globPartsOverlap(part1, part2, ignoreCase)) {
		return "continue";
	}

	return part1 === part2 ? "continue" : "diverge";
}

/**
 * Test whether two glob-bearing path segments (each containing at least one
 * "*") match one another via RegExp.
 * The glob parts are first escaped by replacing "*" with ".*", so the
 * dynamic RegExp input is constrained to a known shape and is safe.
 */
function globPartsOverlap(part1: string, part2: string, ignoreCase: boolean): boolean {
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	const regex1 = new RegExp(`^${part1.replace(/\*/g, ".*")}$`, ignoreCase ? "i" : "");
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	const regex2 = new RegExp(`^${part2.replace(/\*/g, ".*")}$`, ignoreCase ? "i" : "");
	return regex1.test(part2) || regex2.test(part1);
}

/**
 * Check if a file path matches any of the given reservation patterns.
 * Returns the first matching pattern, or null if no match.
 */
export function findOverlappingPattern(
	filePath: string,
	patterns: string[],
	ignoreCase = false,
): string | null {
	for (const pattern of patterns) {
		if (patternsOverlap(filePath, pattern, ignoreCase)) {
			return pattern;
		}
	}
	return null;
}
