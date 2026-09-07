// Cross-file sibling visibility for `test-discrimination-fallback.ts`.
//
// The file-level sibling rule links a default-only `it()` block to a
// non-default pin ELSEWHERE IN THE SAME FILE — but the census (2026-09-06,
// scratch/test-quality-checks/census.md) found 43/238 hits (18%) were the
// non-default outcome pinned in a SIBLING TEST FILE of the same SUT instead:
// `foo.test.ts` pins the real case, `foo.mutation-kill-w12.test.ts` (or a
// `__tests__/` companion) pins only the fallback. 37% of ALL hits sit in a
// `*.mutation-kill-*` companion specifically.
//
// Sibling test files are located by filename convention (mirrors
// `test-discrimination-throw.ts`'s SUT-by-filename resolution, applied to
// TEST files instead of the SUT): strip the test extension, then strip any
// `.mutation-kill-*` / `.mutants` / `.integration` / `.coverage` / `.luna*` /
// `.unavailable` / `.defaults` suffix, and match every other test file in
// the same directory (its `__tests__/` child, or its parent when the file
// itself lives in `__tests__/`) whose stem strips down to the same value.
// Bounded at 12 files; every read is try/catch-wrapped and never throws —
// a heuristic advisory check must degrade to "no sibling found", not crash.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_SIBLING_FILES = 12;

const TEST_EXT_RE = /\.(test|spec)\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

// Suffix patterns stripped (in order, repeated to a fixed point) after the
// test extension itself is gone. `.mutation-kill-*` consumes everything from
// that marker onward in one shot (covers chained tails like
// `.mutation-kill-luna-v3`), so it must run before the narrower singles.
const SUFFIX_PATTERNS: RegExp[] = [
	/\.mutation-kill(-.*)?$/,
	/\.mutants$/,
	/\.integration$/,
	/\.coverage$/,
	/\.luna.*$/,
	/\.unavailable$/,
	/\.defaults$/,
];
const MAX_SUFFIX_STRIP_ROUNDS = 6;

/** The shared SUT stem for a test file's basename, or `null` when the
 *  basename doesn't follow the `*.test.*` / `*.spec.*` convention at all. */
function sutStem(fileBase: string): string | null {
	const withoutTestExt = fileBase.replace(TEST_EXT_RE, "");
	if (withoutTestExt === fileBase) return null;
	let stem = withoutTestExt;
	for (let round = 0; round < MAX_SUFFIX_STRIP_ROUNDS; round++) {
		let changed = false;
		for (const pattern of SUFFIX_PATTERNS) {
			const next = stem.replace(pattern, "");
			if (next !== stem) {
				stem = next;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return stem;
}

/** Test-file basenames in one directory, or `[]` when it can't be listed
 *  (missing, permissions) — never throws. */
function listTestBasenames(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => TEST_EXT_RE.test(name));
	} catch (e) {
		void e; // directory absent or unreadable — no siblings from here
		return [];
	}
}

/** The candidate directories to search for a sibling of `filePath`: its own
 *  directory, that directory's `__tests__` child, and — when the file itself
 *  lives in a `__tests__` directory — that directory's parent. */
function candidateDirs(filePath: string): string[] {
	const normalized = filePath.replace(/\\/g, "/");
	const dir = dirname(normalized);
	const dirs = [dir, join(dir, "__tests__")];
	if (basename(dir) === "__tests__") dirs.push(dirname(dir));
	return dirs;
}

interface SiblingSearch {
	stem: string;
	selfAbs: string;
	found: string[];
}

/** Append every stem-matching sibling basename in `dir` to `search.found`
 *  (deduped, self-excluded, bounded at {@link MAX_SIBLING_FILES} by the
 *  caller). */
function collectSiblingsInDir(dir: string, search: SiblingSearch): void {
	for (const name of listTestBasenames(dir)) {
		if (search.found.length >= MAX_SIBLING_FILES) return;
		if (sutStem(name) !== search.stem) continue;
		const candidateAbs = resolve(join(dir, name));
		if (candidateAbs === search.selfAbs) continue;
		if (!search.found.includes(candidateAbs)) search.found.push(candidateAbs);
	}
}

/**
 * Every sibling test file of `filePath` sharing its SUT stem: same directory
 * (plus its `__tests__` child, or its parent when `filePath` itself sits in
 * `__tests__`), excluding `filePath` itself. Bounded at
 * {@link MAX_SIBLING_FILES}; returns `[]` for a nonexistent directory or a
 * basename that doesn't follow the test-file naming convention. Never throws.
 */
export function findSiblingTestFiles(filePath: string): string[] {
	const normalized = filePath.replace(/\\/g, "/");
	const selfAbs = resolve(normalized);
	const stem = sutStem(basename(normalized));
	if (stem === null) return [];

	const search: SiblingSearch = { stem, selfAbs, found: [] };
	for (const dir of candidateDirs(normalized)) {
		if (search.found.length >= MAX_SIBLING_FILES) break;
		collectSiblingsInDir(dir, search);
	}
	return search.found;
}

/**
 * The union of `computeTargets(content)` over every sibling test file of
 * `filePath` (per {@link findSiblingTestFiles}) — the cross-file half of the
 * sibling-visibility set. Each sibling read is independently try/catch'd: a
 * file that vanished between listing and reading is skipped, not fatal.
 */
export function siblingNonDefaultTargets(
	filePath: string,
	computeTargets: (content: string) => Set<string>,
): Set<string> {
	const union = new Set<string>();
	for (const sibling of findSiblingTestFiles(filePath)) {
		let content: string;
		try {
			content = readFileSync(sibling, "utf-8");
		} catch (e) {
			void e; // removed/unreadable between listing and reading — skip it
			continue;
		}
		for (const target of computeTargets(content)) union.add(target);
	}
	return union;
}
