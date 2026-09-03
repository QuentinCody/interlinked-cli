// interlinked-tdd: exempt
// ===========================================
// Ripgrep Command Parsing
// ===========================================
// Parses a Bash command into a ripgrep/grep/ugrep invocation the trigram
// accelerator can answer, or declines (returns null) so the real command runs.
// Split out of regex-trigrams.ts; consumes nothing from the decomposition side.

import { nonNull } from "../lib/non-null.js";

export interface ParsedGrepCommand {
	pattern: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	path?: string;
	glob?: string;
}

/** Flags whose effect the accelerator can reproduce exactly when it answers a
 *  search itself. ANY flag outside this set forces parseGrepCommand to return
 *  null → the daemon falls through to the real rg/ugrep, guaranteeing the
 *  accelerator never returns a result that differs from the native command.
 *  This is the conservative half of the never-worse-than-native contract; the
 *  freshness / size / completeness half lives in grep-accelerator.ts. */
type SafeGrepFlag = "ignore_case" | "fixed_strings" | "case_sensitive" | "regexp";

/**
 * Classify a single rg/grep/ugrep flag token. Returns the modeled effect, or
 * "unsafe" for anything we cannot reproduce identically — which includes flags
 * that invert (`-v`), change the file universe (`--no-ignore`, `-z`), change
 * which lines match (`-w`, `-x`, `-S` smart-case, `-U` multiline, `-P` pcre2),
 * change output shape (`-l`, `-c`, `-o`, `-A`/`-B`/`-C`, `-N`, `--heading`,
 * `--color=always`), filter files (`-g`, `-t`), or supply patterns from a file
 * (`-f`). Callers MUST decline (fall through to native) on "unsafe".
 */
function classifyGrepFlag(tok: string): SafeGrepFlag | "unsafe" {
	switch (tok) {
		case "-i":
		case "--ignore-case":
			return "ignore_case";
		case "-F":
		case "--fixed-strings":
			return "fixed_strings";
		case "-s":
		case "--case-sensitive":
			return "case_sensitive";
		case "-e":
		case "--regexp":
			return "regexp";
		default:
			return "unsafe";
	}
}

/**
 * Characters that, when seen unquoted, mark a pipeline / compound command:
 * pipes, separators, redirects, command substitution, and grouping. Used by
 * `hasUnquotedShellOperator`.
 */
const SHELL_OPERATOR_CHARS = new Set([
	"|",
	";",
	"&",
	">",
	"<",
	"$",
	"`",
	"(",
	")",
	"{",
	"}",
	"\n",
]);

/** True when `argsStr` contains a shell operator OUTSIDE quotes — i.e. the
 *  command is a pipeline or compound command (`rg … | …`, `rg … && …`,
 *  `$(…)`, backticks, brace/paren groups). The accelerator can only answer the
 *  single rg invocation; substituting it would silently drop the rest of the
 *  command, so these must run natively. Quoted operators (e.g. the `|` in the
 *  regex `'a|b'`) are part of the pattern and are ignored. */
function hasUnquotedShellOperator(argsStr: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < argsStr.length; i++) {
		const ch = nonNull(argsStr[i]);
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") i++;
			else if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			i++; // escaped char is literal
			continue;
		}
		if (SHELL_OPERATOR_CHARS.has(ch)) {
			return true;
		}
	}
	return false;
}

/**
 * Apply a safe-classified flag `tok` to `result`. For `-e` the pattern is the
 * next token (`tokens[i + 1]`), so the consumed index and a pattern-from-flag
 * marker are returned. Returns "decline" for an unmodeled flag or a dangling
 * `-e`; the caller then falls through to native.
 */
function applyGrepFlag(
	tok: string,
	tokens: string[],
	i: number,
	result: ParsedGrepCommand,
): { i: number; patternFromFlag: boolean } | "decline" {
	const cls = classifyGrepFlag(tok);
	if (cls === "unsafe") return "decline";
	if (cls === "ignore_case") result.caseInsensitive = true;
	else if (cls === "case_sensitive") result.caseInsensitive = false;
	else if (cls === "fixed_strings") result.isRegex = false;
	else {
		// `-e PATTERN` — the next token is the pattern.
		if (i + 1 >= tokens.length) return "decline";
		result.pattern = nonNull(tokens[i + 1]);
		return { i: i + 1, patternFromFlag: true };
	}
	return { i, patternFromFlag: false };
}

/**
 * Resolve pattern + optional path from the collected positionals, mutating
 * `result`. Returns false to decline: too many paths, the wrong positional
 * count, or an empty pattern.
 */
function assignGrepPositionals(
	result: ParsedGrepCommand,
	positionals: string[],
	patternFromFlag: boolean,
): boolean {
	if (patternFromFlag) {
		if (positionals.length > 1) return false;
		if (positionals.length === 1) result.path = nonNull(positionals[0]);
	} else {
		if (positionals.length === 0 || positionals.length > 2) return false;
		result.pattern = nonNull(positionals[0]);
		if (positionals.length === 2) result.path = nonNull(positionals[1]);
	}
	return Boolean(result.pattern);
}

/**
 * Parse a Bash command into a ripgrep/grep/ugrep invocation the accelerator can
 * answer, or return null to decline (fall through to native). Declines on: any
 * shell operator / pipeline (`hasUnquotedShellOperator`), any flag outside the
 * safe set (`classifyGrepFlag` → "unsafe"), and more than one search path.
 * Returning null is always safe — it just means the real command runs.
 */
