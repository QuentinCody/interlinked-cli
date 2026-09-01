// ===========================================
// Vitest shard capture — per-test-file coverage contributions
// ===========================================
// The production form of the Phase 0 spike
// (docs/design/incremental-per-edit-coverage-phase0-spike.md): ONE vitest
// invocation yields one coverage contribution per test-file shard, with real
// line/branch identities, by injecting a generated capture provider through
// the public `coverage.customProviderModule` option.
//
// How the generated module works (see {@link captureProviderSource}):
//   1. Wraps the official @vitest/coverage-v8 provider; worker-side collection
//      (startCoverage/takeCoverage/stopCoverage) passes through untouched.
//   2. Taps `onAfterSuiteRun(meta)` (typed, public) to stash each shard's raw
//      V8 payload in memory.
//   3. Wraps `generateReports` (typed, public — the end-of-run hook where the
//      vite transform pipeline is still alive) to convert each stashed payload
//      via the provider's PRIVATE `convertCoverage(raw, project, environment)`
//      — the ONE runtime-checked internals pin, recorded in the spike doc's
//      addendum. Transforms only exist in-process; this cannot move out.
//   4. Writes one istanbul JSON record per shard into the capture directory;
//      any drift or failure writes a loud `capture-degraded.json` marker
//      instead — capture silently disappearing is not an option, and a
//      degraded capture routes the caller to the full-run fallback.
//
// The harness side then canonicalizes istanbul shapes into the coverage-index
// element sets ({@link istanbulToElementSets}) with per-line max-hit semantics
// matching istanbul's own getLineCoverage.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ShardCoverageContribution,
} from "../coverage-index/types.js";
import {
	type CoverageRunResult,
	defaultJsTestCommand,
	JsCoverageRunner,
	type SpawnFn,
} from "../coverage-runner.js";

// istanbulToElementSets moved to the sibling; re-exported here so existing
// importers of ./vitest.js keep their named binding (it is also used below).
export { istanbulToElementSets } from "./vitest-istanbul.js";

import { canonicalPath, isRecord, istanbulToElementSets } from "./vitest-istanbul.js";

/** Filename of the loud non-authoritative marker inside a capture directory. */
const CAPTURE_DEGRADED_FILENAME = "capture-degraded.json";

// ===========================================
// Generated capture provider module
// ===========================================

/**
 * Source of the capture provider `.mjs`, generated per run with the resolved
 * `@vitest/coverage-v8` URL and the output directory BAKED IN — no environment
 * plumbing, so the module is self-contained wherever vitest loads it. Plain
 * JS: it runs inside the target project's vitest process, not ours.
 */
export function captureProviderSource(v8ProviderUrl: string, outDir: string): string {
	return `import v8 from ${JSON.stringify(v8ProviderUrl)};
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const OUT_DIR = ${JSON.stringify(outDir)};

function writeDegraded(reason) {
	try {
		mkdirSync(OUT_DIR, { recursive: true });
		writeFileSync(join(OUT_DIR, ${JSON.stringify(CAPTURE_DEGRADED_FILENAME)}), JSON.stringify({ reason }));
	} catch (error) {
		console.error("[interlinked:shard-capture] cannot write degraded marker:", error);
	}
}

function fileTaskStates(provider) {
	try {
		const files = provider.ctx?.state?.getFiles?.();
		const map = new Map();
		if (Array.isArray(files)) {
			for (const f of files) {
				if (f && typeof f.filepath === "string") map.set(f.filepath.replace(/\\\\/g, "/"), f);
			}
		}
		return map;
	} catch (error) {
		console.error("[interlinked:shard-capture] task-state lookup failed:", error);
		return new Map();
	}
}

function taskFor(states, testFile) {
	const norm = String(testFile).replace(/\\\\/g, "/");
	for (const [filepath, task] of states) {
		if (filepath === norm || filepath.endsWith("/" + norm)) return task;
	}
	return null;
}

async function captureShards(provider, stashed) {
	mkdirSync(OUT_DIR, { recursive: true });
	if (typeof provider.convertCoverage !== "function") {
		writeDegraded(
			"V8CoverageProvider.convertCoverage is not a function — vitest internals drifted; per-shard capture disabled",
		);
		return;
	}
	const states = fileTaskStates(provider);
	const failures = [];
	for (const [key, meta] of stashed) {
		try {
			const project = provider.ctx?.projects?.find?.((p) => p?.name === meta.projectName);
			const converted = await provider.convertCoverage(meta.coverage, project, meta.environment);
			const istanbul =
				converted && typeof converted.toJSON === "function" ? converted.toJSON() : converted;
			const task = meta.testFiles.length === 1 ? taskFor(states, meta.testFiles[0]) : null;
			const state = task?.result?.state;
			const record = {
				version: 1,
				testFiles: meta.testFiles,
				environment: meta.environment,
				project: meta.projectName ?? null,
				durationMs: typeof task?.result?.duration === "number" ? Math.round(task.result.duration) : null,
				passed: state === "pass" ? true : state === "fail" ? false : null,
				istanbul: istanbul ?? {},
			};
			const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
			writeFileSync(join(OUT_DIR, name + ".json"), JSON.stringify(record));
		} catch (error) {
			failures.push(key + ": " + String(error && error.stack ? error.stack : error));
		}
	}
	if (failures.length > 0) {
		writeDegraded("per-shard conversion failed for " + failures.length + " shard(s):\\n" + failures.join("\\n"));
	}
}

export default {
	...v8,
	async getProvider() {
		const provider = await v8.getProvider();
		if (
			typeof provider.onAfterSuiteRun !== "function" ||
			typeof provider.generateReports !== "function"
		) {
			writeDegraded("provider surface drifted (onAfterSuiteRun/generateReports missing)");
			return provider;
		}
		const stashed = new Map();
		const origAfterSuiteRun = provider.onAfterSuiteRun.bind(provider);
		provider.onAfterSuiteRun = (meta) => {
			try {
				if (meta && Array.isArray(meta.testFiles) && meta.testFiles.length > 0) {
					// The key carries project + environment + transformMode alongside the
					// file list: in a vitest WORKSPACE the same test file runs once per
					// project, and a files-only key made each later run overwrite the
					// earlier one's coverage and pass/fail evidence (finding 2026-06,
					// round 6). NUL separators cannot occur in paths or names.
					const key = [
						meta.projectName ?? "",
						meta.environment ?? "",
						meta.transformMode ?? "",
						...[...meta.testFiles].sort(),
					].join("\\u0000");
					stashed.set(key, meta);
				}
			} catch (error) {
				console.error("[interlinked:shard-capture] stash failed:", error);
			}
			return origAfterSuiteRun(meta);
		};
		const origGenerateReports = provider.generateReports.bind(provider);
		provider.generateReports = async (coverageMap, allTestsRun) => {
			try {
				await captureShards(provider, stashed);
			} catch (error) {
				console.error("[interlinked:shard-capture] capture failed:", error);
				writeDegraded(String(error && error.stack ? error.stack : error));
			}
			return origGenerateReports(coverageMap, allTestsRun);
		};
		return provider;
	},
};
`;
}


