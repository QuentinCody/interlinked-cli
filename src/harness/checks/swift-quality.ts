// Swift code-quality detectors: empty catches, discarded try?, NSURL legacy
// bridge, fatalError-in-guard, print() inside SwiftUI body.
//
// These are individually heuristic but each has a low FP rate when scoped to
// the patterns described in their JSDoc. The fatalError-in-guard and
// print-in-view-body checks are advisory (in DEFAULT_ADVISORY_SKIPS).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

const MATCH_LIMIT = 10;

/**
 * Detect `catch { }` with an empty body — silently swallows the error.
 *
 * Matches:
 *   - `catch { }` (same line)
 *   - `catch { <whitespace only> }` (multi-line)
 *   - `catch let err { }` / `catch MyError.x { }` (typed empty)
 *
 * A `catch` whose only contents are a comment (like a `// swallow` line)
 * also matches: stripping comments collapses the body to `{ }` and the
 * pattern fires. That's deliberate — "documenting" a swallow is still a
 * swallow; rewrite to `_ = error` if you really want to discard.
 */
export function checkSwiftEmptyCatch(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);
		// Same-line empty: `catch [pattern]? { }`.
		// Pattern can be `let x`, `let x as MyError`, `MyError.case`, etc.
		// We accept any non-`{` chars between `catch` and `{ }`.
		if (/\bcatch\b[^{]*\{\s*\}/.test(line)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}
		// Multi-line: `catch ... {` on this line, `}` on a later non-empty line
		// with nothing between (whitespace/blank lines only).
		if (!/\bcatch\b[^{]*\{\s*$/.test(line)) continue;
		let emptyBody = false;
		for (let j = i + 1; j < Math.min(i + 5, strippedLines.length); j++) {
			const next = nonNull(strippedLines[j]).trim();
			if (next === "") continue;
			if (next === "}") emptyBody = true;
			break;
		}
		if (emptyBody) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect `try?` at statement position with the result discarded.
 *
 * The pattern is: `try? expr` appears on a line where:
 *   - The line does NOT begin with a binding keyword (`let`, `var`,
 *     `if`, `guard`, `while`, `for`, `switch`, `case`).
 *   - The line does NOT contain `=` to the left of `try?` (assignment).
 *   - The line does NOT begin with `return`, `throw`, `await`, `_ =`.
 *
 * In other words, a bare `try? foo()` at statement position discards both
 * the throw and the optional result — almost always a mistake.
 */
export function checkSwiftTryQuestionDiscarded(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);
		if (!/\btry\?\s/.test(line)) continue;
		const trimmed = line.trimStart();
		// Bound forms / control flow / explicit discard — skip.
		if (
			/^(?:let|var|if|guard|switch|while|for|return|throw|await|case|else)\b/.test(trimmed)
		) {
			continue;
		}
		if (/^_\s*=\s*try\?/.test(trimmed)) continue;
		if (/=\s*try\?/.test(line)) continue;
		// Must start with `try?` (statement-level discard).
		if (!/^try\?\s/.test(trimmed)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * Detect `NSURL` / `NSURLRequest` / `NSURLComponents` / `NSURLSession`
 * constructor calls — should be the Swift-native `URL` / `URLRequest` /
 * `URLComponents` / `URLSession` value types.
 *
 * Skips inside string literals (e.g., docs that mention "NSURL").
 */
export function checkSwiftNsurlLegacyBridge(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bNSURL(?:Request|Components|Session|QueryItem)?\s*\(/,
		MATCH_LIMIT,
	);
}

/**
 * Detect `guard ... else { fatalError(...) }` — a force-unwrap by another name.
 *
 * The `guard let x = y else { fatalError(...) }` form is functionally identical
 * to `let x = y!` but pretends to be "safer" because it has a custom error
 * message. The runtime behavior is the same: crash. If you actually want a
 * recoverable error, propagate it via `throw` / `Optional`. Otherwise just
 * use `!` — the harness can see and warn on it.
 *
 * Allows up to 3 lines between the `guard` and the `fatalError` body since
 * `guard` with multi-clause conditions wraps onto multiple lines.
 */
export function checkSwiftFatalErrorInGuard(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);
		if (!/\bguard\b.*\belse\s*\{/.test(line)) continue;
		// Look in this line + next 3 for fatalError.
		for (let j = i; j < Math.min(i + 4, strippedLines.length); j++) {
			if (/\bfatalError\s*\(/.test(nonNull(strippedLines[j]))) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
				break;
			}
			if (j > i && /^\s*\}/.test(nonNull(strippedLines[j]))) break;
		}
	}
	return matches;
}

/**
 * Detect `print(...)` inside a SwiftUI `View`'s `body` computed property.
 *
 * SwiftUI re-evaluates `body` on every state change — a `print` inside `body`
 * fires thousands of times during normal use, which is at best noisy and at
 * worst masks the actual debug signal. Use `.onAppear { print(...) }` /
 * `.onChange(of:)` instead.
 *
 * Scope: only files that contain `: View` somewhere (cheap gate to avoid
 * scanning non-SwiftUI Swift files). Body detection uses brace-depth tracking
 * — when depth returns to zero (or below) we exit the body region.
 */
/**
 * Advance the `body`-region tracking state by one (already comment/string
 * stripped) line and report whether that line contains a `print(...)` call
 * while inside the body.
 *
 * Mirrors the original inline loop body exactly: a line that *opens* the
 * `var body: some View {` region is consumed to seed `bodyDepth` and never
 * itself checked for `print` (the original `continue`d past it); every
 * subsequent line while `inBody` updates `bodyDepth` by its brace delta and
 * is checked for `print`.
 */
function scanPrintInViewBodyLine(
	line: string,
	state: { inBody: boolean; bodyDepth: number },
): { inBody: boolean; bodyDepth: number; matched: boolean } {
	if (!state.inBody) {
		if (!/\bvar\s+body\s*:\s*(?:some\s+)?View\s*\{/.test(line)) {
			return { inBody: false, bodyDepth: state.bodyDepth, matched: false };
		}
		const opens = (line.match(/\{/g) || []).length;
		const closes = (line.match(/\}/g) || []).length;
		const bodyDepth = opens - closes;
		return { inBody: bodyDepth > 0, bodyDepth, matched: false };
	}

	const opens = (line.match(/\{/g) || []).length;
	const closes = (line.match(/\}/g) || []).length;
	const bodyDepth = state.bodyDepth + opens - closes;
	const matched = /\bprint\s*\(/.test(line);
	return { inBody: bodyDepth > 0, bodyDepth, matched };
}

export function checkSwiftPrintInViewBody(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];
	if (!/\bView\b/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let inBody = false;
	let bodyDepth = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);
		const next = scanPrintInViewBodyLine(line, { inBody, bodyDepth });
		inBody = next.inBody;
		bodyDepth = next.bodyDepth;
		if (next.matched) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}
