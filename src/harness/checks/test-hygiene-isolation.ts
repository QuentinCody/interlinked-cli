// Test-file hygiene checks — isolation & determinism family (Batch 2).
//
// The "tests must be deterministic & isolated" group: detectors that fire on
// test files where a test reaches real network/filesystem, depends on wall-clock
// or randomness, hardcodes a millisecond sleep, or shells out to a known-slow
// subprocess without an explicit timeout. All are <1ms regex-based.
//
// Public symbols are re-exported from `test-hygiene.ts` (the barrel) so the
// check registry and every importer stay unchanged.

import { nonNull } from "../../lib/non-null.js";
import { collectElapsedTimeAnchors, isElapsedTimeLine } from "./shared-scan.js";
import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
import {
	findCallSpan,
	IT_TEST_OPEN_RE,
	stripPreservingOffsets,
} from "./test-hygiene-shared.js";

// Sandbox-fragility framing (measurement integrity — bug #13,
// scratch/fleet-r3/repair-followups.txt): a real fs write, a real timer, or
// a real subprocess spawn inside a test is not just flaky under CI — it can
// also time out Stryker's mutation dry run (30s per-test cap,
// vitest.stryker.config.ts) and poison kill-measurement for the whole file
// the test lives in. Appended to the relevant messages below so the fault
// surfaces on the EDIT path, before any measurement ever runs. Defined once
// so the detectors stay word-for-word identical rather than four
// independently-drifting copies (see slow-test-stop-check.ts for the
// Stop-time counterpart that catches this from measured durations).
const SANDBOX_FRAGILITY_NOTE =
	"Also risks timing out Stryker's mutation dry run (30s/test cap) and poisoning kill-measurement for the whole file.";

// ==========================================================================
// 2. Real network / filesystem in tests
// ==========================================================================
// `fetch(`, `http.request(`, `https.request(`, `writeFileSync` to non-tmp
// paths inside test files. Allowlist localhost / 127.0.0.1 / os.tmpdir() /
// __fixtures__ / tmp/ paths. Hits = flaky test or test that hits the real
// internet.

