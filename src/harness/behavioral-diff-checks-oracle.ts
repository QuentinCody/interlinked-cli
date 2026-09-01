// ===========================================
// Test-oracle diff checks (commit gate)
// ===========================================
// Sibling of behavioral-diff-checks.ts (which sits at the 500-line cap).
// Home of the oracle-integrity checks from docs/design/test-oracle-integrity.md:
//
//   test_block_count_regression — REWRITTEN: commit-scoped and SUT-conditioned.
//     The naive per-file version ("test count dropped → flag") manufactures the
//     artifact it exists to catch (harness-anti-workaround.md class 4): deleting
//     a SUT should delete its tests, moving a suite between files is not a
//     deletion, and merging cases into an it.each table is a consolidation.
//     Only the UNEXPLAINED loss — SUT still exists, commit-wide net negative,
//     no .each introduced — is oracle erosion, and only that branch is an error
//     (blocks `git commit` under test_first_mode: "enforce").
//
//   assertion_count_regression — net expect()/assert count across staged test
//     files dropped while non-test source changed (the "deleted a lone expect"
//     case assertion_strength_weakening structurally cannot see).
//
//   assertion_value_swap — same subject, same matcher, different expected value
//     in one diff (toBe(5) → toBe(6) to match new behavior). Legitimate about
//     half the time (the spec really changed), so severity info — never blocks;
//     it exists to be the highest-signal line for a human or Tier-3 reviewer.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getStagedDiff } from "./behavioral-checks.js";
import { countAssertions } from "./behavioral-checks-tdd-assertions.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";

/** Same predicate as behavioral-diff-checks.ts (deliberate local copy — the
 *  sibling file is at the line cap and this one must not import its internals). */
const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

