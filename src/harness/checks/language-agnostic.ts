// Language-agnostic checks: binary content, empty file, console/debug.
// Extracted from generic-checks.ts. (The per-file line cap moved to
// harness/large-file-policy.ts — the single source of truth for file size.)

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isScriptOrCliPath,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Language-Agnostic Checks
// ===========================================

/**
 * Check if content contains null bytes, indicating binary data.
 * Agents should never write binary files through text editing tools.
 */
export function checkBinaryContent(content: string): boolean {
	return content.includes("\x00");
}

/** Where the raw NUL bytes are — so the binary_content error is actionable
 *  (the byte is invisible in editors; without a position agents re-edit the
 *  file blind and the error repeats on every touch). */
export interface BinaryContentLocation {
	/** Total raw NUL bytes in the content. */
	count: number;
	/** 1-based line of the first NUL. */
	line: number;
	/** 1-based column of the first NUL. */
	column: number;
}

/** Locate raw NUL bytes; null when the content is clean. charCode-based so
 *  this file never needs its own NUL literal beyond the detector above. */
export function locateBinaryContent(content: string): BinaryContentLocation | null {
	let count = 0;
	let firstLine = 0;
	let firstColumn = 0;
	let line = 1;
	let column = 1;
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code === 0) {
			count++;
			if (count === 1) {
				firstLine = line;
				firstColumn = column;
			}
		}
		if (code === 10) {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return count === 0 ? null : { count, line: firstLine, column: firstColumn };
}

/**
 * Check if the file is empty (only whitespace).
 * An empty file is usually a mistake — the agent likely intended to write content.
 */
export function checkEmptyFile(content: string): boolean {
	return content.trim().length === 0;
}

/**
 * Detect debug/logging statements left in code.
 * Language is inferred from file extension. Test files are skipped.
 *
 * Supported languages:
 * - JS/TS: `console.log(`, `console.debug(`, `debugger;`
 * - Python: `print(`, `breakpoint()`, `pdb.set_trace()`
 * - Rust: `dbg!(`
 * - Go: `fmt.Println(` (only if not in `_test.go`)
 * - C/C++: `printf(` (heuristic, skips files named `main.*`)
 */
export function checkConsoleDebug(content: string, filePath: string): InlineMatch[] {
	if (isConsoleDebugExempt(filePath, content)) return [];

	const ext = getExtension(filePath);
	const fileName = filePath.split(/[/\\]/).pop() || "";
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = consoleDebugPatternFor(ext, fileName, normalized, content);
	if (!pattern) return [];

	// Strip comments and strings to avoid false positives from commented-out
	// or string-embedded debug statements
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, pattern, 10);
}

/**
 * Whole-file exemptions for {@link checkConsoleDebug}: files where console/debug
 * output is either not scanned (tests) or IS the file's legitimate output
 * mechanism (CLI entry points, scripts, server/eval/worker code), so a fired
 * pattern would be a false positive regardless of language.
 */
function isConsoleDebugExempt(filePath: string, content: string): boolean {
	if (isTestFile(filePath)) return true;
	// Skip CLI entry points and command files — console.log is the correct output method
	if (isCliFile(filePath)) return true;
	// 139-repo audit: also exempt `cli/<deeper>`, `tools/`, and
	// `tutorial[s]/` — `isCliFile`'s heuristics miss `cli/internal/setup/
	// wizard.go` (Supermodel, 13 fmt.Println — interactive wizard) and
	// tutorial fixtures intentionally print example output.
	if (isScriptOrCliPath(filePath)) return true;
	// Shebang / package.json-bin entrypoints (field report 2026-07-06): a
	// file invoked as a command prints its output via console.log by design.
	if (isCliEntrypoint(filePath, content)) return true;

	const normalized = filePath.replace(/\\/g, "/");
	// Skip server entry points and scripts — console.log is the correct logging
	// mechanism for Cloudflare Workers (goes to wrangler tail), Node servers,
	// and CLI scripts.
	return (
		/\bservers?\b/i.test(normalized) ||
		/\bscripts?\b/i.test(normalized) ||
		/\bevals?\b/i.test(normalized) ||
		/\/workers?\//i.test(normalized)
	);
}

/**
 * Per-language debug-statement pattern for {@link checkConsoleDebug}, or `null`
 * when the language isn't recognized or its own narrower exemption applies
 * (Python scripts/CLIs/tests, C/C++ main/example files, Go with fewer than 3
 * `fmt.Println` occurrences — too few to read as debug sprawl rather than
 * intentional output).
 */
/**
 * C/C++ branch of {@link consoleDebugPatternFor}: printf is standard output,
 * so skip main files and example/demo dirs before flagging it as debug noise.
 */
