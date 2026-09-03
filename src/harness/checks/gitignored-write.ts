// gitignored-write — detects code that writes a file excluded by .gitignore.
//
// Bug class: a tool / setup script writes a config or policy file it intends
// to commit, but a blanket .gitignore rule (with no `!` negation carve-out)
// silently excludes it — so the file can never land in a PR.
//
// Real example: code wrote `.interlinked/metric-caps.json` as committed policy
// while `.gitignore` contained `.interlinked/*` without a corresponding
// `!.interlinked/metric-caps.json` exemption.
//
// Check id: gitignored_written_config
// Advisory only — heuristic (static path resolution), not compiler-verified.

import type { InlineMatch } from "./shared.js";

// ==========================================================================
// Ephemeral-target exclusion
// ==========================================================================
// Paths that are SUPPOSED to be gitignored — skip them even when isIgnored
// returns true, because the caller wrote them intentionally into an ignored
// location (logs, build outputs, runtime sockets, etc.).

/** Segment-or-basename patterns for targets that are expected to be ignored. */
const EPHEMERAL_SEGMENT_RE =
	/(?:^|\/)(?:log|logs|tmp|temp|cache|coverage|dist|build|node_modules)(?:\/|$)/i;

/** File extensions that mark runtime / ephemeral targets. */
const EPHEMERAL_EXT_RE = /\.(?:log|tmp|lock|pid|sock)$/i;

/**
 * Return true when a resolved path looks like an intentionally-ignored
 * ephemeral target (logs, temp files, build outputs, lock files, sockets).
 * These must NOT produce findings even if `isIgnored` returns true.
 */
function isEphemeralTarget(resolvedPath: string): boolean {
	const normalized = resolvedPath.replace(/\\/g, "/");
	return EPHEMERAL_SEGMENT_RE.test(normalized) || EPHEMERAL_EXT_RE.test(normalized);
}

// ==========================================================================
// Static path resolution from call-site arguments
// ==========================================================================
// We only flag statically-resolvable paths: either a bare string literal or a
// path.join / join call whose every argument is a string literal. Opaque
// variable paths are silently skipped — precision over recall.

/** Match a JavaScript / TypeScript string literal (single, double, or backtick)
 *  with no embedded expressions. Returns the literal's VALUE or null. */
function extractStringLiteral(raw: string): string | null {
	const t = raw.trim();
	// Single or double quoted — no escaped quotes spanning our literal.
	const sdMatch = /^(["'])((?:[^\\]|\\.)*?)\1$/.exec(t);
	if (sdMatch) return sdMatch[2] ?? null;
	// Template literal with no ${…} interpolations.
	const tmplMatch = /^`([^`$]*)`$/.exec(t);
	if (tmplMatch) return tmplMatch[1] ?? null;
	return null;
}

// --------------------------------------------------------------------------
// Shared character-scanning helpers
// --------------------------------------------------------------------------
// Both `splitTopLevelArgs` and `extractFirstArg` walk raw source one character
// at a time, tracking string-literal state and bracket depth. These helpers
// hold the per-character classification so each scanner stays readable.

/** Result of advancing the string-literal state by one character. */
interface StringScanStep {
	/** The quote character still open, or null once the literal closed. */
	inStr: string | null;
	/** True when the caller must skip the next character (escape sequence). */
	skipNext: boolean;
}

/**
 * Advance string-literal state by one character while inside a literal opened
 * by `inStr`. `hasNext` says whether a following character exists (an escape
 * at the very end of the buffer skips nothing).
 */
function stepInsideStringLiteral(
	ch: string | undefined,
	inStr: string,
	hasNext: boolean,
): StringScanStep {
	if (ch === "\\" && hasNext) return { inStr, skipNext: true };
	if (ch === inStr) return { inStr: null, skipNext: false };
	return { inStr, skipNext: false };
}

/** True when the character opens a string literal we must skip over. */
function isQuoteChar(ch: string | undefined): boolean {
	return ch === '"' || ch === "'" || ch === "`";
}

