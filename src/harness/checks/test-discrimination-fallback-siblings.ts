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
// Runtime lookup retains its 12-file bound. Explicit foreground scans read
// every matching sibling and disclose unavailable evidence without discarding
// other readable siblings. Filename similarity remains a heuristic relation.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkRoot, reportNotMeasured } from "./check-root.js";
import { isForegroundCheckScan } from "./check-scan-policy.js";
import { getProjectCheckEvidence, type ProjectCheckEvidence } from "./project-check-evidence.js";

const MAX_SIBLING_FILES = 12;

const TEST_EXT_RE = /\.(test|spec)\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const snapshotDirectories = new WeakMap<ProjectCheckEvidence, Map<string, string[]>>();

/** Index already selected paths once per invocation, without a new filesystem
 * walk. A disappearing live entry must not erase captured dependency evidence. */
function snapshotTestBasenames(dir: string): readonly string[] {
	const evidence = isForegroundCheckScan() ? getProjectCheckEvidence() : undefined;
	if (!evidence) return [];
	let directories = snapshotDirectories.get(evidence);
	if (!directories) {
		directories = new Map();
		for (const file of evidence.listFiles()) {
			if (!TEST_EXT_RE.test(file)) continue;
			const path = resolve(evidence.root, file), directory = dirname(path);
			const names = directories.get(directory) ?? [];
			names.push(basename(path));
			directories.set(directory, names);
		}
		snapshotDirectories.set(evidence, directories);
	}
	return directories.get(dir) ?? [];
}

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

function reportSiblingGap(file: string, error: unknown): void {
	if (!isForegroundCheckScan()) return;
	const reason = `Sibling evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
	getProjectCheckEvidence()?.reportUnavailable("fallback_only_assertion", file, reason);
	reportNotMeasured("fallback_only_assertion", `${file}: ${reason}`);
}

/** The shared SUT stem for a test file's basename, or `null` when the
 *  basename doesn't follow the `*.test.*` / `*.spec.*` convention at all. */
function sutStem(fileBase: string): string | null {
	const withoutTestExt = fileBase.replace(TEST_EXT_RE, "");
	if (withoutTestExt === fileBase) return null;
	let stem = withoutTestExt;
	const rounds = isForegroundCheckScan() ? Number.POSITIVE_INFINITY : MAX_SUFFIX_STRIP_ROUNDS;
	for (let round = 0; round < rounds; round++) {
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

/** An absent optional child directory is known absence; failed enumeration
 *  elsewhere cannot establish that no matching sibling exists. */
function listTestBasenames(dir: string, optional: boolean): string[] {
	try {
		return readdirSync(dir).filter((name) => TEST_EXT_RE.test(name));
	} catch (error) {
		const absent = error instanceof Error && "code" in error && error.code === "ENOENT";
		if (!optional || !absent) reportSiblingGap(dir, error);
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
	seen: Set<string>;
	limit: number;
}

/** Append every stem-matching sibling basename in `dir` to `search.found`
 *  (deduped, self-excluded, subject to the caller's collection policy). */
function collectSiblingsInDir(dir: string, search: SiblingSearch): void {
	const optional = dir === join(dirname(search.selfAbs), "__tests__");
	const names = new Set(listTestBasenames(dir, optional));
	for (const name of snapshotTestBasenames(dir)) names.add(name);
	for (const name of names) {
		if (search.found.length >= search.limit) return;
		if (sutStem(name) !== search.stem) continue;
		const candidateAbs = resolve(join(dir, name));
		if (candidateAbs === search.selfAbs) continue;
		if (!search.seen.has(candidateAbs)) {
			search.seen.add(candidateAbs);
			search.found.push(candidateAbs);
		}
	}
}

/**
 * Every sibling test file of `filePath` sharing its SUT stem: same directory
 * (plus its `__tests__` child, or its parent when `filePath` itself sits in
 * `__tests__`), excluding `filePath` itself. Runtime retains its file and
 * normalization limits; foreground completes the matching population. Failed
 * foreground enumeration remains unavailable evidence. Never throws for I/O.
 */
export function findSiblingTestFiles(filePath: string): string[] {
	const normalized = filePath.replace(/\\/g, "/");
	const selfAbs = resolve(getProjectCheckEvidence()?.root ?? checkRoot(), normalized);
	const stem = sutStem(basename(normalized));
	if (stem === null) return [];

	const search: SiblingSearch = { stem, selfAbs, found: [], seen: new Set(),
		limit: isForegroundCheckScan() ? Number.POSITIVE_INFINITY : MAX_SIBLING_FILES };
	for (const dir of candidateDirs(selfAbs)) {
		if (search.found.length >= search.limit) break;
		collectSiblingsInDir(dir, search);
	}
	return search.found;
}

/**
 * The union of `computeTargets(content)` over every sibling test file of
 * `filePath` (per {@link findSiblingTestFiles}) — the cross-file half of the
 * sibling-visibility set. Each sibling read is independently try/catch'd: a
 * file that vanished between listing and reading is unavailable in foreground,
 * not fatal. Existing invocation snapshots supply source bytes when available.
 */
export function siblingNonDefaultTargets(
	filePath: string,
	computeTargets: (content: string) => Set<string>,
): Set<string> {
	const union = new Set<string>();
	for (const sibling of findSiblingTestFiles(filePath)) {
		try {
			const evidence = isForegroundCheckScan() ? getProjectCheckEvidence() : undefined;
			const content = evidence ? evidence.readFile(sibling) : readFileSync(sibling, "utf-8");
			for (const target of computeTargets(content)) union.add(target);
		} catch (error) {
			reportSiblingGap(sibling, error);
		}
	}
	return union;
}