function cCppDebugPatternFor(fileName: string, normalized: string): RegExp | null {
	if (fileName.startsWith("main.")) return null;
	if (/\b(examples?|samples?|demos?)\b/i.test(normalized)) return null;
	if (/\b(example|demo|sample)/i.test(fileName)) return null;
	return /\bprintf\s*\(/;
}

function consoleDebugPatternFor(
	ext: string,
	fileName: string,
	normalized: string,
	content: string,
): RegExp | null {
	// JS/TS
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		return /\bconsole\.(log|debug|info)\s*\(|^\s*debugger\s*;/;
	}
	// Python — only flag in app/lib code, skip standalone scripts and sandboxes.
	// Python print() is the standard output mechanism for scripts, CLIs, and notebooks.
	if (ext === ".py") {
		if (/sandbox|script|cli|main|test|__main__/i.test(fileName)) return null;
		// Only flag breakpoint/pdb — print() is too common and usually intentional
		return /\bbreakpoint\s*\(|\bpdb\.set_trace\s*\(/;
	}
	// Rust
	if (ext === ".rs") {
		return /\bdbg!\s*\(/;
	}
	// Go — fmt.Println is standard output in Go. Only flag when 3+ occurrences
	// suggest debug sprawl rather than intentional output.
	if (ext === ".go") {
		const goStripped = stripCommentsAndStrings(content);
		const goCount = (goStripped.match(/\bfmt\.Println\s*\(/g) || []).length;
		if (goCount < 3) return null;
		return /\bfmt\.Println\s*\(/;
	}
	// C/C++ — printf is standard output. Skip main files, example/demo dirs.
	if ([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) {
		return cCppDebugPatternFor(fileName, normalized);
	}
	// Swift — flag debug-intent APIs only. `print(` is too common (CLIs,
	// SwiftPM tools, examples) to flag globally; `debugPrint(` / `dump(` /
	// `NSLog(` are unambiguous debug breadcrumbs that ship to logs. Modern
	// Swift apps should use `os.Logger` / `Logger` instead of `NSLog`.
	if (ext === ".swift") {
		return /\b(?:debugPrint|dump|NSLog)\s*\(/;
	}
	return null;
}

// ===========================================
// CLI-entrypoint detection (console.log IS the output)
// ===========================================

/** Ancestor-walk bound for the nearest-package.json search. */
const BIN_LOOKUP_MAX_DEPTH = 40;

/**
 * CLI-entrypoint predicate for output-oriented checks: a file whose
 * `console.log` IS its output rather than leftover debug logging
 * (field report 2026-07-06). True when any of:
 *   (a) the first line is a shebang (`#!...`),
 *   (b) the file is a target of the nearest package.json `bin` map
 *       (string or object form), or
 *   (c) the path has a `scripts/` or `bin/` segment.
 * `cwd` resolves relative paths for (b); without it a relative path skips
 * the bin lookup (the shebang and path-segment tests still apply). Shared by
 * `checkConsoleDebug` (registry `console_statements`, also run by verify)
 * and the write-guard content-quality console heuristic, so every surface
 * inherits the same exemption.
 */
export function isCliEntrypoint(filePath: string, content: string, cwd?: string): boolean {
	if (content.startsWith("#!")) return true;
	const norm = filePath.replace(/\\/g, "/");
	if (/(^|\/)(?:scripts|bin)\//.test(norm)) return true;
	return isPackageBinTarget(filePath, cwd);
}

/** Walk up from the file's directory to the NEAREST package.json and test
 *  whether any of its `bin` entries resolves to the file. Fail-soft: no
 *  package.json found, unreadable, or malformed all mean "not a bin target". */
function isPackageBinTarget(filePath: string, cwd?: string): boolean {
	let abs: string;
	if (isAbsolute(filePath)) abs = filePath;
	else if (cwd) abs = resolve(cwd, filePath);
	else return false;
	let dir = dirname(abs);
	for (let depth = 0; depth < BIN_LOOKUP_MAX_DEPTH; depth++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) return packageBinIncludes(pkgPath, dir, abs);
		const parent = dirname(dir);
		if (parent === dir) return false; // filesystem root
		dir = parent;
	}
	return false;
}

/** The `bin` field's target paths: string form is a single target, object
 *  form maps command names to targets. Anything else contributes none. */
function binTargets(bin: unknown): string[] {
	if (typeof bin === "string") return [bin];
	if (typeof bin === "object" && bin !== null) {
		return Object.values(bin).filter((v): v is string => typeof v === "string");
	}
	return [];
}

/** Whether the package.json at `pkgPath` declares a `bin` entry (string or
 *  object form) that resolves to `absFile`. */
function packageBinIncludes(pkgPath: string, pkgDir: string, absFile: string): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (typeof raw !== "object" || raw === null) return false;
		const bin = (raw as { bin?: unknown }).bin;
		return binTargets(bin).some((t) => resolve(pkgDir, t) === resolve(absFile));
	} catch {
		return false; // unreadable/malformed package.json — no exemption
	}
}

/** Whether `filePath` is a CLI COMMAND module: it lives under a `commands/`
 *  (or `cli`/`cmd`) directory AND the nearest package.json declares a non-null
 *  `bin`. Such a module's console.log IS the CLI's output surface (like the bin
 *  entrypoint itself); the `bin` requirement scopes the exemption to real CLIs,
 *  not any project that merely has a `commands/` folder. */
export function isCliCommandModule(filePath: string, cwd?: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (!/(^|\/)(?:commands|cli|cmd)\//.test(norm)) return false;
	return nearestPackageDeclaresBin(filePath, cwd);
}

/** Walk up to the nearest package.json and report whether it declares a `bin`. */
function nearestPackageDeclaresBin(filePath: string, cwd?: string): boolean {
	let abs: string;
	if (isAbsolute(filePath)) abs = filePath;
	else if (cwd) abs = resolve(cwd, filePath);
	else return false;
	let dir = dirname(abs);
	for (let depth = 0; depth < BIN_LOOKUP_MAX_DEPTH; depth++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) return packageDeclaresBin(pkgPath);
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

/** True when the package.json at `pkgPath` has a non-null `bin` field. */
function packageDeclaresBin(pkgPath: string): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return typeof raw === "object" && raw !== null && (raw as { bin?: unknown }).bin != null;
	} catch {
		return false;
	}
}