const TEST_BLOCK_INTRO_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*['"`]/;

const EACH_TABLE_RE = /\b(?:it|test|describe)\.each\s*(?:\(|`)/;

const JS_TS_SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** Injectable seams so the 200-commit history replay and tests can drive the
 *  pure classification without a live git index. */
export interface OracleDiffDeps {
	stagedDiff: (file: string) => string;
	sourceExists: (absPath: string) => boolean;
}

const DEFAULT_DEPS: OracleDiffDeps = {
	stagedDiff: getStagedDiff,
	sourceExists: existsSync,
};

interface FileDelta {
	file: string;
	plus: number;
	minus: number;
	net: number;
	addedEachTable: boolean;
}

function countMatchingLines(diff: string, re: RegExp): { plus: number; minus: number } {
	let plus = 0;
	let minus = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+") && re.test(line)) plus++;
		else if (line.startsWith("-") && re.test(line)) minus++;
	}
	return { plus, minus };
}

function testBlockDeltas(session: SessionTrajectory, deps: OracleDiffDeps): FileDelta[] {
	const deltas: FileDelta[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = deps.stagedDiff(file);
		if (!diff) continue;
		const { plus, minus } = countMatchingLines(diff, TEST_BLOCK_INTRO_RE);
		const addedEachTable = diff
			.split("\n")
			.some((l) => l.startsWith("+") && !l.startsWith("+++") && EACH_TABLE_RE.test(l));
		deltas.push({ file, plus, minus, net: plus - minus, addedEachTable });
	}
	return deltas;
}

/** Candidate companion-source paths for a test file (same-dir sibling and the
 *  `__tests__/` parent-dir convention), every JS/TS extension. */
export function companionSourceCandidates(testFile: string): string[] {
	const dir = dirname(testFile);
	const stem = basename(testFile).replace(/\.(test|spec)(?=\.)/, "");
	const stemNoExt = stem.replace(/\.[^.]+$/, "");
	const dirs = [dir];
	if (/(?:^|\/)__tests__$/.test(dir.replace(/\\/g, "/"))) dirs.push(dirname(dir));
	const out: string[] = [];
	for (const d of dirs) {
		for (const ext of JS_TS_SOURCE_EXTS) {
			out.push(join(d, `${stemNoExt}${ext}`));
		}
	}
	return out;
}

/** Classification for one losing file — exported for the history replay. */
type TestBlockLossKind =
	| "move"
	| "cascade"
	| "each_table"
	| "sut_shrank"
	| "declared_test_maintenance"
	| "unexplained";

/** Net content-line delta of the first existing companion source, or null when
 *  no companion exists. A strongly negative companion means behavior was
 *  deliberately removed — its tests correctly go with it (the 200-commit
 *  replay's `496834f` case: a dropped false-positive signal took −73 source
 *  lines and its 6 tests together). */
function companionNetLines(testFile: string, deps: OracleDiffDeps): number | null {
	const companion = companionSourceCandidates(testFile).find((c) => deps.sourceExists(c));
	if (!companion) return null;
	const diff = deps.stagedDiff(companion);
	if (!diff) return 0;
	let plus = 0;
	let minus = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) plus++;
		else if (line.startsWith("-")) minus++;
	}
	return plus - minus;
}

export function classifyTestBlockLoss(
	delta: FileDelta,
	commitNet: number,
	deps: OracleDiffDeps,
	commitType?: string | null,
): TestBlockLossKind {
	if (commitNet >= 0) return "move";
	const sutNet = companionNetLines(delta.file, deps);
	if (sutNet === null) return "cascade";
	if (delta.addedEachTable) return "each_table";
	// A `test:`-typed commit declares test maintenance (deleting a weak or
	// fake test IS oracle improvement — the replay's `faeb551` audit case).
	// The declared-intent escape is auditable in the commit message, and the
	// gaming combo — delete tests to hide breakage + label it test: — requires
	// prod changes in the same commit, which commit_message_diff_mismatch and
	// assertion_count_regression independently flag.
	if (commitType === "test") return "declared_test_maintenance";
	if (sutNet < 0) return "sut_shrank";
	return "unexplained";
}

const LOSS_MESSAGES: Record<Exclude<TestBlockLossKind, "unexplained">, string> = {
	move: "net test-block loss here is offset by gains in sibling test files this commit — reads as a move, not a deletion.",
	cascade:
		"companion source no longer exists — test removal reads as a deletion cascade, not oracle erosion.",
	each_table:
		"an it.each/test.each table was introduced in the same diff — reads as case consolidation.",
	sut_shrank:
		"the companion source also net-shrank in this commit — reads as tests following deliberately removed behavior. Confirm the removal was intended.",
	declared_test_maintenance:
		"this commit is test:-typed — declared test maintenance. Deleting a weak test is oracle improvement; the declaration is auditable in the message.",
};

/**
 * Public API — commit-gate check. Flags test files whose `it()`/`test()` count
 * dropped, SUT-conditioned per the header. Only the unexplained branch is an
 * error; explained losses surface as info so the reviewer still sees them.
 */
export function checkTestBlockCountRegression(
	session: SessionTrajectory,
	deps: OracleDiffDeps = DEFAULT_DEPS,
	commitType?: string | null,
): CheckResultEntry[] {
	const deltas = testBlockDeltas(session, deps);
	const commitNet = deltas.reduce((n, d) => n + d.net, 0);
	const results: CheckResultEntry[] = [];
	for (const d of deltas) {
		if (d.net >= 0) continue;
		const kind = classifyTestBlockLoss(d, commitNet, deps, commitType);
		if (kind === "unexplained") {
			results.push({
				source: "structural",
				name: "test_block_count_regression",
				severity: "error",
				message: `${basename(d.file)} removed ${-d.net} more test block(s) than it added (-${d.minus}, +${d.plus}) while its SUT still exists and no sibling gains or .each consolidation explain it. If a test is wrong, fix it; don't drop coverage to make the suite pass. ("0 tests skipped or deleted" — the Bun merge bar.)`,
				file: d.file,
				determinism: "fully_deterministic",
			});
			continue;
		}
		results.push({
			source: "structural",
			name: "test_block_count_regression",
			severity: "info",
			message: `${basename(d.file)} removed ${-d.net} test block(s): ${LOSS_MESSAGES[kind]}`,
			file: d.file,
			determinism: "heuristic",
		});
	}
	return results;
}