/** True when the character opens a nesting level. */
function isOpenBracket(ch: string | undefined): boolean {
	return ch === "(" || ch === "[" || ch === "{";
}

/** True when the character closes a nesting level. */
function isCloseBracket(ch: string | undefined): boolean {
	return ch === ")" || ch === "]" || ch === "}";
}

/** Signed change in nesting depth this character causes (0 for non-brackets). */
function bracketDelta(ch: string | undefined): number {
	if (isOpenBracket(ch)) return 1;
	if (isCloseBracket(ch)) return -1;
	return 0;
}

/**
 * Walk `text` from `start`, skipping over string literals and tracking bracket
 * depth (which begins at `initialDepth`). `visit` is called for every character
 * outside a string literal, with the depth AFTER that character is accounted
 * for; returning true stops the scan.
 *
 * Returns the index of the character that stopped the scan, or null when the
 * text ran out without `visit` ever stopping it.
 */
function scanOutsideStrings(
	text: string,
	start: number,
	initialDepth: number,
	visit: (ch: string, index: number, depth: number) => boolean,
): number | null {
	let depth = initialDepth;
	let inStr: string | null = null;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr !== null) {
			const step = stepInsideStringLiteral(ch, inStr, i + 1 < text.length);
			inStr = step.inStr;
			if (step.skipNext) i++; // skip escaped char
			continue;
		}
		if (isQuoteChar(ch)) {
			inStr = ch ?? null;
			continue;
		}
		depth += bracketDelta(ch);
		if (visit(ch ?? "", i, depth)) return i;
	}
	return null;
}

/**
 * Split a raw comma-separated argument list into top-level argument strings,
 * respecting nested parens, brackets, braces, and string literals.
 * Returns the list of raw argument tokens (un-trimmed).
 */
function splitTopLevelArgs(argsRaw: string): string[] {
	const args: string[] = [];
	let start = 0;

	scanOutsideStrings(argsRaw, 0, 0, (ch, index, depth) => {
		if (ch === "," && depth === 0) {
			args.push(argsRaw.slice(start, index));
			start = index + 1;
		}
		return false; // every top-level comma splits — never stop early
	});

	// Last segment
	if (start <= argsRaw.length) {
		args.push(argsRaw.slice(start));
	}
	return args;
}

/**
 * Try to statically resolve the first argument of a file-write call to a
 * relative path string. Handles two shapes:
 *   1. A bare string literal:  `"a/b/c.json"`
 *   2. A join(...) call of all-literal args:  `join(cwd, ".interlinked", "x.json")`
 *      — segments are concatenated with "/" (we discard non-literal segment
 *        values, i.e. variable references, and treat them as unresolvable).
 *
 * Returns the resolved relative path, or null when the path is not statically
 * determinable (variable reference, computed expression, mixed literals and
 * variables).
 */
function resolvePathArg(rawArg: string): string | null {
	const t = rawArg.trim();

	// Case 1 — bare string literal.
	const lit = extractStringLiteral(t);
	if (lit !== null) {
		// Only relative paths are meaningful for .gitignore matching.
		// Absolute OS paths (/tmp/foo, C:\foo) are intentionally skipped.
		if (lit.startsWith("/") || /^[A-Za-z]:\\/.test(lit)) return null;
		return lit;
	}

	// Case 2 — join call: `join(...)`, `path.join(...)`, `resolve(...)`, etc.
	// Accept any identifier optionally preceded by `<qualifier>.`:
	//   join(...)  |  path.join(...)  |  nodePath.join(...)
	const joinCallMatch = /^(?:[\w$]+\.)?(?:join|resolve)\s*\((.+)\)$/s.exec(t);
	if (!joinCallMatch) return null;

	const innerRaw = joinCallMatch[1];
	if (innerRaw === undefined) return null;
	const argTokens = splitTopLevelArgs(innerRaw);

	const segments: string[] = [];
	for (const token of argTokens) {
		const segLit = extractStringLiteral(token.trim());
		if (segLit === null) {
			// A non-literal argument (variable, call expression, etc.) makes the
			// overall path opaque — skip the entire call.
			return null;
		}
		segments.push(segLit);
	}

	if (segments.length === 0) return null;

	// Join all literal segments with "/" (forward-slash is fine for .gitignore
	// matching purposes — we only care about the relative path shape).
	const joined = segments.join("/").replace(/\/+/g, "/");

	// If the first segment looks like an absolute path root, skip it (e.g. the
	// caller passed `cwd` or `__dirname` as a variable, but we accidentally
	// resolved it as a plain string — the null-return above should have caught it,
	// but belt-and-suspenders check here).
	if (joined.startsWith("/") || /^[A-Za-z]:\\/.test(joined)) return null;
	return joined;
}

