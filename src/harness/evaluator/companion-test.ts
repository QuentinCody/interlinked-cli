// ===========================================
// Companion-test detection
// ===========================================
// The single source of truth for "where does a source file's companion test
// live, and does one exist?". Extracted from tdd-new-file-gate.ts 2026-08-17
// when qualified-name support (`<base>.<qualifier>.test.ts`) pushed the gate
// module over the line cap. Consumers: the TDD new-file gate, `interlinked
// metrics`, tested-file-policy, characterize-before-touch.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getRepoProfile } from "../repo-profile.js";
import { companionNames, companionNameMatches, companionNameHint } from "../test-conventions.js";

/** The ordered list of companion test paths we look for. First hit wins.
 *  Exported for callers that need the paths themselves (block-message hints,
 *  session-written-set matching). For a plain "does a companion exist?"
 *  question use {@link hasCompanionTest}, which also recognizes qualified
 *  names this exact list cannot enumerate.
 *
 *  When `projectRoot` is provided AND the detected repo profile says tests
 *  live in a separate tree, mirrored candidates under each detected test root
 *  are appended (see {@link separateTreeCandidates}). Callers that omit
 *  `projectRoot` retain the JS/TS colocated set. Python also searches standard
 *  sibling/parent tests directories and project-root test trees. */
export function companionTestCandidates(srcAbs: string, projectRoot?: string): string[] {
	const dir = dirname(srcAbs);
	const ext = extname(srcAbs);
	const base = basename(srcAbs, ext);
	// Colocated conventions (always searched — the historical set):
	//   <dir>/foo.test.ts        — sibling test file
	//   <dir>/__tests__/foo.test.ts — sibling __tests__ folder
	//   ... plus the .spec variants of both.
    const directories = ext.toLowerCase() === ".py" ? pythonCompanionDirectories(dir, projectRoot) : [dir, join(dir, "__tests__")];
	const candidates = companionNames(base, ext).flatMap(name => directories.map(directory => join(directory, name)));
	if (projectRoot !== undefined) {
		candidates.push(...separateTreeCandidates(srcAbs, resolve(projectRoot), base, ext));
	}
	// Dedupe (a source file living inside a test root can make a mirrored
	// candidate collide with a colocated one) while preserving search order.
	return [...new Set(candidates)];
}

function pythonCompanionDirectories(dir: string, projectRoot?: string): string[] {
    const directories = [dir, join(dir, "tests"), join(dir, "__tests__")];
    const parent = dirname(dir);
    const relativeParent = relative(resolve(projectRoot ?? parent), parent);
    if (relativeParent !== ".." && !relativeParent.startsWith(`..${sep}`) && !isAbsolute(relativeParent)) {
        directories.push(join(parent, "tests"));
    }
    return directories;
}

/**
 * Whether `fileName` is a companion test for source `<base><ext>` under the
 * qualified-name convention: `<base>.test<ext>`, `<base>.spec<ext>`, or any
 * infixed variant `<base>.<qualifier...>.test<ext>` (integration,
 * mutation-kill, coverage, fixtures, …). One predicate shared by the on-disk
 * directory scan and the session-written path match, so the two can't drift.
 */
export function isCompanionFileName(fileName: string, base: string, ext: string): boolean {
    return companionNameMatches(fileName, base, ext);
}

/**
 * Whether a companion test for `srcAbs` exists on disk. Checks the exact
 * {@link companionTestCandidates} paths first (cheap existsSync), then scans
 * each candidate directory for qualified names — the convention this repo
 * uses heavily (`update.integration.test.ts`,
 * `search.mutation-hardening.test.ts`) that a fixed path list can't cover.
 * Fixes the 2026-08-17 metrics defect where 68 tested files were reported as
 * "missing a companion test".
 */
export function hasCompanionTest(srcAbs: string, projectRoot?: string): boolean {
	const candidates = companionTestCandidates(srcAbs, projectRoot);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return true;
	}
	const ext = extname(srcAbs);
	const base = basename(srcAbs, ext);
	for (const dir of new Set(candidates.map((c) => dirname(c)))) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue; // directory absent (e.g. no __tests__/) — nothing to scan
		}
		if (entries.some((f) => isCompanionFileName(f, base, ext))) return true;
	}
	return false;
}

/**
 * Mirror-convention candidates for separate-test-tree repos (portability —
 * external assessment 2026-07-06). For source `src/lib/foo.ts` with detected
 * test root `tests`, we search, per suffix (`.test` / `.spec`):
 *   1. Full-path mirror:           tests/src/lib/foo.test.ts
 *      (the test tree replicates the entire source path)
 *   2. First-segment-stripped mirror: tests/lib/foo.test.ts
 *      (the common convention where the test tree mirrors everything under
 *      `src/` without repeating the `src` segment)
 *   3. Flat:                       tests/foo.test.ts
 *      (small repos dump all tests directly in the test root)
 * JS/TS mirrors require a detected separate test tree. Python additionally
 * includes conventional roots before the first test file has been created.
 */
function separateTreeCandidates(
	srcAbs: string,
	projectRoot: string,
	base: string,
	ext: string,
): string[] {
	const profile = getRepoProfile(projectRoot);
	if (profile.testLayout !== "separate-tree" && ext !== ".py") return [];
	const relDir = dirname(relative(projectRoot, srcAbs));
	// Source outside the project root — no mirror path to derive.
	if (relDir.startsWith("..") || isAbsolute(relDir)) return [];
    const roots = ext === ".py" ? new Set([...profile.testDirRoots, "tests", "test"]) : profile.testDirRoots;
    const directories = [...new Set([relDir, relDir.split(sep).slice(1).join(sep), ""])].filter(dir => dir !== ".");
    return [...roots].flatMap(root => companionNames(base, ext).flatMap(file =>
        directories.map(dir => join(projectRoot, root, dir, file))));
}

/** Agents see a friendly relative path, not the resolved absolute one. */
export function companionHintPath(srcRaw: string): string {
	const dir = dirname(srcRaw);
	return dir && dir !== "."
		? `${dir}/${companionNameHint(srcRaw)}`
		: companionNameHint(srcRaw);
}
