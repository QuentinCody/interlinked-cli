// Failure example store for fast-check (Hegel trial idea #1, hegel-trial.md §7).
//
// On a property failure `fcAssert` records `{seed, path, counterexample, ts}`
// under the VITEST test id (project-relative file + full title). The next run
// replays that seed+path FIRST, so a known failure surfaces at body call 1
// instead of call N (Hegel's DB replay, measured: failure at call 1 instead of
// call 10). The key is the test id, never the property's source text — Hegel's
// source-text key collided across tests with identical bodies.
//
// The file lives at `.interlinked/fast-check-examples.json` and is covered by
// the `.interlinked/*` ignore WITHOUT a carve-out: it is per-machine replay
// state, like `error-history.jsonl`, not team policy.
//
// A compatible passing replay archives the failure as not reproduced before
// clearing the active entry. It never establishes that the defect was fixed.
// Updates use a bounded cross-process lock. Dynamic titles and unreadable files
// remain; confirmed missing files are archived before pruning.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import { isReplayBinding, type ReplayBinding } from "./replay-compatibility.js";

export const FAST_CHECK_EXAMPLES_FILE = ".interlinked/fast-check-examples.json";
/** Counterexample renderings are evidence for a human, not replay input (seed+path replays), so they are bounded. */
export const COUNTEREXAMPLE_MAX_CHARS = 240;
const ID_SEPARATOR = "::";
const TITLE_SEPARATOR = " > ";
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export interface StoredExample {
    compatibility?: ReplayBinding;
	seed: number;
	path: string;
	counterexample: string;
	ts: string;
}

export interface ExampleStore {
	version: 1;
	entries: Record<string, StoredExample>;
}

export interface PruneFs {
	fileExists: (projectRelativeFile: string) => boolean;
	readSource: (projectRelativeFile: string) => string;
}

const EMPTY: ExampleStore = { version: 1, entries: {} };

/** The project root the store lives under: the HOME sandbox pins the real cwd before any test module loads. */
export function projectRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.INTERLINKED_TEST_PROJECT_ROOT ?? process.cwd();
}

export function examplesStorePath(root: string): string {
	return join(root, FAST_CHECK_EXAMPLES_FILE);
}

/** `<project-relative posix path>::<vitest title>`, or null outside a running vitest case. */
export function testIdFor(testPath: string | undefined, currentTestName: string | undefined, root: string): string | null {
	if (!testPath || !currentTestName) return null;
	const rel = relative(root, testPath).split(sep).join("/");
	return `${rel}${ID_SEPARATOR}${currentTestName}`;
}

export function testFileOf(testId: string): string {
	const at = testId.indexOf(ID_SEPARATOR);
	return at < 0 ? testId : testId.slice(0, at);
}

/** The innermost `it()` title: the string literal most likely to appear verbatim in the test source. */
export function titleLeafOf(testId: string): string {
	const at = testId.indexOf(ID_SEPARATOR);
	const title = at < 0 ? "" : testId.slice(at + ID_SEPARATOR.length);
	const parts = title.split(TITLE_SEPARATOR);
	return parts[parts.length - 1] ?? "";
}

/** FNV-1a over the test id, folded to a signed 32-bit integer: a fixed seed per test for CI. */
export function stableSeed(testId: string): number {
	let hash = FNV_OFFSET;
	for (let i = 0; i < testId.length; i++) {
		hash ^= testId.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return hash | 0;
}

function isStoredExample(value: unknown): value is StoredExample {
	if (typeof value !== "object" || value === null) return false;
	// SAFETY: a non-null object indexes as an unknown-valued record; every field is type-tested below.
	const v = value as Record<string, unknown>;
	return typeof v.seed === "number" && Number.isSafeInteger(v.seed) && typeof v.path === "string" && typeof v.counterexample === "string" && typeof v.ts === "string"
        && (v.compatibility === undefined || isReplayBinding(v.compatibility));
}

/** Tolerant reader: a missing, malformed, or foreign-version file is an empty store (replay state is never load-bearing). */
export function readExampleStore(file: string): ExampleStore {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return { version: 1, entries: {} };
	}
	if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, entries: {} };
	// SAFETY: both fields are read as unknown and validated before use.
	const candidate = parsed as { version?: unknown; entries?: unknown };
	if (candidate.version !== 1 || typeof candidate.entries !== "object" || candidate.entries === null) return { version: 1, entries: {} };
	const entries: Record<string, StoredExample> = {};
	// SAFETY: checked non-null object above; each value goes through isStoredExample.
	for (const [id, example] of Object.entries(candidate.entries as Record<string, unknown>)) {
		if (isStoredExample(example)) entries[id] = example;
	}
	return { version: 1, entries };
}

