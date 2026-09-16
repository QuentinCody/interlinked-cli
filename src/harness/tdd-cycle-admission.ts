// ===========================================
// TDD cycle admission + key normalization
// ===========================================
// The single answer to two questions the cycle tracker kept answering
// inconsistently:
//
//   1. "Can this path have a TDD cycle at all?"
//   2. "What key does its cycle live under?"
//
// Both were previously decided at REPORT time (checkTddCommitGate filtered
// non-source extensions, exempt paths and deleted files just before emitting)
// while cycles were still CREATED for anything the agent touched. Two costs,
// both observed live on 2026-07-26:
//
//   - Junk cycles. A session held 22 cycles including `vitest.config.mjs` and
//     bare `test.mjs` — files with no companion test that can never go green
//     individually, so any state they entered was permanent.
//   - Fan-out amplification. A whole-suite failure reddens EVERY tracked cycle,
//     so junk entries turn one failing test into a wall of blocked files (16 of
//     them, in that session).
//
// Refusing admission at the source fixes both, and keeps `interlinked tdd
// status` honest about what the harness is actually tracking.
//
// Key normalization exists because the same file arrived under two different
// keys: `recordImplEdit` received whatever path the hook event carried
// (frequently repo-relative) while `recordTestRunCycle` built an absolute path
// via `join(cwd, target)`. The same source then held two independent cycles in
// one session — the live map carried BOTH
// `/Users/…/src/harness/checks/control-bytes.ts` and
// `src/harness/checks/control-bytes.ts`, each with its own state.

import { isAbsolute, resolve } from "node:path";
import { isTddExemptPath } from "./evaluator/tdd-new-file-gate.js";
import { isTestSourcePath } from "./checks/shared.js";

/**
 * Source-code extensions where TDD cycle tracking is meaningful.
 *
 * The canonical copy. The cycle state machine and the "write a failing test
 * first" nudge are about CODE — not docs, configs, JSON data, lockfiles, or
 * generated bundles. Editing a markdown design doc N times must not produce a
 * "write a test for it" warning.
 */
export const TDD_SOURCE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp)$/i;

/**
 * Paths that are themselves tests.
 *
 * The last alternation covers a file literally named `test.ts` / `spec.mjs`
 * (no `.test.` infix) — without it a scratch file called exactly `test.ts` is
 * classified as implementation and told to write a test for itself (recurrence
 * log: 7 `tdd_cycle_violation` events on bare "test.ts").
 */
export const TDD_TEST_FILE_RE =
	/\.(test|spec)\.|__tests__\/|\/tests\/|(?:^|\/)(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Build/tool configuration modules.
 *
 * These carry a tracked extension (`vitest.config.mjs`, `tsup.config.ts`) so
 * the extension filter admits them, but they are declarative wiring with no
 * companion unit test and no sensible "write a failing test first" story. A
 * cycle on one can never go green individually, so once a whole-suite red fans
 * out onto it the entry is permanent — `vitest.config.mjs` was one of the 16
 * files stuck red on 2026-07-26, and it had already been deleted.
 *
 * Their behavior is verified by the build and the suite running at all, which
 * is a stronger signal than a unit test on a config object would be.
 */
const TDD_CONFIG_FILE_RE =
	/(?:^|\/)(?:[^/]+\.config\.[cm]?[jt]sx?|\.?[a-z]+rc\.[cm]?[jt]sx?)$/i;

/**
 * Whether a path may hold a TDD cycle.
 *
 * Deliberately does NOT check existence on disk: a file created and tracked
 * earlier in the session may be deleted later, and the commit gate already
 * treats a vanished source as resolved. Admission is about the KIND of path,
 * which never changes; liveness is a report-time question.
 */
export function canTrackCycle(sourceFile: string): boolean {
	if (!sourceFile) return false;
	if (!TDD_SOURCE_EXT_RE.test(sourceFile)) return false;
	if (TDD_TEST_FILE_RE.test(sourceFile)) return false;
    if (/\.py$/i.test(sourceFile) && isTestSourcePath(sourceFile)) return false;
	if (TDD_CONFIG_FILE_RE.test(sourceFile)) return false;
	return !isTddExemptPath(sourceFile);
}

/**
 * Canonical map key for a source file's cycle.
 *
 * Absolute paths are resolved (collapsing `..` and `.`); relative paths are
 * resolved against `cwd`. `resolve` rather than `realpath`: this runs on the
 * hook path, and a symlink probe per edit is not worth the cost — the duplicate
 * keys seen in the wild differ by relative-vs-absolute, not by symlink.
 */
export function normalizeCycleKey(sourceFile: string, cwd?: string): string {
	if (!sourceFile) return sourceFile;
	return isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(cwd ?? process.cwd(), sourceFile);
}
