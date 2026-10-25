// Testing-specific checks (snapshot, test-importing-test, excessive useEffect).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
import { buildLineIndex } from "./shared-text-utils.js";

// ===========================================
// Testing Checks
// ===========================================

/**
 * Every snapshot-matcher call. The inline matchers are classified further by
 * {@link inlineSnapshotRecordedInSource}; the others always store their
 * expected value OUTSIDE the test source (a `__snapshots__` file, an external
 * file, or node:test's snapshot store) and so are always opaque.
 */
const SNAPSHOT_CALL_RE =
	/\b(?:toMatchSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot|assert\.snapshot)\s*\(/g;

const INLINE_SNAPSHOT_NAMES = new Set(["toMatchInlineSnapshot", "toThrowErrorMatchingInlineSnapshot"]);

/** An assertion call of any kind — the denominator for the snapshot share. */
const ASSERTION_CALL_RE = /\b(?:expect(?:TypeOf)?|assert(?:\.\w+)?)\s*\(/g;

/** Furthest the argument lookahead walks past an inline matcher's `(`. */
const INLINE_ARG_LOOKAHEAD = 4000;

function skipWhitespace(text: string, from: number, limit: number): number {
	let i = from;
	while (i < limit && /\s/.test(nonNull(text[i]))) i++;
	return i;
}

/** The opening delimiter of a string or template literal (survives stripping). */
const LITERAL_DELIMITERS = new Set(["`", '"', "'"]);

/**
 * Offset of the top-level `,` or `)` that ends the call argument starting at
 * `from`, or -1 within `limit`. Brackets of every kind are balanced; strings
 * are already blanked, so a bracket inside one cannot unbalance the walk.
 */
function argumentEnd(text: string, from: number, limit: number): number {
	let depth = 0;
	for (let i = from; i < limit; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) return ch === ")" ? i : -1;
			depth--;
		} else if (ch === "," && depth === 0) return i;
	}
	return -1;
}

/**
 * Whether an inline snapshot call carries its expected value in the test
 * source. `toMatchInlineSnapshot(\`...\`)` is `toEqual` with serialization
 * help: the literal is reviewable in a diff, so it is an explicit assertion.
 * The expected value is in source only when the FIRST argument is a string
 * or template literal, or when the first argument is property matchers (an
 * object or an identifier) and the SECOND is one. An empty slot
 * (`toMatchInlineSnapshot()`, filled by the runner on first run), matchers
 * alone, or an identifier (`toMatchInlineSnapshot(expected)`) keeps the
 * expected value out of the call, so it stays opaque. `text` is the
 * comment-and-string-STRIPPED content (delimiters survive), and `argStart`
 * is the offset just past the matcher's `(`.
 */
function inlineSnapshotRecordedInSource(text: string, argStart: number): boolean {
	const limit = Math.min(text.length, argStart + INLINE_ARG_LOOKAHEAD);
	const first = skipWhitespace(text, argStart, limit);
	if (first >= limit) return false;
	if (LITERAL_DELIMITERS.has(nonNull(text[first]))) return true;
	const end = argumentEnd(text, first, limit);
	if (end < 0 || text[end] !== ",") return false;
	const second = skipWhitespace(text, end + 1, limit);
	return second < limit && LITERAL_DELIMITERS.has(nonNull(text[second]));
}

/**
 * Detect excessive snapshot assertions — use explicit assertions instead.
 *
 * Two rules:
 * - OPAQUE: fires at 5 opaque snapshots — file snapshots (`toMatchSnapshot`,
 *   `toMatchFileSnapshot`, `toThrowErrorMatchingSnapshot`, `assert.snapshot`)
 *   and inline calls with no literal in source (an empty slot, matchers only,
 *   an identifier). No ratio exemption: an expected value nobody reviews is
 *   the smell however many explicit assertions sit beside it.
 * - SNAPSHOT-ONLY FILE: an inline snapshot that carries its literal in source
 *   is a `toEqual` (zod's issue arrays and ISO strings), so it counts only
 *   when snapshots of any kind are at least 10 AND 90% of the file's
 *   assertion calls — a file that is a transcript of serialized output and
 *   states no property of its own (zod continuability.test.ts, 16 of 16).
 *   The adjudicated zod false positives sit at 6–50% (array, codec, default,
 *   discriminated-unions, error-utils, string-formats, to-json-schema).
 * Comments are stripped first, so a commented-out call is not counted.
 */
