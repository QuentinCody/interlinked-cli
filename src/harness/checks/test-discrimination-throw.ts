// CLASS: matching error messages may leave multiple guards indistinguishable.
// FIRES WHEN: a literal/regex toThrow assertion matches two or more throw sites
// in the resolved SUT callee, including one hop into same-file helpers.
// DOES NOT FIRE: one matching site, bare toThrow, dynamic/unresolvable messages,
// an unresolvable callee/SUT, or unsupported/non-test source.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | file-wide | 12/unknown | not independently measured | unrelated callees |
// | call-scoped | 2/1 | 2/2 reviewed TP | reachable function text only |
// KNOWN GAPS: SUT lookup is filename-based and call resolution is textual;
// equal messages do not prove that both paths are feasible for the tested input.
// HOW TO EXTEND: extend callee or message parsing with P/N fixtures; preserve
// uncertainty exemptions. Census: scripts/scan-test-discrimination.ts.

import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS, stripComments } from "./shared.js";
import { offsetToLine } from "./shared-text-utils.js";
import { calleeNameNearOffset, throwSitesReachableFrom } from "./test-discrimination-throw-scope.js";
import { collectThrowSites, extractBalancedArgs, parseLeadingLiteral, type ThrowSite } from "./test-discrimination-throw-shared.js";

const MAX_MATCHES = 10;
const REPORT_LINE_TRUNC = 150;
const SUT_CANDIDATE_EXTS = [".ts", ".tsx", ".mts", ".js"];

/** An assertion's asserted value, resolved to a comparable literal or regex. */
type AssertedLiteral = { kind: "string"; value: string } | { kind: "regex"; source: string; flags: string };

// ─── Assertion parsing (test file) ──────────────────────────────────────────

