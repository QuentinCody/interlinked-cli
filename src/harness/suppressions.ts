// ===========================================
// Suggestion Suppressions — inline comments + JSON file
// ===========================================
// Agents and humans can suppress heuristic findings via:
//   1. Inline comments: // interlinked-ignore: check-name — reason
//   2. JSON file: .interlinked/verify-suppressions.json
//
// Suppressions always win over scoring — a suppressed finding is never shown,
// even if it would score above the threshold.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";

// ===========================================
// Types
// ===========================================

/** Map from 1-based line number to set of check names suppressed on that line */
export type InlineSuppressions = Map<number, Set<string>>;

/** Set of check names suppressed at file level (from JSON file) */
export type FileSuppressions = Set<string>;

interface SuppressionEntry {
	reason: string;
	by: string;
	at: string;
	line?: number;
}

// Every read site casts an unvalidated `JSON.parse` of a user-editable
// on-disk config (`.interlinked/verify-suppressions.json`) to this type, so a
// hand-edited file can genuinely have a `null`/missing entry for a path
// despite the index signature claiming otherwise — kept honestly nullable.
interface SuppressionFile {
	[filePath: string]:
		| {
				[checkName: string]: SuppressionEntry;
		  }
		| null
		| undefined;
}

// ===========================================
// Inline comment parsing
// ===========================================

const IGNORE_PATTERN = /^\s*\/\/\s*interlinked-ignore:\s*(.+)/;

/**
 * Scan source content for `// interlinked-ignore: <check-name>` comments.
 * Returns a map from the NEXT non-comment line number to the set of suppressed checks.
 *
 * Supports:
 *   // interlinked-ignore: sql-injection
 *   // interlinked-ignore: sql-injection — reason text
 *   // interlinked-ignore: sql-injection, silent-catch
 */
export function scanInlineSuppressions(content: string): InlineSuppressions {
	const lines = content.split("\n");
	const result: InlineSuppressions = new Map();

	for (let i = 0; i < lines.length; i++) {
		const match = IGNORE_PATTERN.exec(nonNull(lines[i]));
		if (!match) continue;

		// Extract check names: split on comma, strip reason after — or --
		const raw = nonNull(nonNull(match[1]).split(/\s+[—–-]{1,3}\s+/)[0]);
		const checks = raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (checks.length === 0) continue;

		// Find the next non-empty, non-comment line
		let targetLine = i + 2; // default: next line (1-based)
		for (let j = i + 1; j < lines.length; j++) {
			const trimmed = nonNull(lines[j]).trim();
			if (trimmed && !trimmed.startsWith("//")) {
				targetLine = j + 1; // 1-based
				break;
			}
		}

		const existing = result.get(targetLine) || new Set();
		for (const check of checks) existing.add(check);
		result.set(targetLine, existing);
	}

	return result;
}

// ===========================================
// Inline deferrals — `// interlinked: defer <check>` / `# interlinked: defer <check>`
// ===========================================
//
// Distinct from `interlinked-ignore`:
//   - `interlinked-ignore` SUPPRESSES the finding entirely (never surfaces)
//   - `interlinked: defer`  ACKNOWLEDGES the finding (still logged, but
//     amplification machinery treats it as "seen, intentionally not fixed
//     this turn"). The agent uses defer to acknowledge a pre-existing
//     finding in a touched file without scope-creep refactor pressure;
//     unaddressed findings without defer keep escalating per
//     `[[feedback_recurring_warnings_amplify_not_silence]]`.
//
// Cross-language: matches both `//`- and `#`-comment shapes so Python,
// Ruby, shell, and YAML defer markers all work.

/** Map line-number → (check-name → optional reason). Reason is null when
 *  the agent declined to provide one; the marker still suppresses
 *  amplification but the empty-reason form is loud audit signal — agents
 *  that defer findings without explanation flag themselves. */
export type InlineDeferrals = Map<number, Map<string, string | null>>;