export function parseGrepCommand(command: string): ParsedGrepCommand | null {
	const trimmed = command.trim();

	// Match ripgrep: rg [flags] 'pattern' [path]
	// Match grep/ugrep: grep [flags] 'pattern' [path]
	// Native Claude Code (macOS/Linux) replaced the Grep tool with embedded
	// `ugrep` (binary `ug` / `ugrep`) invoked through Bash, so recognize those
	// alongside rg/grep. The optional `\S*\/` prefix matches the embedded
	// binary invoked by absolute path (e.g. `/…/ugrep`) — we key off basename.
	const rgMatch = trimmed.match(
		/^(?:\S*\/)?(?:ugrep|ug|rg|ripgrep|grep|egrep|fgrep)\s+(.*)/s,
	);
	if (!rgMatch) return null;

	const argsStr = nonNull(rgMatch[1]);
	// Pipeline / compound command → only native can run the whole thing.
	if (hasUnquotedShellOperator(argsStr)) return null;

	const result: ParsedGrepCommand = {
		pattern: "",
		isRegex: true,
		caseInsensitive: false,
	};

	const tokens = tokenizeShellArgs(argsStr);
	const positionals: string[] = [];
	let patternFromFlag = false;
	let endOfFlags = false;

	for (let i = 0; i < tokens.length; i++) {
		const tok = nonNull(tokens[i]);

		// `--` ends flag parsing; everything after is positional.
		if (!endOfFlags && tok === "--") {
			endOfFlags = true;
			continue;
		}

		if (!endOfFlags && tok.length > 1 && tok.startsWith("-")) {
			const applied = applyGrepFlag(tok, tokens, i, result);
			if (applied === "decline") return null;
			i = applied.i;
			if (applied.patternFromFlag) patternFromFlag = true;
			continue;
		}

		positionals.push(tok);
	}

	return assignGrepPositionals(result, positionals, patternFromFlag) ? result : null;
}

/** Result of consuming one character inside a quoted run. */
interface QuoteStep {
	current: string;
	i: number;
	closed: boolean;
}

/**
 * Consume one character of a single-quoted run starting at `i`. Single quotes
 * are literal except the closing `'`. Always advances one character.
 */
function consumeSingleQuoted(input: string, i: number, current: string): QuoteStep {
	const ch = input[i];
	if (ch === "'") return { current, i: i + 1, closed: true };
	return { current: current + ch, i: i + 1, closed: false };
}

/**
 * Consume one character of a double-quoted run starting at `i`. Honors
 * backslash escapes and closes on `"`. Advances one or two characters.
 */
function consumeDoubleQuoted(input: string, i: number, current: string): QuoteStep {
	const ch = input[i];
	if (ch === '"') return { current, i: i + 1, closed: true };
	if (ch === "\\" && i + 1 < input.length) {
		return { current: current + input[i + 1], i: i + 2, closed: false };
	}
	return { current: current + ch, i: i + 1, closed: false };
}

/**
 * Characters that terminate the tokenizer scan (shell operators). Matching one
 * unquoted means the rest of the command is a separate invocation we don't model.
 */
const TOKENIZER_STOP_CHARS = new Set(["|", ";", "&", ">", "<"]);

/** Mutable scan position threaded through `advanceTokenizerCursor`. */
interface TokenizeCursor {
	current: string;
	i: number;
	inSingle: boolean;
	inDouble: boolean;
}

/**
 * Advance `cursor` by one step against `input[cursor.i]`, pushing a completed
 * token into `tokens` on whitespace. Mutates `cursor` in place. Returns true
 * when a shell operator ends the scan (the caller must stop iterating).
 */
function advanceTokenizerCursor(input: string, cursor: TokenizeCursor, tokens: string[]): boolean {
	const ch = nonNull(input[cursor.i]);

	if (cursor.inSingle) {
		const st = consumeSingleQuoted(input, cursor.i, cursor.current);
		cursor.current = st.current;
		cursor.i = st.i;
		if (st.closed) cursor.inSingle = false;
		return false;
	}

	if (cursor.inDouble) {
		const st = consumeDoubleQuoted(input, cursor.i, cursor.current);
		cursor.current = st.current;
		cursor.i = st.i;
		if (st.closed) cursor.inDouble = false;
		return false;
	}

	if (ch === "'") {
		cursor.inSingle = true;
		cursor.i++;
	} else if (ch === '"') {
		cursor.inDouble = true;
		cursor.i++;
	} else if (ch === "\\") {
		if (cursor.i + 1 < input.length) {
			cursor.current += input[cursor.i + 1];
			cursor.i += 2;
		} else {
			cursor.i++;
		}
	} else if (ch === " " || ch === "\t") {
		if (cursor.current.length > 0) {
			tokens.push(cursor.current);
			cursor.current = "";
		}
		cursor.i++;
	} else if (TOKENIZER_STOP_CHARS.has(ch)) {
		cursor.i = input.length; // stop at shell operators
		return true;
	} else {
		cursor.current += ch;
		cursor.i++;
	}
	return false;
}

/**
 * Basic shell argument tokenizer.
 * Handles single quotes, double quotes, and backslash escapes.
 */
function tokenizeShellArgs(input: string): string[] {
	const tokens: string[] = [];
	const cursor: TokenizeCursor = { current: "", i: 0, inSingle: false, inDouble: false };

	while (cursor.i < input.length) {
		if (advanceTokenizerCursor(input, cursor, tokens)) break;
	}

	if (cursor.current.length > 0) tokens.push(cursor.current);
	return tokens;
}