const ASSERTION_RE = /\.(?:toThrowError|toThrow)\s*\(/g;
const REGEX_LITERAL_RE = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)$/i;
// Deliberately excludes `RegExp` — `toThrow(new RegExp(...))` builds a pattern,
// not an error-message wrapper, and treating its dynamic template as a plain
// string literal produced a false "includes" match (found via calibration:
// `new RegExp(\`refusing ${n} ...\`)` truncated to the prefix "refusing " and
// then substring-matched an unrelated "refusing to retain keys from " site).
const NEW_ERROR_PREFIX_RE = /^new\s+(?!RegExp\b)[\w$.]+\s*\(/;

/** `toThrow(/re/flags)` → a validated regex literal, or null (invalid pattern
 *  or not a regex-shaped argument). */
function parseRegexAssertion(trimmed: string): AssertedLiteral | null {
	const regexMatch = REGEX_LITERAL_RE.exec(trimmed);
	if (!regexMatch) return null;
	const source = regexMatch[1];
	const flags = regexMatch[2] ?? "";
	if (source === undefined) return null;
	try {
		// SAFETY: constructing the RegExp here only VALIDATES source/flags — an
		// invalid pattern throws and is caught below; the object itself is
		// discarded and rebuilt per-comparison in countMatchingThrowSites.
		new RegExp(source, flags);
	} catch (e) {
		void e; // invalid regex literal — not a comparable assertion
		return null;
	}
	return { kind: "regex", source, flags };
}

/** `toThrow(new Error("..."))` / `toThrow(new SomeError(\`...\`))` → the
 *  wrapped literal's prefix, or null if the shape doesn't match. */
function parseWrappedErrorAssertion(trimmed: string): AssertedLiteral | null {
	const prefixMatch = NEW_ERROR_PREFIX_RE.exec(trimmed);
	if (!prefixMatch) return null;
	const inner = extractBalancedArgs(trimmed, prefixMatch[0].length - 1);
	if (inner === null) return null;
	const wrapped = parseLeadingLiteral(inner.trimStart());
	return wrapped === null ? null : { kind: "string", value: wrapped.prefix };
}

/** Parse a `toThrow(...)` argument string into a comparable literal, or null. */
function parseAssertedLiteral(argsText: string): AssertedLiteral | null {
	const trimmed = argsText.trim();
	if (trimmed === "") return null; // bare toThrow() — not discriminating on message

	const regex = parseRegexAssertion(trimmed);
	if (regex !== null) return regex;

	const direct = parseLeadingLiteral(trimmed);
	if (direct !== null && direct.end === trimmed.length) {
		return { kind: "string", value: direct.prefix };
	}

	return parseWrappedErrorAssertion(trimmed);
}

interface AssertionSite {
	offset: number;
	literal: AssertedLiteral;
}

/** Find every well-formed `toThrow`/`toThrowError` assertion (comments masked). */
function collectAssertionSites(testContent: string): { stripped: string; sites: AssertionSite[] } {
	const stripped = stripComments(testContent);
	const sites: AssertionSite[] = [];
	let m: RegExpExecArray | null = ASSERTION_RE.exec(stripped);
	while (m !== null) {
		const openIdx = m.index + m[0].length - 1;
		const args = extractBalancedArgs(stripped, openIdx);
		if (args !== null) {
			const literal = parseAssertedLiteral(args);
			if (literal !== null && !(literal.kind === "string" && literal.value.trim() === "")) {
				sites.push({ offset: m.index, literal });
			}
		}
		m = ASSERTION_RE.exec(stripped);
	}
	return { stripped, sites };
}

// ─── SUT resolution ──────────────────────────────────────────────────────────

const TEST_SUFFIX_RE = /\.(test|spec)\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** Candidate SUT file paths for a test file path, per the naming convention. */
function resolveSutCandidates(filePath: string): string[] {
	const normalized = filePath.replace(/\\/g, "/");
	const dir = dirname(normalized);
	const fileName = basename(normalized);
	const base = fileName.replace(TEST_SUFFIX_RE, "");
	if (base === fileName) return []; // doesn't follow the *.test.* / *.spec.* convention
	const parts = dir.split("/");
	const parentDir = parts[parts.length - 1] === "__tests__" ? dirname(dir) : dir;
	return SUT_CANDIDATE_EXTS.map((ext) => join(parentDir, `${base}${ext}`));
}

/** Read the first SUT candidate that exists, or null. Never throws. */
function readSutContent(filePath: string): { path: string; content: string } | null {
	for (const candidate of resolveSutCandidates(filePath)) {
		try {
			const content = readFileSync(candidate, "utf-8");
			return { path: candidate, content };
		} catch (e) {
			// Extension miss (ENOENT, most commonly) — try the next candidate.
			// Not logged: this is the expected, non-exceptional path for every
			// extension but (at most) one.
			void e;
		}
	}
	return null;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** Count SUT throw sites whose message matches `literal`. */
function countMatchingThrowSites(literal: AssertedLiteral, sites: ThrowSite[]): number {
	if (literal.kind === "string") {
		return sites.filter((s) => s.message.includes(literal.value)).length;
	}
	let count = 0;
	for (const s of sites) {
		try {
			if (new RegExp(literal.source, literal.flags).test(s.message)) count++;
		} catch (e) {
			// Already validated at parse time in parseRegexAssertion — this
			// branch is unreachable in practice, but a bad regex here must
			// never throw out of a check, so it's counted as a non-match.
			void e;
		}
	}
	return count;
}

interface MatchBuildCtx {
	sutName: string;
	stripped: string;
	rawLines: string[];
}

/** Build one report line for an offending assertion. */
function buildMatch(site: AssertionSite, count: number, ctx: MatchBuildCtx): InlineMatch {
	const lineNo = offsetToLine(ctx.stripped, site.offset);
	const rawText = (ctx.rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	const reason = `duplicate_throw_message_assertion: matches ${count} throw sites in ${ctx.sutName} with the same message — deleting one guard leaves this test green`;
	return { line: lineNo, text: `${reason} — ${rawText}`.slice(0, REPORT_LINE_TRUNC) };
}

/** Public API — flags a `toThrow`/`toThrowError` assertion whose callee
 *  resolves to a SUT function/method with ≥2 matching throw sites inside its
 *  own body (plus one helper hop — see module docs). An unresolvable callee
 *  never fires: precision over recall. */
export function checkDuplicateThrowMessageAssertion(content: string, filePath: string): InlineMatch[] {
	try {
		if (!isTestFile(filePath)) return [];
		if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

		const sut = readSutContent(filePath);
		if (sut === null) return [];
		const strippedSut = stripComments(sut.content);
		// Cheap upfront bail: a function-scoped count can never exceed the
		// file's total, so a file with under 2 throw sites can never match.
		if (collectThrowSites(strippedSut).length < 2) return [];

		const { stripped, sites } = collectAssertionSites(content);
		const ctx: MatchBuildCtx = { sutName: basename(sut.path), stripped, rawLines: content.split("\n") };
		const matches: InlineMatch[] = [];
		for (const site of sites) {
			if (matches.length >= MAX_MATCHES) break;
			const name = calleeNameNearOffset(stripped, site.offset);
			if (name === null) continue; // callee not resolvable — do not fire
			const throwSites = throwSitesReachableFrom(strippedSut, name);
			if (throwSites === null) continue; // callee not found in the SUT — do not fire
			const count = countMatchingThrowSites(site.literal, throwSites);
			if (count < 2) continue;
			matches.push(buildMatch(site, count, ctx));
		}
		return matches;
	} catch (e) {
		// Any unexpected failure (fs error not covered above, regex engine
		// oddity, etc.) — fail closed. This is a heuristic advisory check, not
		// a compiler; a swallowed edge case here must never surface as a crash.
		void e;
		return [];
	}
}