// ==========================================================================
// Write-call detection
// ==========================================================================
// We scan the raw source for file-write call sites, then re-read the path
// argument from raw content (not stripped) so we get the actual string value.

/** The write APIs we track. */
const WRITE_API_RE =
	/\b(writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(\s*/g;

/**
 * Given source content at a specific character offset, extract the raw text
 * of the first argument to the call (everything before the first top-level
 * comma or closing paren). Returns null when parsing fails.
 *
 * The offset should point at the character AFTER the opening `(` of the call.
 */
function extractFirstArg(content: string, openParenOffset: number): string | null {
	// Depth starts at 1 — we're already one level inside the `(`.
	const argEnd = scanOutsideStrings(content, openParenOffset, 1, endsFirstArg);
	if (argEnd === null) return null;
	return content.slice(openParenOffset, argEnd).trim();
}

/**
 * True when this character ends the call's first argument: either the call's
 * own closing paren (depth back to 0, no comma was found) or a top-level comma.
 */
function endsFirstArg(ch: string, _index: number, depth: number): boolean {
	if (isCloseBracket(ch)) return depth === 0;
	return ch === "," && depth === 1;
}

/**
 * Return the 1-based line number for a character offset in content.
 * Pre-computes nothing — called once per finding, so O(offset) is fine.
 */
function lineNumberAtOffset(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content[i] === "\n") line++;
	}
	return line;
}

// ==========================================================================
// Public API
// ==========================================================================

/**
 * Detect file-write calls whose statically-resolved path is excluded by
 * .gitignore (without a `!` negation carve-out), meaning the written file
 * can never be committed.
 *
 * `isIgnored` is INJECTED — in production it is backed by `git check-ignore`,
 * but in unit tests a mock is passed so the detector is testable without git.
 *
 * Returns one {@link InlineMatch} per flagged call site.
 */
export function detectGitignoredWrites(
	content: string,
	filePath: string,
	isIgnored: (writtenPath: string) => boolean,
): InlineMatch[] {
	// Only scan JS/TS source files — other languages use different write APIs.
	if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(filePath)) return [];

	const matches: InlineMatch[] = [];

	// Reset lastIndex before each scan.
	WRITE_API_RE.lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = WRITE_API_RE.exec(content)) !== null) {
		// The regex ends with `\(\s*` — the captured group is the API name.
		// The match ends right after the `(` and optional whitespace.
		const afterOpenParen = m.index + m[0].length;

		const rawFirstArg = extractFirstArg(content, afterOpenParen);
		if (rawFirstArg === null) continue;

		const resolvedPath = resolvePathArg(rawFirstArg);
		if (resolvedPath === null) continue; // not statically resolvable — skip

		if (isEphemeralTarget(resolvedPath)) continue; // expected to be ignored — skip

		if (!isIgnored(resolvedPath)) continue; // not gitignored — no finding

		const lineNum = lineNumberAtOffset(content, m.index);
		const rawLine = content.split("\n")[lineNum - 1] ?? "";
		matches.push({
			line: lineNum,
			text: rawLine.trim().slice(0, 150),
		});

		if (matches.length >= 10) break; // cap findings per file
	}

	return matches;
}
