// interlinked-tdd: exempt
// ===========================================
// CoverageRunner — failing-test name parsing + attachment helpers
// ===========================================
// Pure text/result helpers extracted from coverage-runner.ts (leaf cluster):
//   - best-effort failing-test name AND file parsing from vitest / pytest output;
//   - trim/de-dupe/cap of those;
//   - attaching them to a CoverageRunResult only when the run is RED.
// The suite EXIT CODE owns the pass/fail decision; missing names/files never
// affect it. Names are message sugar. FILES additionally feed red-debt
// relatedness (coverage-debt.ts): they can only WIDEN what an agent may edit
// while the suite is red — a missed or garbled path just falls back to the
// filename-pair rule, never blocks more.

import { stripVTControlCharacters } from "node:util";
import type { CoverageRunResult } from "./coverage-runner.js";
import { isTestPath } from "./coverage-test-selector.js";

/** Output lines without ANSI color codes. vitest colors its output even when it
 *  is not a TTY, and a colored ` FAIL ` row never matched the row patterns below,
 *  so a red run blocked with no test named (2026-11-12). */
function plainLines(text: string): string[] {
	return stripVTControlCharacters(text).split("\n");
}

/** Cap on failing-test names captured for a block message (sugar, not data). */
const MAX_FAILING_TEST_NAMES = 5;

/** Cap on failing-test FILES attached as red-run evidence. Wider than the name
 *  cap because files are load-bearing for red-debt relatedness (widening-only),
 *  and file-level dedupe keeps real sets tiny; a suite with >20 failing test
 *  FILES is catastrophically red and the pair fallback is sane guidance. */
const MAX_FAILING_TEST_FILES = 20;

/**
 * Best-effort parse of failing test names from vitest text output. vitest's
 * default reporter prints failing cases as `FAIL  <file> > <suite> > <test>`
 * (or `❯`/`×`-prefixed rows in some renderers). We take the ` > `-tail when
 * present, else the trailing path/segment — purely message sugar; missing names
 * never affect the pass/fail decision (the exit code owns that).
 */
export function parseVitestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of plainLines(text)) {
		const m = /^\s*(?:FAIL|×|✗|❯)\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		const label = m[1];
		if (!label) continue;
		const arrow = label.lastIndexOf(" > ");
		names.push(arrow >= 0 ? label.slice(arrow + 3).trim() : label.trim());
	}
	return names;
}

/**
 * The test FILE component of one vitest failure label, or null when the head
 * does not look like a test path. Handles the shapes vitest's reporters print:
 * a `|project|` workspace tag, the ` > ` case chain after the file, and a
 * trailing `(3 tests | 1 failed) 12ms` / `[ unhandled error ]` annotation.
 */
function vitestFailureFile(label: string): string | null {
	const untagged = label.replace(/^\|[^|]+\|\s*/, "");
	const arrow = untagged.indexOf(" > ");
	const head = (arrow >= 0 ? untagged.slice(0, arrow) : untagged).replace(/\s+[[(].*$/, "").trim();
	return isTestPath(head) ? head : null;
}

/**
 * Best-effort parse of failing test FILES from vitest text output — the same
 * rows {@link parseVitestFailingTests} reads, keeping the path head instead of
 * the case-name tail. Paths are as the runner printed them (relative to its
 * cwd, which for overlay runs mirrors the repo root). Consumed as red-debt
 * evidence: an unparseable or alien row is simply dropped (widening-only).
 */
export function parseVitestFailingTestFiles(text: string): string[] {
	const files: string[] = [];
	for (const line of plainLines(text)) {
		const m = /^\s*(?:FAIL|×|✗|❯)\s+(.+?)\s*$/.exec(line);
		if (!m?.[1]) continue;
		const file = vitestFailureFile(m[1]);
		if (file) files.push(file);
	}
	return files;
}

/** The `<nodeid>` captured from one pytest failure line, in either printed
 *  shape (`FAILED <nodeid>` summary / `<nodeid> ... FAILED` verbose), or null. */
function pytestFailureNodeId(line: string): string | null {
	const summary = /^FAILED\s+(\S+)/.exec(line);
	if (summary?.[1]) return summary[1];
	const inline = /^(\S+::\S+)\s+FAILED\b/.exec(line);
	return inline?.[1] ?? null;
}

/**
 * Best-effort parse of failing test ids from pytest text output. pytest prints
 * each failure as `FAILED <nodeid>[ - <message>]` in its short-test-summary, and
 * `<nodeid> ... FAILED` in default verbosity. We capture the nodeid in either
 * shape — message sugar only; the exit code owns the pass/fail decision.
 */
export function parsePytestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split("\n")) {
		const nodeid = pytestFailureNodeId(line);
		if (nodeid) names.push(nodeid);
	}
	return names;
}

/**
 * Best-effort parse of failing test FILES from pytest text output: the path
 * component of each failing nodeid (`tests/test_x.py::TestC::test_m` →
 * `tests/test_x.py`). Same evidence contract as the vitest variant.
 */
export function parsePytestFailingTestFiles(text: string): string[] {
	const files: string[] = [];
	for (const line of text.split("\n")) {
		const nodeid = pytestFailureNodeId(line);
		const file = nodeid?.split("::")[0] ?? "";
		if (file && isTestPath(file)) files.push(file);
	}
	return files;
}

/** Trim, de-dupe, and cap a parsed failing-test name/file list. */
function dedupeCap(entries: string[], cap: number): string[] {
	const seen = new Set<string>();
	for (const raw of entries) {
		const entry = raw.trim();
		if (entry) seen.add(entry);
		if (seen.size >= cap) break;
	}
	return [...seen];
}

/**
 * Attach `failingTests` (names, message sugar) and `failingTestFiles` (red-debt
 * evidence) to a result only when the run is RED and something was parsed.
 * Keeps both fields absent (per exactOptionalPropertyTypes) for green /
 * indeterminate runs and for red runs with no parseable rows.
 */
export function withFailingTests(
	result: CoverageRunResult,
	names: string[],
	files: string[] = [],
): CoverageRunResult {
	if (result.testsPassed !== false) return result;
	const cappedNames = dedupeCap(names, MAX_FAILING_TEST_NAMES);
	const cappedFiles = dedupeCap(files, MAX_FAILING_TEST_FILES);
	return {
		...result,
		...(cappedNames.length > 0 ? { failingTests: cappedNames } : {}),
		...(cappedFiles.length > 0 ? { failingTestFiles: cappedFiles } : {}),
	};
}
