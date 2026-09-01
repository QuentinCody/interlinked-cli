// Check Evidence Contract — resolve a registered check to its detector source
// file and the test file(s) that exercise it.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// Resolution is by detector FUNCTION NAME, taken from `CheckRegistration.fn.name`
// (verified 2026-07-26: all 251 registered checks expose a non-empty `fn.name`).
// Name-based resolution survives the barrel indirection — most entries import
// their detector from `generic-checks.ts`, which re-exports from
// `checks/<family>.ts`, so following the import graph would land on the barrel
// rather than the implementation.
//
// Test-file resolution is deliberately generous: a detector's cases may live in
// its companion `<detector>.test.ts` OR in a shared suite that imports it (e.g.
// `generic-checks-extended.test.ts`). Missing real evidence would push authors
// to duplicate cases, so every test file REFERENCING the detector name counts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories never scanned for sources or tests. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__fixtures__", "coverage"]);

const TEST_SUFFIX_RE = /\.(test|spec)\.tsx?$/;
const SOURCE_EXT_RE = /\.tsx?$/;

/** Directory listing that yields nothing rather than throwing on an unreadable dir. */
function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** `"dir" | "file" | null` — null when the entry vanished or is unreadable. */
function entryKind(path: string): "dir" | "file" | null {
	try {
		return statSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return null;
	}
}

/** One pass over a tree, returning every file matching `predicate`. */
export function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
	const out: string[] = [];
	const stack: string[] = [root];

	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		for (const entry of listDir(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			const kind = entryKind(full);
			if (kind === "dir") stack.push(full);
			else if (kind === "file" && predicate(full)) out.push(full);
		}
	}
	return out;
}

/** Index of detector-name → files, built once per meta-test run. */
export interface DetectorIndex {
	/** Detector function name → repo-relative file that exports it. */
	sourceByFn: Map<string, string>;
	/** Detector function name → repo-relative test files that reference it. */
	testsByFn: Map<string, string[]>;
	/** Repo-relative test file path → its source text (cached for parsing). */
	testSource: Map<string, string>;
}

/** Matches `export function foo`, `export const foo =`, and `export async function foo`. */
function exportedNames(source: string): string[] {
	const names: string[] = [];
	const re = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
	let m: RegExpExecArray | null = re.exec(source);
	while (m) {
		if (m[1]) names.push(m[1]);
		m = re.exec(source);
	}
	return names;
}

/** Every distinct JS identifier appearing in `source`. */
export function identifiersIn(source: string): Set<string> {
	const out = new Set<string>();
	const re = /[A-Za-z_$][\w$]*/g;
	let m: RegExpExecArray | null = re.exec(source);
	while (m) {
		out.add(m[0]);
		m = re.exec(source);
	}
	return out;
}

/** File read that yields null rather than throwing on an unreadable file. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Where the detector index is built from, and what its paths are relative to. */
export interface IndexRoots {
	/** Tree to scan for sources and tests. */
	searchRoot: string;
	/**
	 * Anchor for the repo-relative paths that land in evidence records and,
	 * through them, in the committed baseline — absolute paths would make the
	 * baseline machine-specific.
	 */
	repoRoot: string;
}

/**
 * Attribute each test file to every detector name it references.
 *
 * Tokenizes once per test file and probes the (much smaller) identifier set,
 * rather than running `includes` for every known export — the naive form is
 * |testFiles| × |exports| substring scans, seconds of meta-test runtime.
 */
function attributeTests(
	testSource: ReadonlyMap<string, string>,
	sourceByFn: ReadonlyMap<string, string>,
): Map<string, string[]> {
	const testsByFn = new Map<string, string[]>();
	for (const [rel, text] of testSource) {
		for (const name of identifiersIn(text)) {
			if (!sourceByFn.has(name)) continue;
			const list = testsByFn.get(name);
			if (list) list.push(rel);
			else testsByFn.set(name, [rel]);
		}
	}
	return testsByFn;
}

/** Build the detector index over a source root. */
export function buildDetectorIndex({ searchRoot, repoRoot }: IndexRoots): DetectorIndex {
	const sourceByFn = new Map<string, string>();
	const testSource = new Map<string, string>();

	const files = walkFiles(searchRoot, (p) => SOURCE_EXT_RE.test(p) && !p.endsWith(".d.ts"));

	for (const file of files) {
		const text = readOrNull(file);
		if (text === null) continue;
		const rel = relative(repoRoot, file);

		if (TEST_SUFFIX_RE.test(file)) {
			testSource.set(rel, text);
			continue;
		}
		for (const name of exportedNames(text)) {
			// First writer wins: a barrel re-export (`export { x } from`) does not
			// match `exportedNames`, so collisions here are genuine duplicates and
			// the implementation file is as good a choice as any.
			if (!sourceByFn.has(name)) sourceByFn.set(name, rel);
		}
	}

	return { sourceByFn, testsByFn: attributeTests(testSource, sourceByFn), testSource };
}

/** Where a detector's implementation and its exercising tests live. */
interface DetectorLocation {
	/** Repo-relative file exporting the detector, or null when unresolved. */
	detectorFile: string | null;
	/** Repo-relative test files referencing the detector, possibly empty. */
	testFiles: string[];
}

/** Resolve one detector name against a prebuilt index. */
export function resolveDetector(index: DetectorIndex, detectorFn: string): DetectorLocation {
	return {
		detectorFile: index.sourceByFn.get(detectorFn) ?? null,
		testFiles: index.testsByFn.get(detectorFn) ?? [],
	};
}
