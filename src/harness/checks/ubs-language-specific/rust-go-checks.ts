// UBS language-specific detectors — Rust and Go checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Ext-gated to .rs / .go.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "../shared.js";
import { MATCH_LIMIT } from "./_shared.js";

// ===========================================
// Row 22 — `ubs_mutex_lock_unwrap` (Rust)
// ===========================================

/**
 * Detect `Mutex<T>...lock().unwrap()` — panics on poisoned mutex.
 *
 * Plan 04 §4.1 regex: `\bMutex<[^>]+>[\s\S]{0,200}?\.lock\(\)\.unwrap\(\)`.
 * `[^<>]*(?:<[^<>]*>[^<>]*)?` allows one nested generic level so
 * `Mutex<HashMap<String, u64>>` participates. The 200-char window lets the
 * lock and unwrap land on a different line from the declaration.
 */
export function checkMutexLockUnwrap(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\bMutex\s*<[^<>]*(?:<[^<>]*>[^<>]*)?>[\s\S]{0,200}?\.lock\s*\(\s*\)\s*\.unwrap\s*\(\s*\)/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= 10) break;
		// Anchor finding at the `.unwrap` token — the panic site cold readers
		// jump to from the warning.
		const idx = m.index + m[0].lastIndexOf(".unwrap");
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	return matches;
}

// ===========================================
// Rust — debug_assert side effects
// ===========================================

const RUST_SIDE_EFFECT_CALL_RE =
	/\b(?:insert|push|pop|remove|delete|set|write|send|close|open|spawn|create|update|clear|append|extend|retain|sort|reserve|truncate|drain|take|swap|store|alloc|free|unpin|pin|register|unregister|detach|resize|reset|start|stop|commit|rollback|flush|emit|notify|mark|invalidate)(?:_[a-z0-9_]+)?\s*(?:::<[^>]*>\s*)?\(/;

function matchingParenIndex(text: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function hasRustAssignment(body: string): boolean {
	return /(?:^|[^=!<>])(?:<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=(?!=|>))/.test(body);
}

function hasRustTryOperator(body: string): boolean {
	return /(?:^|[^:?])\?(?![?=])/.test(body);
}

function rustDebugAssertBodyHasSideEffect(body: string): boolean {
	return hasRustTryOperator(body) || hasRustAssignment(body) || RUST_SIDE_EFFECT_CALL_RE.test(body);
}

/**
 * Detect side effects hidden inside Rust `debug_assert*` macros.
 *
 * Rust erases `debug_assert!`, `debug_assert_eq!`, and `debug_assert_ne!` in
 * optimized release builds, including any work needed to evaluate their
 * arguments. This catches the porting-regression class where a mutating call
 * or fallible operation accidentally runs only in debug builds.
 */
export function checkRustDebugAssertSideEffects(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdebug_assert(?:_eq|_ne)?!\s*\(/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= MATCH_LIMIT) break;
		const start = m.index;
		const openIndex = start + m[0].lastIndexOf("(");
		const closeIndex = matchingParenIndex(stripped, openIndex);
		if (closeIndex === -1) continue;

		const body = stripped.slice(openIndex + 1, closeIndex);
		if (!rustDebugAssertBodyHasSideEffect(body)) continue;

		const lineNum = stripped.slice(0, start).split("\n").length;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * `ubs_goroutine_no_waitgroup` — Go `go func() { ... }()` started without an
 * accompanying `wg.Add` / `wg.Done` pair (or other synchronization context).
 * Fire-and-forget goroutines leak when the caller exits before they complete.
 * post / warning.
 *
 * Heuristic: a `go func` line whose surrounding ±200-char window contains no
 * `wg.Add`, `wg.Done`, `errgroup`, `sync.WaitGroup`, or `<-` channel receive.
 */
export function checkGoroutineNoWaitgroup(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const goRe = /\bgo\s+func\b/g;
	const SAFE_CONTEXT_RE =
		/\b(?:wg\.(?:Add|Done|Wait)|errgroup|sync\.WaitGroup|<-\s*\w|\.Wait\(\))/;
	const WINDOW = 240;

	for (const m of stripped.matchAll(goRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const start = Math.max(0, idx - WINDOW);
		const end = Math.min(stripped.length, idx + WINDOW);
		const window = stripped.slice(start, end);
		if (SAFE_CONTEXT_RE.test(window)) continue;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Count how many entries at the top of `loopStack` were opened at a
 * brace-depth that is now >= `braceDepth` — those loops have closed.
 * Pure: does not mutate `loopStack`.
 */
function countClosedLoopFrames(loopStack: number[], braceDepth: number): number {
	let count = 0;
	for (let i = loopStack.length - 1; i >= 0; i--) {
		if (nonNull(loopStack[i]) < braceDepth) break;
		count++;
	}
	return count;
}

/**
 * `ubs_defer_in_loop` — Go `defer` inside a `for` loop accumulates calls
 * until the function returns; if the loop iterates many times you blow up
 * memory / leak file handles before any defer executes. post / warning.
 *
 * Heuristic: track loop nesting via simple `for ` line scan; flag any
 * `defer ` line that appears while loop depth > 0.
 */
export function checkDeferInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Track function depth and loop depth separately. A `defer` is fine at
	// the top of a function but NOT inside a `for` body.
	let braceDepth = 0;
	let loopDepth = 0;
	// Stack of brace-depths at which a `for` loop was entered.
	const loopStack: number[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);

		// Count braces opening before checking the line content.
		const openCount = (line.match(/\{/g) || []).length;
		const closeCount = (line.match(/\}/g) || []).length;

		// Detect a `for` loop on this line.
		const forMatch = /\bfor\b/.test(line);
		if (forMatch && openCount > 0) {
			loopStack.push(braceDepth);
			loopDepth++;
		}

		// Now if we're inside a loop and the line has `defer `, flag it.
		if (loopDepth > 0 && /\bdefer\s+\w/.test(line)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}

		// Apply brace depth changes for next iteration.
		braceDepth += openCount - closeCount;

		// Pop loops whose entry depth is now above the current depth.
		const closedFrames = countClosedLoopFrames(loopStack, braceDepth);
		loopStack.length -= closedFrames;
		loopDepth -= closedFrames;
	}
	return matches;
}

/**
 * `ubs_go_shell_injection` — Go `exec.Command("sh", "-c", ...)` or
 * `exec.Command("bash", "-c", ...)` (and the absolute-path forms
 * `/bin/sh` / `/bin/bash`). Invoking a shell interpreter as the program
 * routes the remaining arguments through shell parsing, so any user-input
 * concatenated into the command string can inject arbitrary commands.
 * pre_warn / error.
 *
 * Safe form passes the program and its arguments directly:
 *   `exec.Command("ping", "-c", "1", host)` — no shell involved.
 *
 * Conservative: matches only when the first arg is a literal shell program
 * string. A variable program name is a different (broader) class and is not
 * flagged here.
 */
export function checkGoShellInjection(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// First-arg literal == "sh" / "bash" / "/bin/sh" / "/bin/bash". `stripCommentsAndStrings`
	// blanks string contents, so match against a comments-only strip.
	const commentOnly = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	const re = /\bexec\.Command\s*\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/g;

	for (const m of commentOnly.matchAll(re)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = commentOnly.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	void stripped; // kept consistent with sibling checks' shape
	return matches;
}