/**
 * Public API — commit-gate check. Net assertion count across staged TEST files
 * dropped while non-test source also changed. Catches the lone deleted
 * `expect(...)` that the strong→weak matcher-swap check cannot see.
 */
export function checkAssertionCountRegression(
	session: SessionTrajectory,
	deps: OracleDiffDeps = DEFAULT_DEPS,
): CheckResultEntry[] {
	let plus = 0;
	let minus = 0;
	let sourceChanged = false;
	let sampleFile = "";
	for (const file of session.files_written) {
		const diff = deps.stagedDiff(file);
		if (!diff) continue;
		if (!TEST_FILE_RE.test(file)) {
			sourceChanged = true;
			continue;
		}
		sampleFile = sampleFile || file;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+")) plus += countAssertions(line.slice(1)).assertions;
			else if (line.startsWith("-")) minus += countAssertions(line.slice(1)).assertions;
		}
	}
	const net = plus - minus;
	if (net >= 0 || !sourceChanged || !sampleFile) return [];
	return [
		{
			source: "structural",
			name: "assertion_count_regression",
			severity: "warning",
			message: `staged test files net-removed ${-net} assertion(s) (+${plus}/-${minus}) while production source changed. A deleted expect() weakens the oracle exactly when it should tighten — restore the assertion or say why the behavior no longer holds.`,
			file: sampleFile,
			determinism: "heuristic",
		},
	];
}

// Subject/arg capture tolerates ONE level of call nesting — `expect(total(order))`
// is the common case. Alternatives are first-char disjoint ([^()] vs \( ) and
// length-bounded, so the scan stays linear (no ReDoS surface).
const EXPECT_CALL_RE =
	/expect\s*\(((?:[^()]|\([^()]{0,80}\)){1,120}?)\)\s*\.\s*(toBe|toEqual|toStrictEqual|toMatch)\s*\(((?:[^()]|\([^()]{0,80}\)){0,120}?)\)/g;

function collectExpectations(lines: string[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const line of lines) {
		EXPECT_CALL_RE.lastIndex = 0;
		let m: RegExpExecArray | null = EXPECT_CALL_RE.exec(line);
		while (m !== null) {
			const key = `${(m[1] ?? "").trim()}|${m[2] ?? ""}`;
			const arg = (m[3] ?? "").trim();
			const set = map.get(key) ?? new Set<string>();
			set.add(arg);
			map.set(key, set);
			m = EXPECT_CALL_RE.exec(line);
		}
	}
	return map;
}

/**
 * Public API — commit-gate check, severity info (never blocks). Same subject,
 * same matcher, different expected value within one staged diff: the single
 * highest-signal line to review in a "made the tests pass" change.
 */
export function checkAssertionValueSwap(
	session: SessionTrajectory,
	deps: OracleDiffDeps = DEFAULT_DEPS,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = deps.stagedDiff(file);
		if (!diff) continue;
		const removed: string[] = [];
		const added: string[] = [];
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("-")) removed.push(line.slice(1));
			else if (line.startsWith("+")) added.push(line.slice(1));
		}
		const before = collectExpectations(removed);
		const after = collectExpectations(added);
		let perFile = 0;
		for (const [key, beforeArgs] of before) {
			if (perFile >= 3) break;
			const afterArgs = after.get(key);
			if (!afterArgs) continue;
			const changed = [...afterArgs].some((a) => !beforeArgs.has(a));
			if (!changed) continue;
			const [subject, matcher] = key.split("|");
			results.push({
				source: "structural",
				name: "assertion_value_swap",
				severity: "info",
				message: `${basename(file)}: expect(${subject}).${matcher}(…) expected value changed in this diff (${[...beforeArgs].join(", ")} → ${[...afterArgs].join(", ")}). Legitimate if the spec changed — confirm the new value is specified, not observed.`,
				file,
				determinism: "heuristic",
			});
			perFile++;
		}
	}
	return results;
}
