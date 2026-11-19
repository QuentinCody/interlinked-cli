// ===========================================
// Test-runner detection + TDD cycle tracking
// ===========================================
// Extracted from server.ts. Both concerns travel together: detection
// identifies when a bash command ran tests (and on which file), and the
// cycle tracker uses that to advance a source file's red/green state.
//
// All pure functions — no module-level state. The cycle map lives on the
// SessionTrajectory passed in.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canTrackCycle, normalizeCycleKey } from "./tdd-cycle-admission.js";
import type { SessionTrajectory, TddCycle } from "./types.js";

// -----------------------------------------------------------------------------
// Test runner detection
// -----------------------------------------------------------------------------

const TEST_RUNNER_PATTERNS: readonly RegExp[] = [
	// Node's built-in runner: `node [--flag[=value]]... --test [--flag]... [file]`.
	/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*--test(?=\s|$)(?:\s+(?:--[\w-]+(?:=\S+)?\s+)*([^\s-]\S*))?/,
	/\b(?:npx\s+)?vitest\s+run\s+(\S+)/,
	/\b(?:npx\s+)?jest\s+(\S+)/,
	/\bpytest\s+(\S+)/,
	/\bcargo\s+test/,
	/\bgo\s+test\s+(\S+)/,
	/\bnpm\s+(?:run\s+)?test/,
	/\b(?:npx\s+)?vitest(?:\s|$)/,
	/\b(?:npx\s+)?jest(?:\s|$)/,
];

/** Sentinel returned when a command ran the full test suite with no specific
 *  target file. Callers should special-case it to update every tracked cycle
 *  rather than look up a single file. */
export const ALL_TESTS_SENTINEL = "__all_tests__" as const;

/**
 * Detect if a bash command runs a test runner. If a specific test file is
 * targeted, return its absolute path. Otherwise return `ALL_TESTS_SENTINEL`
 * to indicate the full suite ran. Returns null for non-test commands.
 */
export function detectTestRunFile(command: string, cwd: string): string | null {
	for (const pattern of TEST_RUNNER_PATTERNS) {
		const match = command.match(pattern);
		if (match) {
			const targetFile = match[1];
			if (targetFile && /\.(test|spec|_test)\b/.test(targetFile)) {
				return targetFile.startsWith("/") ? targetFile : join(cwd, targetFile);
			}
			return ALL_TESTS_SENTINEL;
		}
	}
	return null;
}

// -----------------------------------------------------------------------------
// TDD cycle
// -----------------------------------------------------------------------------

export const TEST_FILE_RE = /\.(test|spec)\.[^.]+$|__tests__\//;

/** Given a test file path, derive the source file it tests. */
export function sourceFileForTest(testFile: string): string | null {
	// __tests__/foo.test.ts → ../foo.ts
	if (testFile.includes("__tests__/")) {
		const dir = dirname(dirname(testFile));
		const base = basename(testFile).replace(/\.(test|spec)\./, ".");
		return join(dir, base);
	}
	// foo.test.ts → foo.ts
	return testFile.replace(/\.(test|spec)\./, ".");
}

/** Given a source file path, find the test file (if it exists on disk). */
export function findTestForSource(filePath: string): string | null {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	const base = filePath.slice(0, -ext.length);
	const dir = dirname(filePath);
	const name = basename(filePath, ext);

	if (name.endsWith(".test") || name.endsWith(".spec")) return null;

	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		join(dir, "__tests__", `${name}.test${ext}`),
		join(dir, "__tests__", `${name}.spec${ext}`),
	];
	return candidates.find((t) => existsSync(t)) || null;
}

/**
 * Look up a cycle by its normalized key, re-keying a legacy entry if needed.
 *
 * Sessions persisted before key normalization existed hold entries under
 * whatever path the caller happened to have — the live map on 2026-07-26 held
 * BOTH `/Users/…/control-bytes.ts` and `src/harness/checks/control-bytes.ts`
 * as independent cycles for one file. Migrating on first touch converges them
 * instead of letting the file accumulate two divergent states.
 */
function findExistingCycle(
	session: SessionTrajectory,
	key: string,
	cwd?: string,
): TddCycle | undefined {
	const current = session.tdd_cycles.get(key);
	if (current) return current;

	// Miss under the canonical key: an entry for the SAME file may still be
	// stored under a differently-shaped path. Scan by normalized form rather
	// than by the incoming spelling — the stored key can be the relative one
	// and the incoming key absolute, or the reverse, and both directions were
	// observed live. Only runs on a cycle miss, over a map of tens of entries.
	for (const [storedKey, cycle] of session.tdd_cycles) {
		if (storedKey === key || normalizeCycleKey(storedKey, cwd) !== key) continue;
		session.tdd_cycles.delete(storedKey);
		cycle.source_file = key;
		session.tdd_cycles.set(key, cycle);
		return cycle;
	}
	return undefined;
}

