// ===========================================
// Path Glob Matcher — dependency-free
// ===========================================
// Compiles glob patterns to anchored RegExps. Supported syntax:
//   *          — any chars except "/"
//   **         — any chars including "/"
//   ?          — single char except "/"
//   [abc]      — character class (no ranges; "-" inside the class is a literal)
//   {a,b,c}    — brace alternation, can nest with literal text
//   /, .       — match literally
// Avoids pulling `picomatch` in. Matches roughly the subset our skip_paths
// defaults rely on; intentionally narrow so the regex stays auditable.

const GLOB_REGEX_CACHE = new Map<string, RegExp>();
/** Sentinel regex returned for invalid globs — anchors that can never match. */
const NEVER_MATCH_REGEX = /a\bb/;

/** Escape a single literal character for use inside a regex. */
function escapeRegexChar(ch: string): string {
	if (/[.+^$|()\\]/.test(ch)) return `\\${ch}`;
	return ch;
}

/** Result of translating one glob token starting at index `i`. */
interface GlobTokenResult {
	/** Regex source appended for this token. */
	appended: string;
	/** Index of the next unconsumed character in `glob`. */
	nextIndex: number;
}

/** Translate the star token (`*`, bare `**`, or `**` followed by `/`) at `i` into regex source. */
function processStarToken(glob: string, i: number): GlobTokenResult {
	if (glob[i + 1] === "*") {
		// "**/" — zero or more path segments (incl. trailing slash optional).
		if (glob[i + 2] === "/") {
			return { appended: "(?:.*/)?", nextIndex: i + 3 };
		}
		// Bare "**" — any chars, including "/".
		return { appended: ".*", nextIndex: i + 2 };
	}
	// Single "*" — any chars except "/".
	return { appended: "[^/]*", nextIndex: i + 1 };
}

/** Translate the `[...]` character-class token starting at `i`. */
function processBracketToken(glob: string, i: number): GlobTokenResult {
	const close = glob.indexOf("]", i + 1);
	if (close === -1) throw new Error(`unterminated [ in glob: ${glob}`);
	const body = glob.slice(i + 1, close);
	// Reject ranges per spec (no need for them in skip_paths defaults).
	if (/[A-Za-z0-9]-[A-Za-z0-9]/.test(body)) {
		throw new Error(`character ranges not supported in glob: ${glob}`);
	}
	return { appended: `[${body.replace(/\\/g, "\\\\")}]`, nextIndex: close + 1 };
}

/** Translate the `{a,b,c}` brace-alternation token starting at `i`. */
function processBraceToken(glob: string, i: number): GlobTokenResult {
	const close = findMatchingBrace(glob, i);
	if (close === -1) throw new Error(`unterminated { in glob: ${glob}`);
	const inner = splitTopLevelCommas(glob.slice(i + 1, close));
	return {
		appended: `(?:${inner.map(globToRegexSource).join("|")})`,
		nextIndex: close + 1,
	};
}

/** Translate the single glob token starting at index `i`. */
function processGlobToken(glob: string, i: number): GlobTokenResult {
	const ch = glob[i] as string;
	if (ch === "*") return processStarToken(glob, i);
	if (ch === "?") return { appended: "[^/]", nextIndex: i + 1 };
	if (ch === "[") return processBracketToken(glob, i);
	if (ch === "{") return processBraceToken(glob, i);
	return { appended: escapeRegexChar(ch), nextIndex: i + 1 };
}

/**
 * Translate a glob into the body of an anchored regex (no leading `^` /
 * trailing `$`). Throws on syntax errors so the caller can fall back to a
 * "match nothing" regex rather than silently misbehaving.
 */
function globToRegexSource(glob: string): string {
	let out = "";
	let i = 0;
	const len = glob.length;
	while (i < len) {
		const { appended, nextIndex } = processGlobToken(glob, i);
		out += appended;
		i = nextIndex;
	}
	return out;
}

/** Find the matching `}` for the `{` at `start`, accounting for nesting. */
function findMatchingBrace(glob: string, start: number): number {
	let depth = 0;
	for (let i = start; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Split a brace-body on commas at depth 0 (so `{a,{b,c}}` stays grouped). */
function splitTopLevelCommas(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}

/**
 * Compile a glob into a RegExp, caching the result keyed on the glob string
 * so subsequent calls with the same pattern are O(1).
 *
 * Invalid syntax (unterminated brackets, `[a-z]` ranges, etc.) maps to a
 * never-match regex rather than throwing — `skip_paths` is best-effort
 * configuration; one bad entry should not silently widen the skip surface.
 */
export function compileGlob(glob: string): RegExp {
	const cached = GLOB_REGEX_CACHE.get(glob);
	if (cached) return cached;
	let regex: RegExp;
	try {
		const source = globToRegexSource(glob);
		// Reason: `source` is built from the glob via escapeRegexChar; metachars
		// are bounded into known shapes. Anchored full-string match.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		regex = new RegExp(`^${source}$`);
	} catch {
		regex = NEVER_MATCH_REGEX;
	}
	GLOB_REGEX_CACHE.set(glob, regex);
	return regex;
}

/** Test whether `path` matches the single glob `glob`. */
export function matchesGlob(path: string, glob: string): boolean {
	if (!glob) return false;
	return compileGlob(glob).test(path);
}

/** Test whether `path` matches any glob in `globs`. Empty list → false. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
	if (globs.length === 0) return false;
	for (const g of globs) {
		if (matchesGlob(path, g)) return true;
	}
	return false;
}

/** Reset the compiled-glob cache (test/teardown helper). */
export function _resetGlobCache(): void {
	GLOB_REGEX_CACHE.clear();
}

/** Inspect the compiled-glob cache size (test helper). */
export function _globCacheSize(): number {
	return GLOB_REGEX_CACHE.size;
}