export function checkSnapshotOveruse(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const { opaqueLines, snapshotLines } = classifySnapshotCalls(stripped);
	const assertionCalls = Math.max(
		snapshotLines.length,
		Array.from(stripped.matchAll(ASSERTION_CALL_RE)).length,
	);
	const anchorOf = (line: number): string => nonNull(content.split("\n")[line - 1]).trim().slice(0, 150);
	const percent = (n: number): number => Math.round((n / Math.max(1, assertionCalls)) * 100);

	const firstOpaque = opaqueLines[0];
	if (opaqueLines.length >= OPAQUE_SNAPSHOT_THRESHOLD && firstOpaque !== undefined) {
		return [
			{
				line: firstOpaque,
				text: `[${opaqueLines.length} snapshot assertions recorded outside the test source (${percent(opaqueLines.length)}% of its assertions) — snapshots test nothing meaningful. Use explicit assertions, or inline the expected value] ${anchorOf(firstOpaque)}`,
			},
		];
	}

	const firstSnapshot = snapshotLines[0];
	const snapshotOnly =
		snapshotLines.length >= SNAPSHOT_ONLY_FILE_THRESHOLD &&
		snapshotLines.length >= SNAPSHOT_ONLY_FILE_SHARE * assertionCalls;
	if (!snapshotOnly || firstSnapshot === undefined) return [];
	return [
		{
			line: firstSnapshot,
			text: `[${snapshotLines.length} snapshot assertions are ${percent(snapshotLines.length)}% of its assertions — the file pins serialized output and states no property of its own. Use explicit assertions for the behavior under test] ${anchorOf(firstSnapshot)}`,
		},
	];
}

/** Opaque snapshots that alone make a file "overuse". */
const OPAQUE_SNAPSHOT_THRESHOLD = 5;
/** Snapshots of any kind that make a SNAPSHOT-ONLY file (twice the opaque bar: a literal is reviewable). */
const SNAPSHOT_ONLY_FILE_THRESHOLD = 10;
/** Share of the file's assertion calls that snapshots must reach for the snapshot-only rule. */
const SNAPSHOT_ONLY_FILE_SHARE = 0.9;

/** 1-based lines of every snapshot call, and of the opaque subset, in `stripped`. */
function classifySnapshotCalls(stripped: string): { opaqueLines: number[]; snapshotLines: number[] } {
	const lineIndex = buildLineIndex(stripped);
	const opaqueLines: number[] = [];
	const snapshotLines: number[] = [];
	for (const match of stripped.matchAll(SNAPSHOT_CALL_RE)) {
		const line = lineIndex.lineAt(match.index);
		snapshotLines.push(line);
		const name = match[0].replace(/\s*\($/, "");
		const argStart = match.index + match[0].length;
		if (INLINE_SNAPSHOT_NAMES.has(name) && inlineSnapshotRecordedInSource(stripped, argStart)) continue;
		opaqueLines.push(line);
	}
	return { opaqueLines, snapshotLines };
}

/** Matches an `import(...)`, side-effect `import "..."`, or `require(...)`
 *  call whose path literal contains `.test.` or `.spec.`. Structural gap
 *  (unchanged from the original detector): does NOT match ES named/default
 *  import syntax (`import { x } from "./x.test.ts"`) because "import" is not
 *  immediately followed by the quote there — only the forms above are
 *  matched. */
const TEST_IMPORT_PATH_RE = /(?:import|require)\s*\(?['"]\S*\.(?:test|spec)\./;

/** A bare `import`/`require` keyword, used against the STRIPPED line to
 *  decide whether a line is live code at all. */
const IMPORT_KEYWORD_RE = /\b(?:import|require)\b/;

/**
 * Detect test files importing from other test files — extract to shared helpers.
 *
 * `stripCommentsAndStrings` blanks the CONTENTS of every string literal (so
 * `"./x.test.ts"` becomes `""`), which erases the `.test.`/`.spec.` token the
 * path regex needs — matching {@link TEST_IMPORT_PATH_RE} against the
 * stripped line can therefore never fire on well-formed code. Instead: check
 * the STRIPPED line only for the presence of the `import`/`require` keyword
 * (comment-stripping blanks whole commented-out lines, so a commented-out
 * import's keyword is gone from the stripped line and never passes this
 * gate — same for a keyword that appears only inside a string literal, since
 * that literal's entire contents are blanked too), then match the actual
 * `.test.`/`.spec.` path against the ORIGINAL line, which is the only place
 * the path substring survives.
 */
export function checkTestImportingTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 10;
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const strippedLine = nonNull(strippedLines[i]);
		const originalLine = nonNull(originalLines[i]);
		if (!IMPORT_KEYWORD_RE.test(strippedLine)) continue;
		if (TEST_IMPORT_PATH_RE.test(originalLine)) {
			matches.push({ line: i + 1, text: originalLine.trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect components with too many useEffect hooks — a sign the effects
 * should be consolidated into custom hooks or the component should be split.
 *
 * Threshold: 6+ useEffect calls triggers a warning.
 * Only fires on .tsx/.jsx files (React components). Skips test files.
 */
export function checkExcessiveUseEffect(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let count = 0;
	const WARNING_THRESHOLD = 6;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/\buseEffect\s*\(/.test(trimmed)) {
			count++;
		}
	}

	if (count >= WARNING_THRESHOLD) {
		// Report the first useEffect line as the anchor with the total count
		for (const [i, line] of lines.entries()) {
			if (/\buseEffect\s*\(/.test(line.trim())) {
				matches.push({
					line: i + 1,
					text: `[${count} useEffect hooks — consider custom hooks or consolidating] ${line.trim().slice(0, 100)}`,
				});
				break;
			}
		}
	}

	return matches;
}