/** Matches either `// interlinked: defer ...` or `# interlinked: defer ...`. */
const DEFER_PATTERN = /^\s*(?:\/\/|#)\s*interlinked:\s*defer\s+(.+)/;
/** Matches the same shape but as a trailing comment on a non-comment line. */
const TRAILING_DEFER_PATTERN = /(?:\/\/|#)\s*interlinked:\s*defer\s+(.+)$/;

/**
 * Scan source content for `// interlinked: defer <check>` and
 * `# interlinked: defer <check>` markers. Returns a map from line number
 * (1-based) to a map of check-name → reason.
 *
 * Two valid placements:
 *   1. **Marker above offending line** (matches `scanInlineSuppressions`):
 *        // interlinked: defer pickle-untrusted-load -- legacy trusted RPC
 *        obj = pickle.load(f)
 *   2. **Trailing same-line marker** (more compact, universal across languages):
 *        obj = pickle.load(f)  # interlinked: defer pickle-untrusted-load
 */
export function scanInlineDeferrals(content: string): InlineDeferrals {
	const lines = content.split("\n");
	const result: InlineDeferrals = new Map();

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);

		// Trailing form: marker on the SAME line as the offending code. The
		// line itself is the target.
		const trimmed = line.trim();
		const isCommentOnly = trimmed.startsWith("//") || trimmed.startsWith("#");
		if (!isCommentOnly) {
			const trailing = TRAILING_DEFER_PATTERN.exec(line);
			if (trailing) {
				recordDeferral(result, i + 1, nonNull(trailing[1]));
			}
			continue;
		}

		// Marker-on-own-line form: applies to the next non-comment line.
		const above = DEFER_PATTERN.exec(line);
		if (!above) continue;
		let targetLine = i + 2; // default if no following line
		for (let j = i + 1; j < lines.length; j++) {
			const next = nonNull(lines[j]).trim();
			if (next && !next.startsWith("//") && !next.startsWith("#")) {
				targetLine = j + 1;
				break;
			}
		}
		recordDeferral(result, targetLine, nonNull(above[1]));
	}

	return result;
}

/** Parse "<check1>, <check2> -- reason text" into an entry on `result`. */
function recordDeferral(result: InlineDeferrals, line: number, raw: string): void {
	const dashSplit = raw.split(/\s+[—–-]{1,3}\s+/);
	const checksRaw = nonNull(dashSplit[0]);
	const reason = dashSplit[1]?.trim() ?? null;
	const checks = checksRaw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (checks.length === 0) return;
	let existing = result.get(line);
	if (!existing) {
		existing = new Map();
		result.set(line, existing);
	}
	for (const check of checks) {
		// Last-write-wins on duplicate (check, line) pairs — the more
		// specific reason (from the later marker) is kept.
		existing.set(check, reason);
	}
}

// ===========================================
// JSON file loading
// ===========================================

/** Cached parse of verify-suppressions.json keyed on file mtime. The
 *  scored-suggestions PostToolUse path calls `loadFileSuppressions` twice
 *  per event (once for structural checks, once for the scored-findings
 *  pipeline), and on a quiet daemon the file rarely changes. Reparsing
 *  the JSON on every call wastes both syscalls and CPU; mtime keying
 *  means we only re-parse when the file actually changes on disk. */
interface SuppressionFileCache {
	mtimeMs: number;
	data: SuppressionFile;
}
let suppressionFileCache: { path: string; cache: SuppressionFileCache } | null = null;

/**
 * Load .interlinked/verify-suppressions.json and return suppressions for a
 * specific file path (relative). Supports glob patterns in keys.
 * Returns empty Set on any error.
 */
export function loadFileSuppressions(
	interlinkedDir: string,
	relativeFilePath: string,
): FileSuppressions {
	try {
		const filePath = join(interlinkedDir, "verify-suppressions.json");
		if (!existsSync(filePath)) return new Set();
		const mtimeMs = statSync(filePath).mtimeMs;
		let data: SuppressionFile;
		if (
			suppressionFileCache !== null &&
			suppressionFileCache.path === filePath &&
			suppressionFileCache.cache.mtimeMs === mtimeMs
		) {
			data = suppressionFileCache.cache.data;
		} else {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as SuppressionFile;
			suppressionFileCache = { path: filePath, cache: { mtimeMs, data } };
		}
		const checks = new Set<string>();

		for (const [pattern, entry] of Object.entries(data)) {
			if (!entry) continue;
			if (suppressionPatternMatches(pattern, relativeFilePath)) {
				for (const check of Object.keys(entry)) checks.add(check);
			}
		}

		return checks;
	} catch {
		return new Set();
	}
}

/**
 * Test whether `pattern` applies to `relativeFilePath`. Exact match always
 * wins; otherwise, any `*`/`?` triggers glob matching.
 */