// ===========================================
// Captured records
// ===========================================

/** One parsed per-shard capture record, as written by the generated module. */
export interface ShardRecord {
	version: 1;
	testFiles: string[];
	environment: string;
	project: string | null;
	durationMs: number | null;
	passed: boolean | null;
	istanbul: Record<string, unknown>;
}

/** Validate one parsed capture record; null on any structural mismatch. */
export function parseShardRecord(raw: unknown): ShardRecord | null {
	if (!isRecord(raw)) return null;
	if (raw.version !== 1) return null;
	if (!Array.isArray(raw.testFiles) || raw.testFiles.length === 0) return null;
	if (!raw.testFiles.every((t) => typeof t === "string")) return null;
	if (typeof raw.environment !== "string") return null;
	if (!isRecord(raw.istanbul)) return null;
	return {
		version: 1,
		testFiles: raw.testFiles as string[],
		environment: raw.environment,
		project: typeof raw.project === "string" ? raw.project : null,
		durationMs: typeof raw.durationMs === "number" ? raw.durationMs : null,
		passed: typeof raw.passed === "boolean" ? raw.passed : null,
		istanbul: raw.istanbul,
	};
}

/** Repo-relative POSIX shard id for one test file (absolute or relative). */
export function shardIdForTestFile(testFile: string, projectRoot: string): string {
	const norm = testFile.replace(/\\/g, "/");
	if (!isAbsolute(norm)) return norm;
	return relative(canonicalPath(projectRoot), canonicalPath(norm)).replace(/\\/g, "/");
}

/** Shard id for a record: single file → its rel path; group → sorted join.
 *  Records from a NAMED workspace project are qualified with `#<project>` so
 *  the same test file running under several projects yields distinct shards
 *  instead of colliding in the index (finding 2026-06, round 6). The id is an
 *  opaque identity downstream (hashed for blob names, map key in the
 *  aggregate), so the suffix is safe. Exported for tests. */
export function shardIdForRecord(record: ShardRecord, projectRoot: string): string {
	const rels = record.testFiles.map((t) => shardIdForTestFile(t, projectRoot)).sort();
	const base = rels.join(" + ");
	return record.project !== null && record.project !== "" ? `${base}#${record.project}` : base;
}

// ===========================================
// Capture orchestration
// ===========================================

/** What the caller asks a capture run to do. */
export interface CaptureVitestShardsOpts {
	/** Absolute target project root (the suite runs here). */
	projectRoot: string;
	/** Absolute scratch dir owned by the caller; module, records, and the run's coverage report all live under it. */
	captureDir: string;
	/** Scope to these repo-relative test files (omitted/empty ⇒ full suite). */
	selectedTests?: string[];
	/** Per-run timeout forwarded to the runner. */
	timeoutMs?: number;
	/** Injectable spawn for tests; omit for the real async spawn. */
	spawn?: SpawnFn;
}

