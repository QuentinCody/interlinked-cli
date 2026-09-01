// Check Evidence Contract — run a detector across the real working tree.
//
// Spec: docs/design/verification-density-program.md (Phase 2).
//
// This is the "dogfood" half of the corpus obligation: hand-authored fixtures
// only cover the false positives the author imagined, so the detector has to
// meet code nobody wrote for it. Every hit it produces must then be adjudicated
// (see corpus.ts) as a real bug or a legitimate shape.
//
// Deterministic and offline: it runs the SAME detector function the harness
// runs at edit time, over files on disk. No LLM, no network.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRegistration } from "../check-registry/types.js";
import {
	buildCorpusRecord,
	CHECK_CORPUS_PATH,
	type CorpusHit,
	type CorpusRecord,
	type CorpusStore,
	EMPTY_CORPUS,
	parseCorpusStore,
} from "./corpus.js";
import { walkFiles } from "./resolve.js";

/** Extensions the inline detectors are written against. */
const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Files excluded from the corpus: they are not the code the check protects. */
function isScannable(path: string): boolean {
	if (!SCAN_EXTENSIONS.some((ext) => path.endsWith(ext))) return false;
	if (path.endsWith(".d.ts")) return false;
	// Test files and fixtures deliberately contain the very patterns a detector
	// looks for — counting them as corpus hits would drown the real signal.
	return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.includes("__fixtures__");
}

/** A file the detector threw on. */
interface DetectorFailure {
	file: string;
	message: string;
}

/** Result of scanning one detector across a file set. */
interface CorpusScanResult {
	hits: CorpusHit[];
	files_scanned: number;
	/**
	 * Files where the detector threw. Reported, never swallowed: a detector that
	 * crashes on real source is silently contributing zero findings for that
	 * file, which looks identical to "clean" in every downstream count.
	 */
	failures: DetectorFailure[];
}

/** Run the detector on one file, separating hits from a crash. */
function runDetector(
	check: CheckRegistration,
	content: string,
	rel: string,
): { hits: CorpusHit[]; failure: DetectorFailure | null } {
	try {
		const hits = check.fn(content, rel).map((m) => ({ file: rel, line: m.line, text: m.text }));
		return { hits, failure: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hits: [], failure: { file: rel, message } };
	}
}

/**
 * Run one check's detector over every scannable file under `searchRoot`.
 *
 * A detector that throws on a file is recorded as a failure and the scan
 * continues: the corpus is a survey, and one malformed input must not hide the
 * findings from the other 800 files.
 */
export function scanCorpus(
	check: CheckRegistration,
	searchRoot: string,
	repoRoot: string,
): CorpusScanResult {
	const files = walkFiles(searchRoot, isScannable);
	const hits: CorpusHit[] = [];
	const failures: DetectorFailure[] = [];
	let scanned = 0;

	for (const file of files) {
		let content: string | null;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			content = null;
		}
		if (content === null) continue;
		scanned++;
		const rel = file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
		const result = runDetector(check, content, rel);
		hits.push(...result.hits);
		if (result.failure) failures.push(result.failure);
	}

	return { hits, files_scanned: scanned, failures };
}

/** Load the committed corpus store, failing closed to an empty one. */
export function loadCorpusStore(repoRoot: string): CorpusStore {
	const path = join(repoRoot, CHECK_CORPUS_PATH);
	if (!existsSync(path)) return EMPTY_CORPUS;
	try {
		return parseCorpusStore(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return EMPTY_CORPUS;
	}
}

/** Persist the corpus store. */
export function saveCorpusStore(repoRoot: string, store: CorpusStore): void {
	writeFileSync(join(repoRoot, CHECK_CORPUS_PATH), `${JSON.stringify(store, null, "\t")}\n`, "utf8");
}

/** Scan one check and fold the result into a store, preserving prior verdicts. */
export function recordCorpusScan(
	store: CorpusStore,
	check: CheckRegistration,
	searchRoot: string,
	repoRoot: string,
): { store: CorpusStore; record: CorpusRecord; failures: DetectorFailure[] } {
	const scan = scanCorpus(check, searchRoot, repoRoot);
	const record = buildCorpusRecord(scan.hits, scan.files_scanned, store.checks[check.id]);
	return {
		store: { version: 1, checks: { ...store.checks, [check.id]: record } },
		record,
		failures: scan.failures,
	};
}