/** Atomic publication; mutation callers hold the cross-process lock around read/merge/write. */
export function writeExampleStore(file: string, store: ExampleStore): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store, null, "\t")}\n`);
	renameSync(tmp, file);
}

/** A tolerant replay read is not authority to overwrite malformed retained evidence. */
function mutableStore(file: string): ExampleStore {
    if (!existsSync(file)) return { version: 1, entries: {} };
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
        || !("entries" in value) || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
        throw new Error("replay store is malformed; original bytes retained");
    }
    if (!Object.values(value.entries).every(isStoredExample)) throw new Error("replay entries are malformed; original bytes retained");
    return readExampleStore(file);
}

/** Read-merge-write of one failure under its test id. */
export function recordExample(file: string, testId: string, example: StoredExample): void {
    mkdirSync(dirname(file), { recursive: true });
    withFileMutationLock(file, () => {
        appendFileSync(file + ".history.jsonl", JSON.stringify({ schema: "fc-replay-history.v1", outcome: "failed", testId, example }) + "\n");
        const store = mutableStore(file);
        store.entries[testId] = example;
        writeExampleStore(file, store);
    }, { waitMs: 1000 });
}

/** Read-delete-write of one id (tmp + rename). Returns false, with no write, when the id is not stored. This is
 *  Hypothesis's rule: an example leaves the database once it stops failing. */
export function removeExample(file: string, testId: string, expected?: StoredExample): boolean {
    if (!existsSync(file)) return false;
    return withFileMutationLock(file, () => {
        const store = mutableStore(file);
        const example = store.entries[testId];
        if (!example || (expected && JSON.stringify(expected) !== JSON.stringify(example))) return false;
        appendFileSync(file + ".history.jsonl", JSON.stringify({ schema: "fc-replay-history.v1", outcome: "not-reproduced", testId, example }) + "\n");
        delete store.entries[testId];
        writeExampleStore(file, store);
        return true;
    }, { waitMs: 1000 });
}

export function truncateCounterexample(rendered: string): string {
	return rendered.length <= COUNTEREXAMPLE_MAX_CHARS ? rendered : `${rendered.slice(0, COUNTEREXAMPLE_MAX_CHARS)}…`;
}

/** Writes are off under Stryker (every mutant fails properties and would flood the store) and under the explicit
 *  `INTERLINKED_FC_EXAMPLES=off` opt-out. `STRYKER_MUTATOR_WORKER` is what @stryker-mutator/core sets on each worker
 *  (child-process-proxy.js); `__STRYKER_ACTIVE_MUTANT__` is the instrumenter's env override. No harness `dry_run`
 *  flag reaches a test child process (2026-10-04: `event.dry_run` is a daemon-side field; the per-edit runner passes
 *  only `INTERLINKED_PROPERTY_NUMRUNS`). */
export function exampleWritesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.STRYKER_MUTATOR_WORKER !== undefined || env.__STRYKER_ACTIVE_MUTANT__ !== undefined || env.INTERLINKED_FC_EXAMPLES === "off";
}

/** Pure prune: drop ids whose file is gone, and ids of `currentFile` whose leaf title left its source. */
export function pruneExamples(store: ExampleStore, fs: PruneFs, _currentFile: string | null): { store: ExampleStore; dropped: string[] } {
	const dropped: string[] = [];
	const entries: Record<string, StoredExample> = {};
	for (const [id, example] of Object.entries(store.entries)) {
		const file = testFileOf(id);
		if (!fs.fileExists(file)) {
			dropped.push(id);
			continue;
		}
		entries[id] = example;
	}
	return { store: { version: 1, entries }, dropped };
}

/** Prune the on-disk store against the real tree once per (worker, test file); writes only when something dropped. */
export function pruneStoreOnDisk(file: string, root: string, currentFile: string | null): string[] {
	if (!existsSync(file)) return [];
	const fs: PruneFs = {
        fileExists: (rel) => {
            try { statSync(join(root, rel)); return true; }
            catch (error) { return !(error instanceof Error && "code" in error && error.code === "ENOENT"); }
        },
		readSource: (rel) => {
			try {
				return readFileSync(join(root, rel), "utf8");
			} catch {
				return "";
			}
		},
	};
    return withFileMutationLock(file, () => {
        const before = mutableStore(file);
        const { store, dropped } = pruneExamples(before, fs, currentFile);
        if (dropped.length > 0) {
            appendFileSync(file + ".history.jsonl", JSON.stringify({ schema: "fc-replay-history.v1", outcome: "file-absent",
                examples: Object.fromEntries(dropped.map(id => [id, before.entries[id]])) }) + "\n");
            writeExampleStore(file, store);
        }
        return dropped;
    }, { waitMs: 1000 });
}
