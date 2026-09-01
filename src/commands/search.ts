// ===========================================
// interlinked search — Local codebase search
// ===========================================
// Smart multi-term search: splits natural language queries into terms,
// searches for any term match, then ranks files by term density.
// Hybrid engine: ripgrep (if available) with Node.js fs fallback.
// Zero external dependencies — uses child_process for rg, native fs for fallback.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import {
	buildOrPattern,
	escapeRegex,
	globToRegex,
	isMultiTermQuery,
	rankFilesByTermDensity,
	type SearchMatch,
	type SearchResult,
	splitQueryTerms,
} from "./search-query.js";
import { renderFull, renderNormal } from "./search-render.js";

// ===========================================
// Config
// ===========================================

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const CONTEXT_LINES = 2;

/** File extensions to search (when using native fallback) */
const SEARCHABLE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".toml",
	".sh",
	".bash",
	".zsh",
	".sql",
	".html",
	".css",
	".svelte",
	".vue",
	".rb",
	".php",
	".swift",
	".kt",
]);

/** Directories to always skip */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"venv",
	"target",
	".tmp",
	"coverage",
	".interlinked",
	"playwright-report",
]);

// ===========================================
// Ripgrep engine
// ===========================================

function hasRipgrep(): boolean {
	const result = spawnSync("rg", ["--version"], { stdio: "pipe", timeout: 3000 });
	return result.status === 0;
}

// ---- rg --json message parsing (boundary) --------------------------------
// `rg --json` emits one JSON object per line; this command only reads the
// "match" / "context" / "summary" message kinds (others, e.g. "begin"/"end",
// are ignored). Each parser returns null on a shape it doesn't recognize so
// the caller can skip that line rather than reading `undefined`/wrong-typed
// fields through an unchecked cast.

interface RipgrepMatchData {
	path: string;
	lineNumber: number;
	text: string;
	submatchStart: number | undefined;
}

interface RipgrepContextData {
	path: string;
	lineNumber: number;
	text: string;
}

function parseRipgrepPathText(value: unknown): string | null {
	if (!isJsonObject(value)) return null;
	return typeof value.text === "string" ? value.text : null;
}

function parseRipgrepMatch(value: unknown): RipgrepMatchData | null {
	if (!isJsonObject(value)) return null;
	const data = value.data;
	if (!isJsonObject(data)) return null;
	const path = parseRipgrepPathText(data.path);
	if (path === null) return null;
	const lineNumber = data.line_number;
	if (typeof lineNumber !== "number") return null;
	const lines = data.lines;
	if (!isJsonObject(lines) || typeof lines.text !== "string") return null;
	const submatches = data.submatches;
	let submatchStart: number | undefined;
	if (Array.isArray(submatches)) {
		const first: unknown = submatches[0];
		if (isJsonObject(first) && typeof first.start === "number") {
			submatchStart = first.start;
		}
	}
	return { path, lineNumber, text: lines.text, submatchStart };
}

function parseRipgrepContext(value: unknown): RipgrepContextData | null {
	if (!isJsonObject(value)) return null;
	const data = value.data;
	if (!isJsonObject(data)) return null;
	const path = parseRipgrepPathText(data.path);
	if (path === null) return null;
	const lineNumber = data.line_number;
	if (typeof lineNumber !== "number") return null;
	const lines = data.lines;
	if (!isJsonObject(lines) || typeof lines.text !== "string") return null;
	return { path, lineNumber, text: lines.text };
}

/** `summary.data.stats.searches`, or 0 for a missing/malformed field —
 *  matches the original `?? 0` default for an absent stats block. */
function parseRipgrepSearchedFiles(value: unknown): number {
	if (!isJsonObject(value)) return 0;
	const data = value.data;
	if (!isJsonObject(data)) return 0;
	const stats = data.stats;
	if (!isJsonObject(stats)) return 0;
	return typeof stats.searches === "number" ? stats.searches : 0;
}

// SAFETY: @types/node types spawnSync's `stdout` as non-nullable `Buffer`,
// but it is actually `null` when the child fails to spawn (e.g. `rg`
// missing from PATH — `result.error` is set in that case). This helper's
// parameter type is the honest one; callers pass the raw spawnSync result.
function ripgrepStdoutLines(result: { stdout: Buffer | null }): string[] {
	return result.stdout ? result.stdout.toString("utf-8").split("\n").filter(Boolean) : [];
}

