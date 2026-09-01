// ===========================================
// Skipped-tests water-line — policy module
// ===========================================
// Bun's Rust-rewrite merge bar was "0 tests skipped or deleted"
// (docs/external-pulse/bun-in-rust.md §2.5). Every other ratchet has a
// committed water-line protected by baseline_integrity_gate; the test suite —
// the oracle every ratchet ultimately depends on — had none, so skips could
// drift up one commit at a time across sessions
// (docs/design/test-oracle-integrity.md §4.2).
//
// Shape mirrors large-files-baseline.json (the established grandfather
// pattern): a global tighten-only cap plus a shrink-only per-file grandfather
// list whose goal end-state is empty. Counting rules are EXACTLY
// countSkippedTests (test-skip-markers.ts) — the baseline and the
// disabled_tests check can never disagree about what a "skip" is.
//
// Direction contract (enforced by detectSkippedTests in
// evaluator/baseline-integrity-gate.ts):
//   - max_skipped may only SHRINK
//   - a grandfather count may only SHRINK
//   - a NEW grandfather entry above max_skipped is blocked

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

export const SKIPPED_TESTS_BASELINE_REL = ".interlinked/skipped-tests-baseline.json";

interface SkippedTestsBaseline {
	version: 1;
	/** Max unconditional skips any non-grandfathered file may carry. Tighten-only. */
	max_skipped: number;
	/** Grandfather list: recorded skip ceiling per offender. Shrink-only. */
	files: Record<string, number>;
}

export function emptySkippedTestsBaseline(): SkippedTestsBaseline {
	return { version: 1, max_skipped: 0, files: {} };
}

/**
 * Narrow a parsed `skipped-tests-baseline.json` into the domain shape. A
 * malformed individual grandfather entry (e.g. a non-number ceiling) is
 * dropped rather than trusted — `baseline_integrity_gate` compares these
 * values directly, and a type-confused value (a string, say) would let a
 * numeric comparison silently misbehave instead of enforcing the ratchet.
 */
function parseSkippedTestsBaseline(value: unknown): SkippedTestsBaseline | null {
	if (!isJsonObject(value)) return null;
	if (value.version !== 1) return null;
	if (typeof value.max_skipped !== "number") return null;
	const files: Record<string, number> = {};
	if (isJsonObject(value.files)) {
		for (const [file, count] of Object.entries(value.files)) {
			if (typeof count === "number") files[file] = count;
		}
	}
	return { version: 1, max_skipped: value.max_skipped, files };
}

/** Fail-soft loader: missing or malformed baseline reads as null (no policy). */
export function loadSkippedTestsBaseline(projectRoot: string): SkippedTestsBaseline | null {
	const path = join(projectRoot, SKIPPED_TESTS_BASELINE_REL);
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parseSkippedTestsBaseline(raw);
	} catch {
		return null;
	}
}

/** Effective skip ceiling for one file: its grandfather entry, else the global cap. */
export function maxSkippedFor(baseline: SkippedTestsBaseline | null, relPath: string): number {
	if (!baseline) return emptySkippedTestsBaseline().max_skipped;
	return baseline.files[relPath] ?? baseline.max_skipped;
}
