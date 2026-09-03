// I/O wrapper for the pure DRY clone detector (`dry.ts`).
//
// `dry.ts` is intentionally pure -- it never touches the filesystem. This
// module is the thin shell that the check registry calls: it reads the
// edited file's sibling files (same directory only -- the bounded candidate
// set the latency contract requires) and adapts `CloneFinding[]` to the
// `InlineMatch[]` shape every registered check returns.
//
// Sibling scan is deliberately shallow: same directory, JS/TS only, skipping
// the edited file itself, test files, and anything oversized. No recursion,
// no whole-repo walk -- O(files-in-one-directory), which is what keeps this
// inside the PostToolUse budget.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeCyclomaticComplexity, type FunctionComplexityEntry } from "./cyclomatic.js";
import type { CloneFinding, FunctionShingles } from "./dry.js";
import { extractFunctionShingles, findClones } from "./dry.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

/** Largest sibling file (bytes) we will read + tokenize. Skips bundles. */
const MAX_SIBLING_BYTES = 256 * 1024;

/** Cap on sibling files scanned, so a huge flat directory can't blow the budget. */
const MAX_SIBLINGS = 40;


/**
 * One clone finding rendered for the registry, plus an optional richer
 * `detail` string for surfaces that want more than the truncated `text` line
 * (the field is optional so callers/tests that only care about `text` are
 * unaffected).
 */
export interface CodeCloneMatch extends InlineMatch {
	detail?: string;
}

/**
 * Registered-check entry point for the DRY clone detector.
 * Public API -- consumed by `check-registry/entries-warnings.ts` and
 * `verify/file-checks.ts`.
 *
 * Returns one {@link InlineMatch} per edited-file function that has a
 * near-duplicate (>= the default Jaccard threshold) either elsewhere in the
 * same file or in a sibling file. Returns `[]` for unsupported extensions and
 * test files. Sibling-read failures are swallowed -- a clone check must never
 * break an edit.
 */
export function checkCodeClones(content: string, filePath: string): CodeCloneMatch[] {
	return checkCodeCloneFindings(content, filePath).map(formatCodeCloneFinding(filePath));
}

/**
 * Return raw clone findings for callers that need to apply a pre-edit
 * baseline before rendering the registered InlineMatch shape.
 */
export function checkCodeCloneFindings(content: string, filePath: string): CloneFinding[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const edited = extractFunctionShingles(content, filePath);
	if (edited.length === 0) return [];

	const candidates = collectSiblingFunctions(filePath);
	const findings = findClones({ edited, candidates });
	if (findings.length === 0) return findings;

	// Re-derive spans (line/endLine) for the edited file's own functions so we
	// can tell a genuine same-file duplicate pair from a function paired with
	// its own nested closure -- the latter is a detector-noise class, not a
	// clone: the outer function's body literally CONTAINS the inner one's
	// tokens, so Jaccard similarity is inflated by construction, not by copy.
	const spans = computeCyclomaticComplexity(content, filePath);
	if (spans.length === 0) return findings;
	return findings.filter((f) => !isNestingNoisePair(f, filePath, spans));
}

/**
 * True when a same-file clone pair is an artifact of nesting rather than
 * genuine duplication: either function is declared inside the other's span
 * (a function paired with its own inner closure -- the outer function's body
 * literally CONTAINS the inner one's tokens, so Jaccard similarity is
 * inflated by construction, provably so from the spans alone).
 *
 * Deliberately does NOT also suppress two anonymous callbacks that merely
 * share an enclosing parent: that shape has no structural guarantee of
 * token-set containment, so treating it as noise unconditionally discarded
 * genuine same-parent duplicate callbacks (e.g. two `rows.forEach(function
 * (row) { ... })` siblings with byte-for-byte identical bodies) -- a real
 * DRY violation, not detector noise. Only the provable containment case is
 * filtered here.
 */
function isNestingNoisePair(
	f: CloneFinding,
	filePath: string,
	spans: FunctionComplexityEntry[],
): boolean {
	if (f.otherFile !== filePath) return false;
	const a = spans.find((s) => s.line === f.line);
	const b = spans.find((s) => s.line === f.otherLine);
	if (!a || !b) return false;
	return isNestedWithin(a, b) || isNestedWithin(b, a);
}

/** True when `inner`'s span is strictly contained within `outer`'s span. */
function isNestedWithin(inner: FunctionComplexityEntry, outer: FunctionComplexityEntry): boolean {
	if (inner.line === outer.line) return false;
	return inner.line > outer.line && inner.endLine <= outer.endLine;
}

/** Adapt a raw clone pair to the generic registry InlineMatch shape. */
export function formatCodeCloneFinding(filePath: string): (finding: CloneFinding) => CodeCloneMatch {
	return (f) => {
		const where =
			f.otherFile === filePath
				? `same file (line ${f.otherLine})`
				: `${f.otherFile}:${f.otherLine}`;
		const pct = Math.round(f.similarity * 100);
		return {
			line: f.line,
			text: `${f.name}() is ${pct}% similar to ${f.otherName}() in ${where} -- extract the shared logic`,
			detail: `${f.name}() (line ${f.line}) duplicates ${f.otherName}() (line ${f.otherLine}) in ${where} at ${pct}% shingle similarity -- extract the shared logic into one helper both call.`,
		};
	};
}

/**
 * Read JS/TS sibling files in the edited file's directory and extract their
 * functions. Bounded, non-recursive. Any filesystem error is swallowed: the
 * candidate set just shrinks, the check still runs on within-file clones.
 */
export function collectSiblingFunctions(filePath: string): FunctionShingles[] {
	const dir = dirname(filePath);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Directory unreadable — fall back to within-file clone detection only.
		return [];
	}

	const out: FunctionShingles[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (scanned >= MAX_SIBLINGS) break;
		const sibPath = join(dir, entry);
		if (sibPath === filePath) continue;
		if (!JS_TS_EXTS.has(getExtension(sibPath))) continue;
		if (isTestFile(sibPath)) continue;

		const sibContent = readSiblingIfSmall(sibPath);
		if (sibContent === null) continue;
		scanned++;
		out.push(...extractFunctionShingles(sibContent, sibPath));
	}
	return out;
}

/**
 * Read a sibling file, or return `null` when it is missing, unreadable, or
 * larger than {@link MAX_SIBLING_BYTES}. Isolating the try/catch here keeps
 * the scan loop free of a swallowed-error block.
 */
function readSiblingIfSmall(sibPath: string): string | null {
	try {
		if (statSync(sibPath).size > MAX_SIBLING_BYTES) return null;
		return readFileSync(sibPath, "utf-8");
	} catch {
		// Unreadable sibling — skip it; the candidate set just shrinks.
		return null;
	}
}