const NETWORK_CALL_RE =
	/\b(?:fetch|axios\s*\.\s*(?:get|post|put|patch|delete|request)|got|node-fetch|undici\.fetch|https?\.(?:request|get))\s*\(/;
const HTTP_LITERAL_URL_RE = /["'`](https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0))[^"'`]+)["'`]/;

// Group 1 = the fs verb, group 2 = the path literal. Capturing the verb lets us
// drop calls to a locally-defined helper of the same name (see FS_HELPER_DEF_RE).
const FS_WRITE_RE =
	/\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\s*\(\s*["'`]([^"'`]+)["'`]/;
// Call token only (no path arg) — tested against the comment/string-stripped
// line to confirm the write is REAL code and not a write quoted inside a string
// fixture (e.g. a detector's own test feeding `writeFileSync("/etc/passwd")` as
// sample data). The path itself is then read back from the original line.
const FS_WRITE_CALL_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\s*\(/;
// A test that defines its own `function writeFile(name)` / `const writeFile = …`
// is almost always a tmpdir-scoped wrapper (`join(tmpDir, name)`); its bare-name
// call sites pass a relative leaf, not a real path. Calls to such locally-defined
// helpers are NOT raw node:fs I/O, so exclude those verb names for this file.
const FS_HELPER_DEF_RE =
	/\b(?:function|const|let|var)\s+(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\b/g;
const TMP_PATH_RE = /(?:^|[/\\])(?:tmp|__fixtures__|fixtures|tmp\/|\.tmp|os\.tmpdir|tmpdir)/i;

/** Network-call finding for one line, or null if the line has no flaggable
 *  network call. Only fires if the ORIGINAL line contains a URL pointing
 *  somewhere that isn't localhost / 127.0.0.1 / 0.0.0.0. */
function realNetworkCallMatch(strippedLine: string, originalLine: string): InlineMatch | null {
	if (!NETWORK_CALL_RE.test(strippedLine)) return null;
	const urlMatch = HTTP_LITERAL_URL_RE.exec(originalLine);
	if (!urlMatch) return null;
	return {
		line: 0, // caller fills in the real line number
		text: `real network call in test (${nonNull(urlMatch[1]).slice(0, 80)}). Mock with msw / fetch-mock / nock — real upstreams make tests flaky.`,
	};
}

/** FS-write finding for one line, or null. Requires the call to survive in
 *  the STRIPPED line (real code, not a write quoted inside a string
 *  fixture), then reads the path literal from the original line. Only
 *  flags paths outside a tmp / fixtures dir and not a locally-defined
 *  wrapper helper. */
function realFsWriteMatch(
	strippedLine: string,
	originalLine: string,
	localFsHelpers: ReadonlySet<string>,
): InlineMatch | null {
	if (!FS_WRITE_CALL_RE.test(strippedLine)) return null;
	const fsMatch = FS_WRITE_RE.exec(originalLine);
	if (!fsMatch) return null;
	const verb = nonNull(fsMatch[1]);
	const target = nonNull(fsMatch[2]);
	const isMemberCall = originalLine[fsMatch.index - 1] === ".";
	const isLocalHelper = !isMemberCall && localFsHelpers.has(verb);
	if (isLocalHelper || TMP_PATH_RE.test(target) || target.startsWith("/tmp")) return null;
	return {
		line: 0, // caller fills in the real line number
		text: `test writes to real filesystem path "${target.slice(0, 80)}". Use os.tmpdir() / a __fixtures__ dir / a memfs mock. ${SANDBOX_FRAGILITY_NOTE}`,
	};
}

/** One entry's finding (network takes priority over FS, matching the
 *  original loop's early `continue` after a network match), or null. */
function realIoMatchForEntry(
	i: number,
	strippedLine: string,
	original: readonly string[],
	localFsHelpers: ReadonlySet<string>,
): InlineMatch | null {
	const originalLine = nonNull(original[i]);
	const netMatch = realNetworkCallMatch(strippedLine, originalLine);
	const match = netMatch ?? realFsWriteMatch(strippedLine, originalLine, localFsHelpers);
	if (!match) return null;
	return { ...match, line: i + 1 };
}

/** Public API — flags real-network/FS calls in test files. */
export function checkRealIoInTests(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	// Names the file defines itself — calls to these are wrapper helpers, not
	// raw node:fs writes. Scan the literal-stripped content so a verb mentioned
	// inside a string/comment doesn't register as a definition.
	const localFsHelpers = new Set<string>();
	for (const m of stripped.matchAll(FS_HELPER_DEF_RE)) localFsHelpers.add(nonNull(m[1]));

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= MAX_MATCHES) break;
		const match = realIoMatchForEntry(i, line, original, localFsHelpers);
		if (match) matches.push(match);
	}
	return matches;
}

// ==========================================================================
// 3. Date.now / Math.random in test bodies
// ==========================================================================
// Same pattern as Batch 1's untestable_time_in_source, scoped to test
// files. Tests using these globals directly are flake breeders.

const TEST_NONDETERMINISM_RE =
	/\b(?:Date\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)|Math\s*\.\s*random\s*\(|crypto\s*\.\s*randomUUID\s*\(|crypto\s*\.\s*randomBytes\s*\(|performance\s*\.\s*now\s*\()/;

// Inside common mock-setup APIs, these are fine.
const MOCK_SETUP_LINE_RE =
	/\b(?:vi|jest)\s*\.\s*(?:setSystemTime|useFakeTimers|useRealTimers|spyOn|mock)\b/;

// --- FP refinements (2026-07, from the verify-noise calibration run) ---
//
// (a) Elapsed-time measurement: `const start = Date.now(); …; Date.now() - start`
//     subtracts two reads — the wall-clock value never flows into an assertion
//     as an absolute, and fake timers would DEFEAT a perf-budget benchmark.
//     Both the anchor assignment and the subtraction line are exempt.
// (b) File-level fake clock: vi.setSystemTime pins Date at the global level
//     just like useFakeTimers — either directive suppresses the whole file.
// (c) Unique fixture names: Date.now()/randomUUID concatenated into a string
//     (tmp-dir suffixes, session ids) is identity generation, not a value the
//     test asserts on. Lines that ALSO assert keep firing.

const FAKE_CLOCK_FILE_RE =
	/\b(?:vi|jest)\s*\.\s*(?:useFakeTimers|setSystemTime)\b/;

// The elapsed-duration pair (refinement (a)) now lives in `shared-scan.ts` —
// `checkUntestableTimeInSource`, the non-test twin this check was modeled on,
// needs exactly the same exemption and the two must not drift.

// The nondeterminism call chain, as it appears mid-expression.
const NONDET_CALL_FRAG = String.raw`(?:Date\s*\.\s*now|Math\s*\.\s*random|crypto\s*\.\s*randomUUID|randomUUID|performance\s*\.\s*now)\s*\(`;
// String-adjacency on the ORIGINAL line (the stripped view blanks literals):
// a quoted literal concatenated with the call, or the call inside a `${…}`
// template interpolation — the unique-fixture-name shape.
const UNIQUE_NAME_BUILD_RE = new RegExp(
	`["'\`]\\s*\\+\\s*[^;]{0,60}${NONDET_CALL_FRAG}|${NONDET_CALL_FRAG}[^;]{0,60}\\+\\s*["'\`]|\\$\\{[^{}]{0,80}${NONDET_CALL_FRAG}`,
);
const LINE_ASSERTS_RE = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/;

// `const id = …` / `let x = …` — the identifier a unique-name line binds the
// nondeterministic value into. Only a simple single-binding assignment; a shape
// we can't name conservatively yields null (which keeps the exemption).
const CAPTURE_ASSIGN_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

/** The identifier a `const/let/var IDENT = …` line binds, or null. */
function capturedIdent(originalLine: string): string | null {
	const m = CAPTURE_ASSIGN_RE.exec(originalLine);
	return m ? nonNull(m[1]) : null;
}

/** True when `ident` appears as a standalone reference (not a `.prop` access nor
 *  a substring of a longer name) on any of the given assertion lines. */
function identReferencedInAssertions(ident: string, assertLines: readonly string[]): boolean {
	const escaped = ident.replace(/[$]/g, "\\$");
	const refRe = new RegExp(`(?<![.\\w$])${escaped}(?![\\w$])`);
	return assertLines.some((line) => refRe.test(line));
}

/** True when this line binds the nondeterministic value into an identifier that
 *  a later assertion references — i.e. the value flows into an assertion. */
function capturedValueIsAsserted(originalLine: string, assertLines: readonly string[]): boolean {
	const ident = capturedIdent(originalLine);
	return ident !== null && identReferencedInAssertions(ident, assertLines);
}

/** True when the call on this line only builds a unique name string (path /
 *  session-id suffix) and that value is never asserted — identity, not behavior.
 *  A value captured here and referenced on a LATER assertion line is NOT exempt:
 *  the test then checks a nondeterministic value (the flake this check exists to
 *  catch), and a non-asserting capture line is no license to escape. */
function isUniqueNameBuilderLine(
	originalLine: string,
	assertLines: readonly string[],
): boolean {
	if (LINE_ASSERTS_RE.test(originalLine)) return false;
	if (!UNIQUE_NAME_BUILD_RE.test(originalLine)) return false;
	if (capturedValueIsAsserted(originalLine, assertLines)) return false;
	return true;
}

/** Public API — flags Date.now / Math.random in test code without mocking. */
export function checkTestNondeterminism(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	// If the file installs a fake clock (useFakeTimers / setSystemTime), Date
	// is mocked at the global level — suppress the check entirely for the file.
	if (FAKE_CLOCK_FILE_RE.test(stripped)) return [];

	const elapsedAnchors = collectElapsedTimeAnchors(stripped);
	// Assertion lines (stripped, so string contents can't masquerade as idents) —
	// a unique-name capture whose bound identifier is referenced here is NOT the
	// identity-only shape the exemption is for; the nondet value flows into a check.
	const assertLines = strippedLines.filter((line) => LINE_ASSERTS_RE.test(line));

	for (const [i, strippedLine] of strippedLines.entries()) {
		if (matches.length >= MAX_MATCHES) break;
		if (MOCK_SETUP_LINE_RE.test(strippedLine)) continue;
		const m = TEST_NONDETERMINISM_RE.exec(strippedLine);
		if (!m) continue;
		if (isElapsedTimeLine(strippedLine, elapsedAnchors)) continue;
		if (isUniqueNameBuilderLine(nonNull(original[i]), assertLines)) continue;
		matches.push({
			line: i + 1,
			text: `test uses ${m[0].replace(/\s+/g, "")} without mocking — use vi.setSystemTime / vi.useFakeTimers / a stubbed clock. ${nonNull(original[i]).trim().slice(0, 80)} ${SANDBOX_FRAGILITY_NOTE}`,
		});
	}
	return matches;
}

// ==========================================================================
// 4. Hardcoded setTimeout(_, NNNN) in tests
// ==========================================================================
// Tests waiting on a literal millisecond delay are a tell that the agent
// gave up debugging the timing condition. Allowlists `setTimeout(_, 0)`
// (microtask flush is legitimate).

const HARDCODED_TIMEOUT_RE =
	/\b(?:setTimeout|setImmediate)\s*\(\s*[^,)]+,\s*([1-9]\d*)\s*\)/;

/** Public API — flags hardcoded ms timeouts in test bodies. */
export function checkHardcodedTimeoutInTests(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (const [i, strippedLine] of strippedLines.entries()) {
		if (matches.length >= MAX_MATCHES) break;
		const m = HARDCODED_TIMEOUT_RE.exec(strippedLine);
		if (!m) continue;
		const ms = nonNull(m[1]);
		matches.push({
			line: i + 1,
			text: `hardcoded ${ms}ms wait in test — fix the timing condition (vi.waitFor / poll a deterministic predicate) instead of adding sleep. ${nonNull(original[i]).trim().slice(0, 80)} ${SANDBOX_FRAGILITY_NOTE}`,
		});
	}
	return matches;
}

// ==========================================================================
// 7. it() / test() spawning a known-slow subprocess with no explicit timeout
// ==========================================================================
// A vitest case whose callback shells out to a known-slow tool — `tsc`,
// `biome`, `npx`, `tsx`, `eslint`, `vitest`, or the project's own CLI — but
// relies on the default `testTimeout`. Under CI's worker cap a cold `tsc`
// start can exceed the 10s default and intermittently redden the suite (see
// the runPerFileChecks / write.test.ts / verify.test.ts pattern). An explicit
// `{ timeout: N }` (options-object form) or a trailing numeric-timeout
// argument suppresses the finding — that is the established fix.
//
// Deliberately scoped to KNOWN-SLOW invocations: spawning `tsc` is genuinely
// slow, spawning `echo` is not, so a `child_process` call to a trivial
// command does NOT fire — this keeps the false-positive rate low.

// child_process spawn primitives. `exec`/`execFile`/`spawn` are matched with
// a word boundary so member calls like `cp.execSync` and bare `execSync`
// both hit; the leading boundary keeps `myExec(` from matching.
const CHILD_PROCESS_SPAWN_RE =
	/\b(?:execSync|spawnSync|execFileSync|execFile|exec|spawn)\s*\(/;

// Known-slow tools. Each entry is matched as a shell token (start-of-string,
// whitespace, or a quote boundary on the left; whitespace / end / quote on
// the right) so `tsc` matches `npx tsc --noEmit` but not `tscfg` or a path
// fragment like `artscript`.
const SLOW_TOOL_RE =
	/(?:^|["'`\s/])(?:tsc|tsgo|biome|npx|tsx|eslint|vitest|vite|interlinked)(?:["'`\s]|$)/;

/** Public API — flags it()/test() spawning a slow subprocess with no explicit timeout. */
export function checkTestSubprocessDefaultTimeout(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	// The check only makes sense when child_process is in play at all — a cheap
	// pre-filter that skips the brace-matching scan for the common case.
	if (!/child_process/.test(content)) return [];

	// Offset-preserving strip — this function slices the ORIGINAL `content` at
	// positions found in the stripped text (to read real command-string
	// contents), so the two must stay index-aligned. `stripCommentsAndStrings`
	// collapses string literals and would drift the two out of sync as soon
	// as any earlier string in the file shrank.
	const stripped = stripPreservingOffsets(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const callName = m[1];
		// Index of the char right after the opening `(`.
		const argsStart = m.index + m[0].length;
		const span = findCallSpan(stripped, argsStart);
		if (span === null) {
			m = IT_TEST_OPEN_RE.exec(stripped);
			continue;
		}
		// The body region — the original (un-stripped) text so we can read the
		// real command-string contents to identify the slow tool.
		const bodyOriginal = content.slice(argsStart, span.end);
		const bodyStripped = stripped.slice(argsStart, span.end);

		// A spawn call has to be present as real code (stripped view), and the
		// slow-tool token has to be present in the original (string contents
		// survive there). Both conditions guard against fixture-string FPs.
		const spawnsSubprocess =
			CHILD_PROCESS_SPAWN_RE.test(bodyStripped) && SLOW_TOOL_RE.test(bodyOriginal);
		if (spawnsSubprocess && !hasExplicitTimeout(stripped, argsStart, span)) {
			const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `\`${callName}(...)\` spawns a known-slow subprocess (tsc / biome / npx / tsx / eslint / vitest / the CLI) but has no explicit timeout — under CI's worker cap a cold start can exceed the default testTimeout and flake. Pass an options object: \`${callName}(name, { timeout: 60_000 }, fn)\`. ${SANDBOX_FRAGILITY_NOTE}`,
			});
		}
		m = IT_TEST_OPEN_RE.exec(stripped);
	}
	return matches;
}

// An object literal carrying a `timeout:` key — the vitest options-object form
// `it(name, { timeout: N }, fn)`.
const TIMEOUT_OPTION_RE = /\{[^{}]*\btimeout\s*:/;
// A trailing numeric (or numeric-separator) literal as the last argument:
// `it(name, fn, 60_000)` / `it(name, fn, 30000)`.
const TRAILING_NUMERIC_RE = /^\s*[0-9][0-9_]*\s*$/;

/**
 * True when an `it(...)` / `test(...)` call declares an explicit timeout —
 * either the `{ timeout: N }` options-object argument or a trailing numeric
 * timeout argument. Both are the documented vitest ways to override the
 * default, so either one means the author opted in deliberately.
 */
function hasExplicitTimeout(
	stripped: string,
	argsStart: number,
	span: { end: number; topLevelCommas: number[] },
): boolean {
	const argRegion = stripped.slice(argsStart, span.end);
	// Options-object form: a `{ ... timeout: ... }` anywhere in the arg list.
	if (TIMEOUT_OPTION_RE.test(argRegion)) return true;
	// Trailing-numeric form: text of the final argument is a bare number.
	if (span.topLevelCommas.length > 0) {
		const lastComma = nonNull(span.topLevelCommas[span.topLevelCommas.length - 1]);
		const lastArg = stripped.slice(lastComma + 1, span.end);
		if (TRAILING_NUMERIC_RE.test(lastArg)) return true;
	}
	return false;
}
