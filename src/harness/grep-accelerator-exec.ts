// interlinked-tdd: exempt
// ===========================================
// Grep Accelerator — matching / execution helpers
// ===========================================
// Leaf cluster split out of grep-accelerator.ts to keep the orchestrator
// under the per-file line cap. Holds the ReDoS-safe RegExp constructor, the
// in-process fixed-string matcher, the ripgrep executor + its binary
// resolver, and the file-grouped output compressor. Behavior is identical to
// when these lived in the parent module — code moved verbatim.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import type { GrepAcceleratorConfig } from "./grep-accelerator.js";

// ===========================================
// Safe RegExp construction (ReDoS mitigation)
// ===========================================

const MAX_PATTERN_LENGTH = 1000;

/**
 * Compile a RegExp with a length limit to mitigate ReDoS from agent-supplied
 * patterns. Returns null for an over-length source or any source the engine
 * rejects (so callers fall back to rg / decline rather than throw). Exported so
 * the ReDoS-cap and compile-failure behavior can be unit-tested directly.
 */
export function safeRegExp(source: string, flags: string): RegExp | null {
	if (source.length > MAX_PATTERN_LENGTH) return null;
	try {
		// Reason: this *is* the mitigation — length-capped above and wrapped
		// in try/catch. Callers must route patterns through this helper.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(source, flags);
	} catch {
		return null;
	}
}

// ===========================================
// In-Process Matching (small candidate sets)
// ===========================================

interface MatchOptions {
	pattern: string;
	candidates: string[];
	cwd: string;
	caseInsensitive: boolean;
	maxOutputLines: number;
}

/**
 * Content-mode in-process matcher for FIXED-STRING patterns: emits
 * `relPath:lineNum:line` for every match, the same shape native
 * `rg --with-filename --line-number` produces. `executeMatch` only routes here
 * for non-regex searches on small candidate sets, so the pattern is always a
 * literal (escaped to a regex) — there is no regex-passthrough or
 * files_with_matches / count branch. Reads disk directly: under the freshness
 * gate the working tree is clean so disk == index (the dirty-layer cache is
 * deliberately bypassed, closing the edit-then-revert-within-TTL window).
 */