/** One captured shard, canonicalized and ready for the index builder. */
export interface CapturedShard {
	shardId: string;
	testFiles: string[];
	contribution: ShardCoverageContribution;
	durationMs: number | null;
	passed: boolean | null;
	environment: string;
	project: string | null;
}

/** The outcome of one capture run. */
export interface VitestShardCaptureResult {
	/** The underlying suite run (ok / testsPassed / suiteMs / whole-run coverage). */
	runResult: CoverageRunResult;
	shards: CapturedShard[];
	/** Why capture is NON-AUTHORITATIVE (degraded marker / no records), or null when clean. */
	degraded: string | null;
}

/** Resolve `@vitest/coverage-v8` from the TARGET project, falling back to ours. */
function resolveCoverageV8Url(projectRoot: string): string | null {
	try {
		const requireFromTarget = createRequire(join(projectRoot, "package.json"));
		return pathToFileURL(requireFromTarget.resolve("@vitest/coverage-v8")).href;
	} catch {
		try {
			return import.meta.resolve("@vitest/coverage-v8");
		} catch {
			return null;
		}
	}
}

/** Read every captured record under `shardsDir` into canonical shards. */
function readCapturedShards(
	shardsDir: string,
	projectRoot: string,
): { shards: CapturedShard[]; degraded: string | null } {
	let entries: string[];
	try {
		entries = readdirSync(shardsDir).sort();
	} catch {
		return { shards: [], degraded: "capture directory missing — no shard records were written" };
	}
	let degraded: string | null = null;
	if (entries.includes(CAPTURE_DEGRADED_FILENAME)) {
		try {
			const marker: unknown = JSON.parse(
				readFileSync(join(shardsDir, CAPTURE_DEGRADED_FILENAME), "utf-8"),
			);
			degraded =
				isRecord(marker) && typeof marker.reason === "string" ? marker.reason : "capture degraded";
		} catch {
			degraded = "capture degraded (unreadable marker)";
		}
	}
	const shards: CapturedShard[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json") || entry === CAPTURE_DEGRADED_FILENAME) continue;
		let record: ShardRecord | null = null;
		try {
			record = parseShardRecord(JSON.parse(readFileSync(join(shardsDir, entry), "utf-8")));
		} catch {
			record = null;
		}
		if (!record) {
			degraded ??= `malformed shard record ${entry}`;
			continue;
		}
		const shardId = shardIdForRecord(record, projectRoot);
		shards.push({
			shardId,
			testFiles: record.testFiles,
			contribution: { shardId, files: istanbulToElementSets(record.istanbul, projectRoot) },
			durationMs: record.durationMs,
			passed: record.passed,
			environment: record.environment,
			project: record.project,
		});
	}
	return { shards, degraded };
}

/**
 * Run vitest ONCE with the generated capture provider and return per-shard
 * canonical contributions plus the ordinary run result. Never throws —
 * resolution or run failures surface as `degraded` + the runner's own
 * `ok:false`, and the caller falls back to the full-run path (incomplete
 * capture must never become silently-authoritative evidence).
 */
export async function captureVitestShards(
	opts: CaptureVitestShardsOpts,
): Promise<VitestShardCaptureResult> {
	const shardsDir = join(opts.captureDir, "shards");
	const coverageDir = join(opts.captureDir, "coverage");
	mkdirSync(shardsDir, { recursive: true });
	mkdirSync(coverageDir, { recursive: true });

	const v8Url = resolveCoverageV8Url(opts.projectRoot);
	if (!v8Url) {
		return {
			runResult: {
				suiteMs: 0,
				perFile: new Map(),
				ok: false,
				error: "@vitest/coverage-v8 is not resolvable from the target project (or this CLI)",
				testsPassed: null,
			},
			shards: [],
			degraded: "@vitest/coverage-v8 not resolvable — shard capture unavailable",
		};
	}

	const providerPath = join(opts.captureDir, "capture-provider.mjs");
	writeFileSync(providerPath, captureProviderSource(v8Url, shardsDir), "utf-8");

	const testCommand = [
		...defaultJsTestCommand(coverageDir, opts.selectedTests),
		"--coverage.provider=custom",
		`--coverage.customProviderModule=${providerPath}`,
	];
	const runner = new JsCoverageRunner(opts.spawn);
	const runResult = await runner.run({
		projectRoot: opts.projectRoot,
		coverageDir,
		testCommand,
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
	});

	const { shards, degraded } = readCapturedShards(shardsDir, opts.projectRoot);
	if (runResult.ok && shards.length === 0 && degraded === null) {
		return { runResult, shards, degraded: "run succeeded but no shard records were captured" };
	}
	return { runResult, shards, degraded };
}