/** Parses ripgrep `--json` lines into matches + the searched-file count. */
function processRipgrepLines(
	lines: string[],
	dir: string,
	opts: { context: number },
): { matches: SearchMatch[]; searchedFiles: number } {
	const matches: SearchMatch[] = [];
	let searchedFiles = 0;
	// Accumulate leading context lines that appear before the next match
	let pendingContext: string[] = [];

	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (_) {
			/* intentional: ripgrep emits only well-formed JSON; skip on unexpected line */
			continue;
		}
		if (!isJsonObject(parsed)) continue;

		if (parsed.type === "match") {
			const m = parseRipgrepMatch(parsed);
			if (!m) continue;
			matches.push({
				file: relative(dir, m.path),
				line: m.lineNumber,
				column: m.submatchStart,
				text: m.text.replace(/\n$/, ""),
				context_before: pendingContext.length > 0 ? pendingContext : undefined,
				context_after: [],
			});
			pendingContext = [];
		} else if (parsed.type === "context") {
			const ctx = parseRipgrepContext(parsed);
			if (!ctx) continue;
			const text = ctx.text.replace(/\n$/, "");
			const ctxFile = relative(dir, ctx.path);
			const last = matches[matches.length - 1];
			// Trailing context: same file, line immediately after match (within context window)
			if (
				last &&
				ctxFile === last.file &&
				ctx.lineNumber > last.line &&
				ctx.lineNumber <= last.line + opts.context
			) {
				if (!last.context_after) last.context_after = [];
				last.context_after.push(text);
			} else {
				// Leading context for the next match (different file, or gap > context window)
				pendingContext.push(text);
			}
		} else if (parsed.type === "summary") {
			searchedFiles = parseRipgrepSearchedFiles(parsed);
		}
	}
	return { matches, searchedFiles };
}

function searchWithRipgrep(
	query: string,
	dir: string,
	opts: { limit: number; glob?: string | undefined; type?: string | undefined; context: number },
): SearchResult {
	const start = performance.now();
	const args = [
		"--json",
		"--max-count",
		String(opts.limit * 2), // over-fetch for dedup
		"-C",
		String(opts.context),
		"--smart-case",
	];

	if (opts.glob) {
		args.push("--glob", opts.glob);
	}
	if (opts.type) {
		args.push("--type", opts.type);
	}

	args.push("--", query, dir);

	const result = spawnSync("rg", args, {
		stdio: "pipe",
		timeout: 30000,
		maxBuffer: 10 * 1024 * 1024,
	});

	const lines = ripgrepStdoutLines(result);
	const { matches, searchedFiles } = processRipgrepLines(lines, dir, opts);

	const elapsed = performance.now() - start;
	const truncated = matches.length > opts.limit;
	const trimmed = matches.slice(0, opts.limit);

	return {
		query,
		engine: "ripgrep",
		matches: trimmed,
		total: matches.length,
		truncated,
		searched_files: searchedFiles,
		elapsed_ms: Math.round(elapsed),
	};
}

// ===========================================
// Native Node.js fallback engine
// ===========================================

function collectFiles(dir: string, root: string, result: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		if (entry.startsWith(".") && entry !== ".") continue;

		const fullPath = join(dir, entry);
		let stat;
		try {
			stat = statSync(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			collectFiles(fullPath, root, result);
		} else if (stat.isFile()) {
			const ext = extname(entry).toLowerCase();
			if (SEARCHABLE_EXTENSIONS.has(ext) && stat.size < 1024 * 1024) {
				result.push(fullPath);
			}
		}
	}
}

/** Slices `context` lines before and after the match index for display context. */
function sliceContextWindow(
	lines: string[],
	matchIdx: number,
	context: number,
): { before: string[]; after: string[] } {
	const beforeStart = Math.max(0, matchIdx - context);
	const afterEnd = Math.min(lines.length, matchIdx + context + 1);
	return {
		before: lines.slice(beforeStart, matchIdx),
		after: lines.slice(matchIdx + 1, afterEnd),
	};
}