export function matchInProcess(opts: MatchOptions): RipgrepResult | null {
	const { pattern, candidates, cwd, caseInsensitive, maxOutputLines } = opts;
	const flags = caseInsensitive ? "gi" : "g";
	const regex = safeRegExp(escapeRegex(pattern), flags);
	if (!regex) return null;

	const lines: string[] = [];
	let matchCount = 0;

	for (const relPath of candidates) {
		let content: string;
		try {
			content = readFileSync(join(cwd, relPath), "utf-8");
		} catch {
			continue;
		}

		const fileLines = content.split("\n");
		for (let lineNum = 0; lineNum < fileLines.length; lineNum++) {
			regex.lastIndex = 0;
			if (regex.test(nonNull(fileLines[lineNum]))) {
				matchCount++;
				// No per-file cap: the substitution must return the SAME matches as
				// native rg. Completeness is enforced by the caller's truncation
				// check (buildAcceleratedDecision declines if exceeded).
				lines.push(`${relPath}:${lineNum + 1}:${fileLines[lineNum]}`);
			}
		}
	}

	const truncated = lines.length > maxOutputLines;
	return {
		output: lines.slice(0, maxOutputLines).join("\n"),
		matchCount,
		truncated,
	};
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ===========================================
// Ripgrep Execution
// ===========================================

export interface RipgrepResult {
	output: string;
	matchCount: number;
	truncated: boolean;
}

export function runRipgrepOnCandidates(
	pattern: string,
	candidates: string[],
	cwd: string,
	isRegex: boolean,
	caseInsensitive: boolean,
	cfg: Required<GrepAcceleratorConfig>,
): RipgrepResult | null {
	// Find ripgrep binary
	const rgPath = findRipgrep();
	if (!rgPath) return null;

	// Content mode only: with line numbers, ALWAYS with the filename so a
	// single-candidate result still emits `path:line:content` (rg omits the path
	// for a lone file argument) — matching native recursive output. glob / -l / -c
	// searches never reach here (they decline at the eligibility gate). No per-file
	// cap: completeness is enforced by the caller's truncation check.
	const args: string[] = [
		"--no-heading",
		"--color=never",
		"--with-filename",
		"--line-number",
	];

	if (!isRegex) args.push("--fixed-strings");
	if (caseInsensitive) args.push("--ignore-case");

	// Add the pattern and candidate files
	args.push("--", pattern, ...candidates);

	// Use spawnSync instead of execSync: passes args directly (no shell, no
	// shellEscape needed), uses streaming I/O, and has ~2ms less overhead.
	const result = spawnSync(rgPath, args, {
		cwd,
		encoding: "utf-8",
		timeout: cfg.rgTimeout,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// rg exit code 1 = no matches (not an error)
	if (result.status === 1) {
		return { output: "", matchCount: 0, truncated: false };
	}
	// rg exit code 2+ or signal = error, fall through
	if (result.status !== 0 || result.error) {
		return null;
	}

	return processRgOutput(result.stdout, cfg.maxOutputLines);
}

function processRgOutput(output: string, maxLines: number): RipgrepResult {
	const lines = output.split("\n");
	const matchCount = lines.filter((l) => l.length > 0).length;

	if (lines.length > maxLines) {
		return {
			output: lines.slice(0, maxLines).join("\n"),
			matchCount,
			truncated: true,
		};
	}

	return { output: output.trimEnd(), matchCount, truncated: false };
}

// ===========================================
// Output Formatting
// ===========================================

/**
 * Compress rg-style output by grouping matches under file headers.
 *
 * Input (rg --no-heading format):
 *   src/foo.ts:10:export function bar()
 *   src/foo.ts:20:export function baz()
 *   src/other.ts:5:export function qux()
 *
 * Output (grouped):
 *   src/foo.ts
 *   10:export function bar()
 *   20:export function baz()
 *
 *   src/other.ts
 *   5:export function qux()
 *
 * For any non-content stream (no `path:line:` shape — e.g. an empty body or a
 * lone path), returns the input unchanged. Exported so the grouping behavior can
 * be unit-tested directly.
 */
export function compressGrepOutput(output: string): string {
	const lines = output.split("\n");

	// Detect if this is content mode (path:line:content).
	// files_with_matches and count modes don't have the triple-colon format.
	// Sample at first non-empty line.
	const firstNonEmpty = lines.findIndex((l) => l.length > 0);
	if (firstNonEmpty === -1) return output; // all blank → nothing to group

	// Content mode lines match: path:number:content
	// We need at least two colons where the second segment is a number.
	// The per-line parse below uses the SAME prefix (`path:number:`) plus a
	// trailing capture, so a line matches this detector iff it parses below —
	// which is why the first non-empty line always opens a group and the loop
	// never sees a non-parsing line before one exists.
	if (!nonNull(lines[firstNonEmpty]).match(/^(.+?):(\d+):/)) return output; // not content mode

	// One block of text per file, in first-seen order. A non-parsing line
	// (separator, etc.) is appended verbatim to the current (always-open) block.
	const blocks: { path: string; lines: string[] }[] = [];
	const indexByPath = new Map<string, number>();

	for (const line of lines.slice(firstNonEmpty)) {
		if (!line) continue;
		// Parse path:lineNum:rest — careful with paths containing colons (Windows, etc.)
		const m = line.match(/^(.+?):(\d+):(.*)/);
		if (!m) {
			// Non-parsing line: fold into the current block. The detector above
			// guarantees the first iterated line parses, so a block always exists.
			nonNull(blocks[blocks.length - 1]).lines.push(line);
			continue;
		}
		const filePath = nonNull(m[1]);
		const lineNum = nonNull(m[2]);
		const content = nonNull(m[3]);
		let idx = indexByPath.get(filePath);
		if (idx === undefined) {
			idx = blocks.length;
			indexByPath.set(filePath, idx);
			blocks.push({ path: filePath, lines: [] });
		}
		nonNull(blocks[idx]).lines.push(`${lineNum}:${content}`);
	}

	// `path` header then its rows, blocks separated by a blank line.
	return blocks.map((b) => [b.path, ...b.lines].join("\n")).join("\n\n");
}

// ===========================================
// Ripgrep binary resolution
// ===========================================

let _rgPath: string | null | undefined;

/** Find the ripgrep binary on PATH */
export function findRipgrep(): string | null {
	if (_rgPath !== undefined) return _rgPath;

	// Try common install locations first (avoids shell function resolution issues)
	const commonPaths = [
		"/opt/homebrew/bin/rg",
		"/usr/local/bin/rg",
		"/usr/bin/rg",
		`${process.env.HOME}/.cargo/bin/rg`,
	];
	for (const p of commonPaths) {
		try {
			if (existsSync(p)) {
				_rgPath = p;
				return _rgPath;
			}
		} catch (e) {
			void e;
		}
	}

	// Fall back to PATH lookup (works when rg is a real binary, not a shell function)
	try {
		const found = execSync("which rg 2>/dev/null || command -v rg 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
			shell: "/bin/sh",
		}).trim();
		if (found && !found.includes("\n") && !found.includes("function")) {
			_rgPath = found;
			return _rgPath;
		}
	} catch (e) {
		void e;
	}

	_rgPath = null;
	return _rgPath;
}

/** Reset cached rg path (for testing) */
export function _resetRgPathCache(): void {
	_rgPath = undefined;
}
