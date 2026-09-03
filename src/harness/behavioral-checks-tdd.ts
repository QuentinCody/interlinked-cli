// ===========================================
// Interlinked Harness — Behavioral Checks (TDD cycle + commit gates)
// ===========================================
// TDD-cycle state-machine checks (red→green tracking, regression, green
// confirmation), the git-diff-based commit gates (TPP leapfrog, prod/test
// delta, prod/test LOC ratio), and the assertion-density check. Split out
// of `behavioral-checks.ts` to keep each module under the per-file line
// cap; the public API is re-exported from `behavioral-checks.ts` so all
// importers are unchanged.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, basename as pathBasename } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { checkAssertionDensity, countAssertions } from "./behavioral-checks-tdd-assertions.js";
import {
	checkProdTestLocRatio,
	gitNumstatDelta,
	type LocDelta,
} from "./behavioral-checks-tdd-loc-ratio.js";
import {
	isSoftenedRed,
	type RedCycleView,
	redCycleMessage,
} from "./behavioral-checks-tdd-red-evidence.js";
import { isTypeOnlyModule } from "./checks/shared.js";
import { isTddExemptPath } from "./evaluator/tdd-new-file-gate.js";
import type { CheckResultEntry, SessionTrajectory, TddCycle } from "./types.js";

export type { LocDelta };
export { checkAssertionDensity, checkProdTestLocRatio, countAssertions, gitNumstatDelta };

// ---- Helpers ----

// The last alternation covers a file literally named `test.ts` / `spec.mjs`
// (no `.test.` infix) — without it a scratch file called exactly test.ts is
// classified as implementation and told to write a test for itself
// (recurrence log: 7 tdd_cycle_violation events on bare "test.ts").
const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\/|(?:^|\/)(?:test|spec)\.[cm]?[jt]sx?$/;

// Source-code extensions where TDD cycle tracking is meaningful. The cycle
// state machine and the "write a failing test first" nudge are about CODE
// — not docs, configs, JSON data, lockfiles, or generated bundles. Without
// this gate, editing a markdown design doc N times produces a misleading
// "write a test for it" warning.
const TDD_SOURCE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp)$/i;

// ---- TDD Cycle Checks ----

/**
 * Detect TDD cycle violations: implementation edits without establishing a red test first.
 * Supersedes `repeated_edit_without_test` when TDD cycles are being tracked.
 */