function searchWithNative(
	query: string,
	dir: string,
	opts: { limit: number; glob?: string | undefined; context: number },
): SearchResult {
	const start = performance.now();
	const matches: SearchMatch[] = [];
	let searchedFiles = 0;

	// Case-insensitive if query is all lowercase
	const isSmartCase = query === query.toLowerCase();
	// If query contains | (OR pattern from multi-term), don't escape it
	const isOrPattern = query.includes("|") && !query.includes("\\|");
	const pattern = isOrPattern ? query : escapeRegex(query);
	let regex: RegExp;
	try {
		// Reason: local-CLI grep against the user's own working tree — the
		// query is their own input; no remote attacker surface.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		regex = new RegExp(pattern, isSmartCase ? "gi" : "g");
	} catch {
		// Reason: fallback path compiles the escape-regex'd literal query —
		// no unsafe metacharacters reach the engine.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		regex = new RegExp(escapeRegex(query), "gi");
	}

	const globPattern = opts.glob ? globToRegex(opts.glob) : null;

	const allFiles: string[] = [];
	collectFiles(dir, dir, allFiles);

	for (const filePath of allFiles) {
		const relPath = relative(dir, filePath);

		// Apply glob filter
		if (globPattern && !globPattern.test(relPath)) continue;

		searchedFiles++;
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const lineText = nonNull(lines[i]);
			if (regex.test(lineText)) {
				regex.lastIndex = 0; // Reset for next test
				const { before, after } = sliceContextWindow(lines, i, opts.context);

				matches.push({
					file: relPath,
					line: i + 1,
					text: lineText,
					context_before: before.length > 0 ? before : undefined,
					context_after: after.length > 0 ? after : undefined,
				});

				if (matches.length >= opts.limit * 2) break;
			}
		}

		if (matches.length >= opts.limit * 2) break;
	}

	const elapsed = performance.now() - start;
	const truncated = matches.length > opts.limit;
	const trimmed = matches.slice(0, opts.limit);

	return {
		query,
		engine: "native",
		matches: trimmed,
		total: matches.length,
		truncated,
		searched_files: searchedFiles,
		elapsed_ms: Math.round(elapsed),
	};
}

// ===========================================
// Command
// ===========================================

export function searchCommand(
	query: string,
	opts: {
		path?: string;
		glob?: string;
		type?: string;
		limit?: string;
		context?: string;
		engine?: string;
		json?: boolean;
		short?: boolean;
		full?: boolean;
	},
): void {
	const mode = getOutputMode(opts);

	if (!query || query.trim().length === 0) {
		outputError(mode, "Search query is required");
		return;
	}

	const dir = opts.path || process.cwd();
	const limit = Math.min(
		Math.max(1, Number.parseInt(opts.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
		MAX_LIMIT,
	);
	const context = Math.min(
		Math.max(0, Number.parseInt(opts.context || String(CONTEXT_LINES), 10) || CONTEXT_LINES),
		10,
	);

	// Choose engine
	const useRipgrep = opts.engine !== "native" && hasRipgrep();
	if (opts.engine === "ripgrep" && !useRipgrep) {
		outputError(mode, "ripgrep (rg) not found. Install it or use --engine=native");
		return;
	}

	// Smart multi-term search: split natural language queries into OR pattern
	const multiTerm = isMultiTermQuery(query);
	const terms = multiTerm ? splitQueryTerms(query) : [query];
	const searchQuery = multiTerm ? buildOrPattern(terms) : query;

	let result: SearchResult;
	if (useRipgrep) {
		result = searchWithRipgrep(searchQuery, dir, {
			limit,
			glob: opts.glob,
			type: opts.type,
			context,
		});
		// Override the query in results for display (show original, not regex)
		result.query = query;
	} else {
		result = searchWithNative(searchQuery, dir, { limit, glob: opts.glob, context });
		result.query = query;
	}

	// For multi-term queries, rank files by term density
	const rankings =
		multiTerm && result.matches.length > 0
			? rankFilesByTermDensity(result.matches, terms)
			: undefined;

	output(
		mode,
		{ ...result, rankings },
		{
			json: () => ({ ...result, rankings }),
			short: () =>
				result.matches.length === 0
					? "No matches"
					: `${result.total} match${result.total !== 1 ? "es" : ""} in ${result.searched_files} files (${result.engine}, ${result.elapsed_ms}ms)`,
			normal: () => renderNormal(result, rankings),
			full: () => renderFull(result, rankings),
		},
	);
}