function suppressionPatternMatches(pattern: string, relativeFilePath: string): boolean {
	if (pattern === relativeFilePath) return true;
	if (pattern.includes("*") || pattern.includes("?")) {
		return simpleGlobMatch(pattern, relativeFilePath);
	}
	return false;
}

/**
 * Simple glob matching for suppression patterns.
 * Supports: ** (any path segments), * (single segment), ? (single char)
 */
const REGEX_META_CHARS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function simpleGlobMatch(pattern: string, filePath: string): boolean {
	// Normalize separators
	const p = pattern.replace(/\\/g, "/");
	const f = filePath.replace(/\\/g, "/");

	// Convert glob to regex
	let regex = "^";
	let i = 0;
	while (i < p.length) {
		if (p[i] === "*" && p[i + 1] === "*") {
			// ** matches any number of path segments
			regex += ".*";
			i += 2;
			if (p[i] === "/") i++; // skip trailing /
		} else if (p[i] === "*") {
			// * matches anything except /
			regex += "[^/]*";
			i++;
		} else if (p[i] === "?") {
			regex += "[^/]";
			i++;
		} else if (REGEX_META_CHARS.has(nonNull(p[i]))) {
			regex += `\\${p[i]}`;
			i++;
		} else {
			regex += p[i];
			i++;
		}
	}
	regex += "$";

	try {
		// Reason: `regex` is built above by escaping glob metachars into
		// bounded regex equivalents; source is the suppression config file.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(regex).test(f);
	} catch {
		return false;
	}
}

/**
 * Load the full suppression file (for audit/telemetry).
 */
export function loadSuppressionFile(interlinkedDir: string): SuppressionFile {
	try {
		const filePath = join(interlinkedDir, "verify-suppressions.json");
		if (!existsSync(filePath)) return {};
		return JSON.parse(readFileSync(filePath, "utf-8")) as SuppressionFile;
	} catch {
		return {};
	}
}

// ===========================================
// Suppression check
// ===========================================

/**
 * Check if a finding at a specific line is suppressed by either inline
 * comments or file-level JSON suppressions.
 */
export function isSuppressed(
	checkName: string,
	line: number,
	inlineSuppressions: InlineSuppressions,
	fileSuppressions: FileSuppressions,
): boolean {
	// File-level suppression (applies to entire file)
	if (fileSuppressions.has(checkName)) return true;

	// Inline suppression — check exact line and 1-2 lines nearby
	// (the ignore comment may not perfectly align with the finding)
	for (let offset = -1; offset <= 1; offset++) {
		const checks = inlineSuppressions.get(line + offset);
		if (checks?.has(checkName)) return true;
	}

	return false;
}

// ===========================================
// Adding suppressions via CLI
// ===========================================

/**
 * Parse a suppression entry string in the format "file:check" or "file:check:reason".
 * Returns null if the format is invalid.
 */
export function parseSuppressionEntry(
	entry: string,
): { file: string; check: string; reason: string } | null {
	// Split on ":" but be careful with Windows paths (C:\...) and colons in reasons
	// Format: file:check or file:check:reason
	const parts = entry.split(":");
	if (parts.length < 2) return null;

	const file = parts[0];
	const check = parts[1];
	const reason = parts.length > 2 ? parts.slice(2).join(":") : "";

	if (!file || !check) return null;

	return { file, check, reason: reason.trim() };
}

/**
 * Add one or more suppressions to .interlinked/verify-suppressions.json.
 * Creates the file and directory if they don't exist.
 * Returns the list of entries that were added.
 */
export function addSuppressions(
	interlinkedDir: string,
	entries: Array<{ file: string; check: string; reason: string }>,
): Array<{ file: string; check: string; reason: string }> {
	const filePath = join(interlinkedDir, "verify-suppressions.json");

	// Load existing data
	let data: SuppressionFile = {};
	try {
		if (existsSync(filePath)) {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as SuppressionFile;
		}
	} catch {
		data = {};
	}

	const added: Array<{ file: string; check: string; reason: string }> = [];
	const now = new Date().toISOString();

	for (const entry of entries) {
		const fileEntries = (data[entry.file] ??= {});
		// Only add if not already present
		if (!fileEntries[entry.check]) {
			fileEntries[entry.check] = {
				reason: entry.reason || "suppressed via CLI",
				by: "cli",
				at: now,
			};
			added.push(entry);
		}
	}

	// Ensure the directory exists
	if (!existsSync(interlinkedDir)) {
		mkdirSync(interlinkedDir, { recursive: true });
	}

	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	return added;
}