/**
 * Get or create the TDD cycle entry for a source file.
 *
 * The single choke point for both admission and key identity:
 *
 *   - Returns `null` for paths that can never hold a meaningful cycle (see
 *     `canTrackCycle`). Refusing here rather than filtering at report time
 *     keeps junk entries out of the map entirely, which matters because a
 *     whole-suite result fans out across EVERY tracked cycle.
 *   - Keys by the normalized absolute path, so one file cannot end up with two
 *     independent cycles depending on whether the caller happened to hold a
 *     relative or an absolute path.
 */
export function getOrCreateCycle(
	session: SessionTrajectory,
	sourceFile: string,
	cwd?: string,
): TddCycle | null {
	if (!canTrackCycle(sourceFile)) return null;
	const key = normalizeCycleKey(sourceFile, cwd);

	const existing = findExistingCycle(session, key, cwd);
	if (existing) return existing;

	const cycle: TddCycle = {
		source_file: key,
		test_file: findTestForSource(key),
		state: "no_test",
		impl_edits_before_test: 0,
	};
	session.tdd_cycles.set(key, cycle);
	return cycle;
}

/** Record that a source file was edited (implementation work). Test files
 *  are skipped — writing a test doesn't count as an impl edit. */
export function recordImplEdit(
	session: SessionTrajectory,
	sourceFile: string,
	cwd?: string,
): void {
	if (TEST_FILE_RE.test(sourceFile)) return;
	const cycle = getOrCreateCycle(session, sourceFile, cwd);
	if (!cycle) return;
	cycle.impl_edits_before_test++;
}

/** Record that a test file was written/edited. Needs the corresponding
 *  source file to exist on disk so we don't create spurious cycles. */
export function recordTestWrite(
	session: SessionTrajectory,
	testFile: string,
	cwd?: string,
): void {
	const sourceFile = sourceFileForTest(testFile);
	if (!sourceFile || !existsSync(sourceFile)) return;

	const cycle = getOrCreateCycle(session, sourceFile, cwd);
	if (!cycle) return;
	cycle.test_file = testFile;
	cycle.test_written_at = session.tool_call_count;
}

/** Record a test run result and update the corresponding cycle state(s).
 *  When `testRunFile` is `ALL_TESTS_SENTINEL`, every tracked cycle updates. */
export function recordTestRunCycle(
	session: SessionTrajectory,
	testRunFile: string,
	passed: boolean,
	command?: string,
): void {
	if (testRunFile === ALL_TESTS_SENTINEL) {
		for (const [, cycle] of session.tdd_cycles) {
			// A1: a whole-suite FAILURE must not redden a file that has no test.
			// Blanket-reddening every tracked cycle marked config files and
			// scripts as "tests failing" — and because they have no companion
			// test, no targeted run could ever green them again. Only a later
			// whole-suite pass could, so one red suite wedged the commit gate
			// on files whose tests do not exist. A whole-suite PASS still
			// greens everything: passing evidence covers files either way.
			if (!passed && !cycle.test_file) continue;
			updateCycleFromTestRun(cycle, passed, session.tool_call_count, command);
		}
		return;
	}

	const sourceFile = sourceFileForTest(testRunFile);
	if (!sourceFile) return;

	const cycle = getOrCreateCycle(session, sourceFile);
	if (!cycle) return;
	cycle.test_file = testRunFile;
	updateCycleFromTestRun(cycle, passed, session.tool_call_count, command);
}

export function updateCycleFromTestRun(
	cycle: TddCycle,
	passed: boolean,
	step: number,
	command?: string,
): void {
	cycle.previous_state = cycle.state;

	if (passed) {
		cycle.green_at = step;
		cycle.state = "green";
		cycle.red_command = undefined;
		// Reset impl edit counter — tests verified the work
		cycle.impl_edits_before_test = 0;
	} else {
		// A4: remember WHAT failed, so the block reason can name its evidence.
		if (command) cycle.red_command = command.slice(0, 120);
		cycle.red_at = step;
		if (cycle.previous_state === "green") {
			cycle.state = "regression";
		} else {
			cycle.state = "red";
		}
	}
}