export function checkTddCycleViolation(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (!TDD_SOURCE_EXT_RE.test(filePath)) return null;
	if (TEST_FILE_RE.test(filePath)) return null;
	if (isTddExemptPath(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	// Agent is editing implementation with no test interaction at all
	if (cycle.impl_edits_before_test >= 3 && cycle.state === "no_test") {
		// Pure type-definition modules have nothing to unit-test — exempt
		// them from the "write a failing test" nudge (tsc is their test).
		if (isTypeOnlySourceFile(filePath)) return null;
		const msg = cycle.test_file
			? `${cycle.impl_edits_before_test} implementation edits to ${basename(filePath)} without running its test. Run the test first to establish a baseline.`
			: `${cycle.impl_edits_before_test} implementation edits to ${basename(filePath)} with no test file. Write a failing test that captures the expected behavior, then make it pass.`;
		return {
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message: msg,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	// Agent is editing implementation while tests are failing — stay focused
	if (cycle.state === "red" && cycle.impl_edits_before_test >= 2) {
		return {
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message: `Tests for ${basename(filePath)} are RED (failing). Focus on making them green before making more changes.`,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	return null;
}

/**
 * Detect green→red regression: tests were passing but a subsequent edit broke them.
 */
export function checkTddRegression(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (!TDD_SOURCE_EXT_RE.test(filePath)) return null;
	if (TEST_FILE_RE.test(filePath)) return null;
	if (isTddExemptPath(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	if (cycle.state === "regression" && cycle.previous_state === "green") {
		return {
			source: "structural",
			name: "tdd_regression",
			severity: "error",
			message: `Tests for ${basename(filePath)} were GREEN but are now FAILING (regression). Your last edit broke something — fix before continuing.`,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	return null;
}

/**
 * Positive signal: tests transitioned from red to green.
 * This is the only "good news" check — confirms the TDD cycle completed.
 */
export function checkTddGreenConfirmation(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (TEST_FILE_RE.test(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	if (cycle.state === "green" && cycle.previous_state === "red") {
		return {
			source: "structural",
			name: "tdd_green_confirmation",
			severity: "info",
			message: `Tests passing for ${basename(filePath)}. Red→green cycle complete.`,
			file: filePath,
			determinism: "fully_deterministic",
		};
	}

	return null;
}

/**
 * Build the commit-gate entry for a cycle sitting red/regressing.
 *
 * Both the judgement (block vs warn) and the wording live in
 * `behavioral-checks-tdd-red-evidence.js`, which documents the two ways a
 * remembered red stops being evidence about the current tree: suite fan-out
 * and age.
 */
function redCycleEntry(
	session: SessionTrajectory,
	sourceFile: string,
	cycle: RedCycleView,
	severity: "error" | "warning" | "info",
): CheckResultEntry {
	const softened = isSoftenedRed(session, cycle);
	return {
		source: "structural",
		name: "tdd_commit_gate",
		severity: softened && severity === "error" ? "warning" : severity,
		message: redCycleMessage(session, sourceFile, cycle),
		file: sourceFile,
		determinism: "partially_deterministic",
	};
}

/**
 * Commit gate: check TDD cycle state before allowing git commit.
 * Returns warnings/errors for files with unresolved test issues.
 *
 * @param mode - "nudge" emits info, "warn" emits warnings, "enforce" emits errors (blocks)
 */
export function checkTddCommitGate(
	session: SessionTrajectory,
	mode: "nudge" | "warn" | "enforce",
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	let severity: "error" | "warning" | "info" = "info";
	if (mode === "enforce") severity = "error";
	else if (mode === "warn") severity = "warning";

	for (const [sourceFile, cycle] of session.tdd_cycles) {
		const entry = commitGateEntryFor(session, sourceFile, cycle, severity);
		if (entry) results.push(entry);
	}

	return results;
}

/**
 * The commit-gate verdict for ONE tracked cycle: a red/regression entry, a
 * "no tests written" entry, or null when the cycle is clean or exempt.
 */
function commitGateEntryFor(
	session: SessionTrajectory,
	sourceFile: string,
	cycle: TddCycle,
	severity: "error" | "warning" | "info",
): CheckResultEntry | null {
	if (cycle.state === "red" || cycle.state === "regression") {
		return redCycleEntry(session, sourceFile, cycle, severity);
	}
	if (!(cycle.state === "no_test" && cycle.impl_edits_before_test > 0)) return null;
	if (isUntestedGateExempt(sourceFile, cycle)) return null;

	return {
		source: "structural",
		name: "tdd_commit_gate",
		severity: severity === "error" ? "warning" : severity,
		message: `No tests written or run for ${basename(sourceFile)} (edited ${cycle.impl_edits_before_test} times). Verify changes before committing.`,
		file: sourceFile,
		determinism: "partially_deterministic",
	};
}

/** Suppression surface for the "no tests written" commit-gate entry. */
function isUntestedGateExempt(sourceFile: string, cycle: TddCycle): boolean {
	// Disk reality check: state-machine tracking can miss a transition
	// (path mismatch, harness restart mid-session, hydration gap), but
	// if a test file actually exists on disk for this source, the
	// "no tests written" framing is wrong — tests exist, the tracker
	// just didn't see the green transition. Suppress.
	const candidateTest = cycle.test_file ?? findTestFilePath(sourceFile);
	if (candidateTest && existsSync(candidateTest)) return true;
	// Pure type-definition modules have nothing to unit-test.
	if (isTypeOnlySourceFile(sourceFile)) return true;
	// Inherit the same exemption surface the in-edit TDD checks already
	// apply: non-source extensions (e.g. a .patch / .md / .json the agent
	// happened to Write) and exempt paths (.interlinked/, dist/,
	// node_modules/, scripts/, …). Without these the commit-gate had a wider
	// net than the in-edit checks, so a transient `.interlinked/foo.patch`
	// write fired the gate.
	if (!TDD_SOURCE_EXT_RE.test(sourceFile)) return true;
	if (isTddExemptPath(sourceFile)) return true;
	// A file that no longer exists on disk can't be tested. Covers the
	// transient-file case (agent Writes a working file, then deletes
	// it later in the same session) and renames where the cycle's
	// recorded path no longer resolves.
	if (!existsSync(sourceFile)) return true;
	return false;
}

// ---- Helper ----

function basename(filePath: string): string {
	const parts = filePath.split("/");
	return parts[parts.length - 1] || filePath;
}

/**
 * Find the test file path for a source file using common conventions.
 * Returns null if no test file exists on disk.
 */
function findTestFilePath(filePath: string): string | null {
	const ext = extname(filePath);
	if (!ext) return null;
	const base = filePath.slice(0, -ext.length);
	const dir = dirname(filePath);
	const baseName = pathBasename(filePath, ext);
	if (baseName.endsWith(".test") || baseName.endsWith(".spec")) return null;
	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		join(dir, "__tests__", `${baseName}.test${ext}`),
		join(dir, "__tests__", `${baseName}.spec${ext}`),
	];
	return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Best-effort: is `filePath` a pure type-definition module on disk?
 * Reads the file and delegates to {@link isTypeOnlyModule}. A missing or
 * unreadable file returns false so the caller's check still runs.
 */
function isTypeOnlySourceFile(filePath: string): boolean {
	try {
		if (!existsSync(filePath)) return false;
		return isTypeOnlyModule(filePath, readFileSync(filePath, "utf-8"));
	} catch {
		// unreadable — fall through; the caller's check still applies
		return false;
	}
}

const TPP_LEAPFROG_THRESHOLD = 2;

// "Heavy" TPP transformations — high priority in the TPP list. Introducing
// two or more in one commit without a red→green cycle suggests leapfrogging
// the priority ladder.
const HEAVY_CONSTRUCTS: Array<{ re: RegExp; name: string }> = [
	{ re: /\bwhile\s*\(/g, name: "while loop" },
	{ re: /\bfor\s*\(/g, name: "for loop" },
	{ re: /\bclass\s+[A-Z]/g, name: "class" },
	{ re: /\bswitch\s*\(/g, name: "switch" },
	{ re: /\bfunction\s*\*/g, name: "generator function" },
];

export function getStagedDiff(file: string): string {
	try {
		const r = spawnSync("git", ["-C", dirname(file), "diff", "--cached", "HEAD", "--", file], {
			encoding: "utf-8",
			timeout: 2000,
		});
		if (r.status !== 0 || !r.stdout) {
			// Fall back to unstaged diff (in case changes aren't staged yet).
			const r2 = spawnSync("git", ["-C", dirname(file), "diff", "HEAD", "--", file], {
				encoding: "utf-8",
				timeout: 2000,
			});
			if (r2.status !== 0) return "";
			return r2.stdout || "";
		}
		return r.stdout;
	} catch {
		return "";
	}
}

export function extractAddedLines(diff: string): string {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		out.push(line.slice(1));
	}
	return out.join("\n");
}

/**
 * Commit gate: flag commits that introduce ≥2 heavy TPP transformations
 * (while/for/class/switch/generator) without a preceding red→green TDD cycle.
 * Per Uncle Bob's Transformation Priority Premise — disciplined TDD cycles
 * introduce the smallest possible transformation per test. Information-level
 * only; never blocking.
 */
export function checkTppLeapfrog(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		const entry = tppLeapfrogEntryFor(session, file);
		if (entry) results.push(entry);
	}
	return results;
}

/** The TPP-leapfrog verdict for ONE written file, or null when it is clean. */
function tppLeapfrogEntryFor(session: SessionTrajectory, file: string): CheckResultEntry | null {
	if (TEST_FILE_RE.test(file)) return null;
	const diff = getStagedDiff(file);
	if (!diff) return null;
	const added = extractAddedLines(diff);
	if (!added) return null;
	const constructs = heavyConstructsIn(added);
	if (constructs.length < TPP_LEAPFROG_THRESHOLD) return null;
	// Suppress when a disciplined red→green cycle ran for this file.
	const cycle = session.tdd_cycles.get(file);
	if (cycle && cycle.state === "green" && cycle.red_at !== undefined) return null;
	return {
		source: "structural",
		name: "tpp_leapfrog",
		severity: "info",
		message: `${basename(file)} adds ${constructs.join(" + ")} without a prior red→green cycle. Consider splitting into smaller transformations (Transformation Priority Premise).`,
		file,
		determinism: "heuristic",
	};
}

/** Heavy TPP constructs present in `added`, each labelled with its count. */
function heavyConstructsIn(added: string): string[] {
	const constructs: string[] = [];
	for (const { re, name } of HEAVY_CONSTRUCTS) {
		const matches = added.match(re);
		if (!matches || matches.length === 0) continue;
		constructs.push(matches.length === 1 ? name : `${matches.length}× ${name}`);
	}
	return constructs;
}

/**
 * Commit gate: flag production files edited this session without a matching
 * test-file edit. Fires on `git commit` detection.
 *
 * Suppression rules: a single source file may be covered by multiple test
 * files (e.g. ubs-language-specific.ts has tests in
 * __tests__/ubs-hardcoded-localhost.test.ts AND others). The "no test was
 * updated" framing is a false positive — tests WERE updated, just not under
 * the conventional name — when ANY test edited this session either
 *   (a) imports / references this source by basename, OR
 *   (b) references a symbol this source EXPORTS (barrel / differently-named
 *       coverage — the test exercises the public API without the source
 *       basename in its import path).
 */
export function checkProdDeltaWithoutTestDelta(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	const editedTestFiles = [...session.files_written].filter((f) => TEST_FILE_RE.test(f));
	for (const file of session.files_written) {
		if (TEST_FILE_RE.test(file)) continue;
		const testFile = findTestFilePath(file);
		if (!testFile || session.files_written.has(testFile)) continue;
		if (anyEditedTestReferencesSource(editedTestFiles, file)) continue;
		// Barrel / differently-named coverage: an edited test that references a
		// symbol this source EXPORTS exercises it even without the source
		// basename in an import path (pre-tool.ts ← evaluator-files.test.ts via
		// the evaluator barrel + the `evaluatePreToolUse` symbol).
		if (anyEditedTestUsesSourceExports(editedTestFiles, file)) continue;

		results.push({
			source: "structural",
			name: "prod_delta_no_test_delta",
			severity: "warning",
			message: `Edited ${basename(file)} but no corresponding test was updated (expected ${basename(testFile)}).`,
			file,
			determinism: "heuristic",
		});
	}
	return results;
}

function anyEditedTestReferencesSource(testFiles: string[], sourceFile: string): boolean {
	const ext = extname(sourceFile);
	const sourceBase = pathBasename(sourceFile, ext);
	if (!sourceBase) return false;
	// Boundary-anchored regex: matches an import / require path that contains
	// the source basename as a path segment. `./ubs-language-specific.js`
	// matches; `./other-file.js` doesn't even if "ubs" appears.
	const re = new RegExp(`["']\\.{1,2}/[^"']*\\b${escapeRe(sourceBase)}\\b[^"']*["']`);
	for (const testFile of testFiles) {
		try {
			const content = readFileSync(testFile, "utf-8");
			if (re.test(content)) return true;
		} catch {
			// intentional: best-effort read; an unreadable test file just means
			// we can't confirm it covers this source — fall through.
		}
	}
	return false;
}

/** Top-level exported symbol names of a source file (best-effort regex, no
 *  AST): `export function/const/class/let/var/type/interface/enum NAME`,
 *  `export default function NAME`, and re-export lists `export { a, b as c }`
 *  (the exported alias `c` is what a consumer references). */
function exportedSymbolsOf(sourceFile: string): string[] {
	let content: string;
	try {
		content = readFileSync(sourceFile, "utf-8");
	} catch {
		return [];
	}
	const names = new Set<string>();
	const declRe =
		/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of content.matchAll(declRe)) names.add(nonNull(m[1]));
	const listRe = /\bexport\s*\{([^}]*)\}/g;
	for (const m of content.matchAll(listRe)) {
		for (const part of nonNull(m[1]).split(",")) {
			const exported = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
		}
	}
	return [...names];
}

/** True when an edited test references a symbol EXPORTED by the source file —
 *  i.e. the test exercises the source's public API even though it imports it
 *  via a barrel or a differently-named path (so `anyEditedTestReferencesSource`'s
 *  import-path basename match misses it). Canonical case: `evaluator-files.test.ts`
 *  references `evaluatePreToolUse`, which `pre-tool.ts` exports and the
 *  `evaluator.ts` barrel re-exports — tests WERE updated, just not under the
 *  sibling name. Symbols shorter than 4 chars are ignored so a generic
 *  `id` / `run` export can't over-suppress on an incidental token match. */
function anyEditedTestUsesSourceExports(testFiles: string[], sourceFile: string): boolean {
	const symbols = exportedSymbolsOf(sourceFile).filter((s) => s.length >= 4);
	if (symbols.length === 0) return false;
	const re = new RegExp(`\\b(?:${symbols.map(escapeRe).join("|")})\\b`);
	for (const testFile of testFiles) {
		try {
			if (re.test(readFileSync(testFile, "utf-8"))) return true;
		} catch {
			// best-effort: an unreadable test file just can't confirm coverage.
		}
	}
	return false;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
