// ===========================================
// interlinked mutation measure — render + record helpers
// ===========================================
// Extracted from mutation.ts (large-file-policy.ts's per-file line cap) — the
// `mutation measure` CLI command's own render/record helpers, with no
// behavior change. `mutationMeasureCommand` (mutation.ts) imports these.

import { execFile } from "node:child_process";
import type { SuiteRunner } from "../harness/mutation/baseline-suite.js";
import type { FileSurvivorSummary, MeasureOutcome, SurvivorEntry } from "../harness/mutation/measure.js";
import type { MutationTestScopeResult } from "../harness/mutation/test-scope.js";
import type { MeasurementScope, MeasurementSurface } from "../harness/mutation/types.js";
import { c, header, kvLine } from "../lib/formatter.js";

/** Ceiling on the pre-flight suite run. The probe exists to SAVE time; one that
 *  can outlast the mutation run it guards would defeat its own purpose, so it
 *  gives up and reports `skipped` rather than becoming the slow step. */
const PREFLIGHT_TIMEOUT_MS = 180_000;

/**
 * The real `SuiteRunner` — spawn vitest over exactly the scoped test files.
 *
 * `execFile` (not `exec`): the test paths come from the import graph and go to
 * the process argv as a list, never through a shell, so a path containing shell
 * metacharacters cannot become a command. A nonzero exit is a RESULT here, not
 * an error — the callback's `err` is deliberately folded into the exit code
 * rather than rejected, since "the suite failed" is precisely what the probe
 * asked about.
 */
export const spawnVitestSuite: SuiteRunner = ({ tests, cwd }) =>
	new Promise((resolvePromise, rejectPromise) => {
		// No `--reporter=...` override: the repo's configured reporter is the one
		// known to work here. Pinning a reporter name couples this probe to a
		// vitest major — `basic` was removed in v4, and passing it made vitest
		// exit nonzero before running anything, which the probe then read as a
		// red suite (see baseline-suite.ts::sawTestSession).
		const child = execFile(
			"npx",
			["vitest", "run", ...tests],
			{ cwd, timeout: PREFLIGHT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// A spawn-level failure (npx missing, timeout kill) has no exit code
				// and must NOT be read as a red suite — reject so the probe reports
				// `skipped`, which the caller treats as "unknown", never as "passed".
				const code = (err as { code?: unknown } | null)?.code;
				if (err && typeof code !== "number") {
					rejectPromise(err);
					return;
				}
				resolvePromise({ exitCode: typeof code === "number" ? code : 0, stdout, stderr });
			},
		);
		child.on("error", rejectPromise);
	});

/** One-line progress note for the resolved test scope — empty string when
 *  there is nothing worth saying (a plain filename-glob fallback with no
 *  cap involved; the runner's own log already covers that case). */
export function testScopeNote(scope: MutationTestScopeResult): string {
	if (scope.tests) return `test scope: ${scope.tests.length} test(s) via the import graph\n`;
	if (scope.reason === "over_cap") {
		if (scope.companionScope && scope.companionScope.length > 0) {
			return `test scope: graph selected ${scope.uncappedCount} test(s), over cap — shipping the target's ${scope.companionScope.length} companion kill test(s) instead of a lossy filename glob\n`;
		}
		return `test scope: graph selected ${scope.uncappedCount} test(s), over cap — falling back to filename-glob scope\n`;
	}
	return "";
}

/**
 * The measurement regime a scope result was actually run under — the honest
 * provenance stamp. `import_graph` when the full graph set fit; `companion_fallback`
 * when it was over cap but the target's own companion kill tests still shipped
 * (a strict subset, comparable to neither of the other two); `glob_fallback`
 * otherwise (the runner chose its own filename-stem set — no scope was sent).
 */
export function measurementScopeFor(scope: MutationTestScopeResult): MeasurementScope {
	if (scope.tests) return "import_graph";
	if (scope.companionScope && scope.companionScope.length > 0) return "companion_fallback";
	return "glob_fallback";
}

/**
 * Public API — run the green-suite pre-flight and return a FATAL message, or
 * null to proceed.
 *
 * Collapsing the outcome to `string | null` keeps the caller at two branches:
 * `mutationMeasureCommand` is already near the cognitive cap, and the decision
 * it needs to make really is binary. The non-fatal `skipped` note is written
 * here because it belongs with the probe, not with the dispatch.
 */
export async function preflightScopedSuite(args: {
	tests: string[];
	cwd: string;
	quiet: boolean;
}): Promise<string | null> {
	const { probeScopedSuite, redSuiteMessage } = await import("../harness/mutation/baseline-suite.js");
	const probe = await probeScopedSuite({ tests: args.tests, cwd: args.cwd, run: spawnVitestSuite });
	if (probe.status === "red") return redSuiteMessage(probe);
	if (probe.status === "skipped" && !args.quiet) {
		// Skipped is UNKNOWN, not green. Saying nothing here would let a reader
		// infer the suite was checked and passed — the same conflation the probe
		// exists to prevent.
		process.stderr.write(`pre-flight skipped (${probe.skipReason}) — suite health is unverified\n`);
	}
	return null;
}

export interface MaybeRecordProvenance {
	scope: MeasurementScope;
	testCount: number;
	surface: MeasurementSurface;
}

export interface MeasureRecordSummary {
	recorded: boolean;
	reason?: string;
	before?: { mutants: number; survivors: number };
	after?: { mutants: number; survivors: number };
}

/** Attempt the record step, iff `--record` was passed AND the run produced a
 *  complete, conclusive report. The report may contain survivors: recording
 *  persists comparison state and never certifies the file as clean. A
 *  `partial`/`not_measurable`/`error`/`busy` outcome carries no
 *  `rawReport` (measure.ts never sets one for those), so this branch cannot
 *  reach the write path with anything but a real, complete report. */
export async function maybeRecordMeasurement(args: {
	record: boolean | undefined;
	outcome: MeasureOutcome;
	configDir: string;
	key: string;
	content: string;
	cwd: string;
	provenance?: MaybeRecordProvenance | undefined;
}): Promise<MeasureRecordSummary | null> {
	if (!args.record) return null;
	if (args.outcome.status !== "measured") {
		return {
			recorded: false,
			reason: `run was ${args.outcome.status}${args.outcome.reason ? ` (${args.outcome.reason})` : ""} — nothing to record`,
		};
	}
	const { emptyManifest, loadManifestState, saveManifest } = await import(
		"../harness/mutation/manifest.js"
	);
	const { recordMeasurement } = await import("../harness/mutation/measure.js");
	// Review 2026-08-28 (second pass, finding 3): the tri-state contract binds
	// EVERY mutation-state writer, not only the PreToolUse gate. The old
	// `loadManifest(...) ?? emptyManifest(...)` treated a CORRUPT manifest as
	// missing, so a manual `mutation measure --record` could replace damaged
	// history with a fresh floor — the exact ratchet reset the gate refuses.
	const manifestState = loadManifestState(args.configDir);
	if (manifestState.kind === "corrupt") {
		return {
			recorded: false,
			reason: `mutation manifest is corrupt (${manifestState.detail}) — refusing to record over damaged history; the file is preserved at ${args.configDir}/mutation-manifest.json for recovery`,
		};
	}
	const base =
		manifestState.kind === "valid"
			? manifestState.manifest
			: emptyManifest({
					engine: "stryker",
					engineVersion: "unknown",
					dependencyGraphVersion: "1",
					environmentHash: "cli-measure",
					authoritativeAt: new Date().toISOString(),
				});
	const rec = recordMeasurement({
		base,
		file: args.key,
		content: args.content,
		rawReport: args.outcome.rawReport,
		at: new Date().toISOString(),
		cwd: args.cwd,
		...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
	});
	// The write — and ONLY the write. `saveManifest` is the library's own fs
	// persister (manifest.ts); this command never touches mutation-manifest.json
	// through any other path.
	//
	// The survivors-index sidecar is written in the same CALL, immediately
	// after — NOT the same transaction (review 2026-08-28): two sequential
	// writes with no atomicity, so a crash between them leaves the sidecar
	// stale relative to the manifest until the SQLite journal lands. On the
	// happy path no persist skips it — the daemon reads only the sidecar, and
	// skipping it would silently freeze every Stop-time consumer at the
	// previous generation.
	if (rec.recorded && rec.manifest) {
		const { writeSurvivorsIndex } = await import("../harness/mutation/survivors-index.js");
		saveManifest(args.configDir, rec.manifest);
		writeSurvivorsIndex(args.configDir, rec.manifest);
	}
	return {
		recorded: rec.recorded,
		...(rec.reason !== undefined ? { reason: rec.reason } : {}),
		// SAFETY: RecordOutcome declares `before` as required, but callers
		// (proven by the mutation-kill test covering this line) can supply a
		// mocked/partial outcome that omits it — widened locally so the
		// conditional spread reflects reality.
		...((rec.before as FileSurvivorSummary | undefined) !== undefined ? { before: rec.before } : {}),
		...(rec.after !== undefined ? { after: rec.after } : {}),
	};
}

// ===========================================
// measureOneFile — the single-file pipeline, shared by `measure` and `sweep`
// ===========================================
// Extracted 2026-08-09 when `mutation sweep` arrived: the resolve → test-scope →
// overlay-closure → RED-suite pre-flight → measure → record sequence encodes
// several policies that must NOT exist twice (most sharply the pre-flight, whose
// absence silently forges ~155 killed mutants against a red suite). One step,
// two drivers.

/** Injected in tests; the default is the real network-backed `measureFile`. */
export type MeasureFn = (args: {
	file: string;
	content: string;
	overlays: Array<{ path: string; content: string }>;
	endpoints: string[];
	token?: string | undefined;
	deadlineMs?: number | undefined;
	testScope?: string[] | undefined;
}) => Promise<MeasureOutcome>;

/** Returns a fatal message, or null to proceed. Injected in tests. */
export type PreflightFn = (args: { tests: string[]; cwd: string; quiet: boolean }) => Promise<string | null>;

export interface MeasureOneArgs {
	/** Any spelling of the path; normalized to the manifest's canonical key. */
	file: string;
	cwd: string;
	configDir: string;
	record?: boolean | undefined;
	skipPreflight?: boolean | undefined;
	budgetMs?: number | undefined;
	runnerUrl?: string | undefined;
	/** Ordered fallback list — index 0 is tried first. Preferred over
	 *  `runnerUrl` when both are given. A caller that can reach several runners
	 *  passes all of them so a disconnected host costs one retry round, not the
	 *  whole per-file budget. */
	runnerUrls?: string[] | undefined;
	/** Suppress the progress notes this step writes to stderr. */
	quiet?: boolean | undefined;
	/** Progress sink, called as each note is produced (before the run starts). */
	onNote?: ((note: string) => void) | undefined;
	/** Recorded with the measurement so a later reader knows which surface (and
	 *  therefore which budget and scope) produced it. */
	surface?: MeasurementSurface | undefined;
	measure?: MeasureFn | undefined;
	preflight?: PreflightFn | undefined;
}

/**
 * Every way one file's measurement can end.
 *
 * `unreadable`, `no_runner` and `red_suite` are the caller's own refusals and
 * stay DISTINCT from the runner's five outcomes — a sweep that reported them as
 * `error` would blame the runner for a local misconfiguration, and a sweep that
 * reported them as `not_measurable` would claim the file has no tests.
 */
export interface MeasureOneResult {
	file: string;
	status: MeasureOutcome["status"] | "unreadable" | "no_runner" | "red_suite";
	reason?: string;
	mutants: number;
	survivors: number;
	survivorList: SurvivorEntry[];
	record: MeasureRecordSummary | null;
	/** Human-readable notes (scope size, dropped overlays) for a verbose caller. */
	notes: string[];
}

function refusal(file: string, status: MeasureOneResult["status"], reason: string): MeasureOneResult {
	return { file, status, reason, mutants: 0, survivors: 0, survivorList: [], record: null, notes: [] };
}

/** Resolve the runner endpoints for this run: an explicit override wins, else
 *  the repo's configured `per_edit_mutation` endpoints. */
async function resolveEndpoints(
	args: MeasureOneArgs,
	readDisk: (p: string) => string | null,
): Promise<{ endpoints: string[]; token?: string | undefined }> {
	if (args.runnerUrls && args.runnerUrls.length > 0) return { endpoints: [...args.runnerUrls] };
	if (args.runnerUrl) return { endpoints: [args.runnerUrl] };
	const { configuredRunnerEndpoints } = await import("../harness/mutation/measure.js");
	return configuredRunnerEndpoints(args.cwd, readDisk);
}

function networkMeasure(
	measureFile: typeof import("../harness/mutation/measure.js").measureFile,
): MeasureFn {
	return (args) =>
		measureFile({
			file: args.file,
			content: args.content,
			overlays: args.overlays,
			endpoints: args.endpoints,
			fetchImpl: (url, init) => fetch(url, { ...init, signal: init.signal }),
			...(args.token !== undefined ? { token: args.token } : {}),
			...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
			...(args.testScope !== undefined ? { testScope: args.testScope } : {}),
		});
}

type PreparedMeasurement =
	| { kind: "refused"; result: MeasureOneResult }
	| {
			kind: "ready";
			scope: MutationTestScopeResult;
			tests: string[];
			overlays: Array<{ path: string; content: string }>;
			notes: string[];
	  };

async function prepareMeasurement(input: {
	request: MeasureOneArgs;
	key: string;
	content: string;
	readDisk: (path: string) => string | null;
	runnerCount: number;
}): Promise<PreparedMeasurement> {
	const { request: args, key, content, readDisk, runnerCount } = input;
	const { resolve } = await import("node:path");
	const { buildScopedMeasureOverlays } = await import("../harness/mutation/measure.js");
	const { configuredMaxTestScope } = await import("../harness/mutation/runner-endpoints.js");
	const { computeMutationTestScopeForRepo } = await import("../harness/mutation/test-scope.js");
	const maxScope = configuredMaxTestScope(args.cwd, readDisk);
	const scope = computeMutationTestScopeForRepo({
		editedRelPath: key,
		projectRoot: args.cwd,
		...(maxScope !== undefined ? { maxScope } : {}),
	});
	const tests = scope.tests ?? scope.companionScope ?? [];
	const scoped = buildScopedMeasureOverlays(key, content, (path) => readDisk(resolve(args.cwd, path)), tests);
	const notes = overlayNotes({ key, scope, scoped, runnerCount });
	for (const note of notes) args.onNote?.(note);
	if (args.skipPreflight !== true) {
		const run = args.preflight ?? preflightScopedSuite;
		const red = await run({ tests, cwd: args.cwd, quiet: args.quiet === true });
		if (red !== null) return { kind: "refused", result: { ...refusal(key, "red_suite", red), notes } };
	}
	return { kind: "ready", scope, tests, overlays: scoped.overlays, notes };
}

export async function measureOneFile(args: MeasureOneArgs): Promise<MeasureOneResult> {
	const { measureFile, readDiskSafe } = await import("../harness/mutation/measure.js");
	const { normalizeManifestKey } = await import("../harness/mutation/manifest.js");
	const { resolve } = await import("node:path");

	const key = normalizeManifestKey(args.file, args.cwd);
	const content = readDiskSafe(resolve(args.cwd, key));
	if (content === null) return refusal(key, "unreadable", `Cannot read "${key}" (resolved from "${args.file}").`);

	const endpointCfg = await resolveEndpoints(args, readDiskSafe);
	if (endpointCfg.endpoints.length === 0) {
		return refusal(
			key,
			"no_runner",
			"No mutation runner configured. Pass --runner-url, or set per_edit_mutation.runner_url (or .runner_urls) in .interlinked/guard-rules.local.json.",
		);
	}

	const prepared = await prepareMeasurement({
		request: args,
		key,
		content,
		readDisk: readDiskSafe,
		runnerCount: endpointCfg.endpoints.length,
	});
	if (prepared.kind === "refused") return prepared.result;
	const { scope, tests: scopeTests, overlays, notes } = prepared;

	// The default carries the real `fetch`; an injected `measure` is the test seam
	// and must never be handed a live network implementation it did not ask for.
	// Optional keys are re-spread rather than forwarded, because the repo runs
	// `exactOptionalPropertyTypes` — an explicit `token: undefined` is a type
	// error, not a synonym for "absent".
	const measure = args.measure ?? networkMeasure(measureFile);
	const outcome = await measure({
		file: key,
		content,
		overlays,
		endpoints: endpointCfg.endpoints,
		...(endpointCfg.token !== undefined ? { token: endpointCfg.token } : {}),
		...(args.budgetMs !== undefined && Number.isFinite(args.budgetMs) ? { deadlineMs: args.budgetMs } : {}),
		// Forward whichever scope `scopeTests` resolved to — the full graph set,
		// or the over-cap companion fallback. Either overrides the runner's own
		// filename-stem guess; only a truly empty scope lets the runner fall back.
		...(scopeTests.length > 0 ? { testScope: scopeTests } : {}),
	});

	const record = await maybeRecordMeasurement({
		record: args.record,
		outcome,
		configDir: args.configDir,
		key,
		content,
		cwd: args.cwd,
		// Stamp HOW this ran. Two survivor counts for the same file are only
		// comparable when they were measured the same way, and this pipeline's
		// import-graph scope kills far more mutants than the runner's own
		// filename-glob guess — 186 survivors vs 18 on one unedited file. An
		// over-cap companion fallback is its OWN third regime (see
		// `measurementScopeFor`), comparable to neither.
		provenance: {
			scope: measurementScopeFor(scope),
			testCount: scopeTests.length,
			surface: args.surface ?? "measure",
		},
	});

	return {
		file: key,
		status: outcome.status,
		...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
		mutants: outcome.mutantCount,
		survivors: outcome.survivorCount,
		survivorList: outcome.survivors,
		record,
		notes,
	};
}

/** What this run is about to do, and what the overlay closure had to leave out.
 *  Silence on a partial closure would let an incomplete overlay set read as a
 *  complete one, so every omission is named — with the file names, since
 *  "dropped 2 files" cannot be acted on and "dropped a.ts, b.ts" can. */
function overlayNotes(args: {
	key: string;
	scope: MutationTestScopeResult;
	scoped: {
		overlays: unknown[];
		unreadable: string[];
		capped?: { candidateCount: number; limit: number; dropped: string[] } | undefined;
	};
	runnerCount: number;
}): string[] {
	const { key, scope, scoped, runnerCount } = args;
	const notes: string[] = [
		`measuring ${key} (${scoped.overlays.length} overlay(s)) via ${runnerCount} runner(s)…${testScopeNote(scope) ? `\n${testScopeNote(scope).trimEnd()}` : ""}`,
	];
	if (scoped.unreadable.length > 0) {
		notes.push(
			`WARNING: ${scoped.unreadable.length} file(s) in the closure could not be read and are MISSING from the overlay set: ${scoped.unreadable.join(", ")}`,
		);
	}
	if (scoped.capped) {
		notes.push(
			`WARNING: overlay closure had ${scoped.capped.candidateCount} candidates, capped to ${scoped.capped.limit}; dropped ${scoped.capped.dropped.length} dependency file(s): ${scoped.capped.dropped.join(", ")}`,
		);
	}
	return notes;
}

function renderSurvivorLines(survivors: SurvivorEntry[]): string[] {
	return survivors.map((s) => `    L${s.line}  ${s.mutator} -> ${JSON.stringify(s.replacement).slice(0, 90)}`);
}

function renderMeasureOutcome(outcome: MeasureOutcome): string[] {
	if (outcome.status === "partial") {
		return [
			c.yellow(`  PARTIAL — NOT RECORDED: ${outcome.reason ?? "incomplete evidence"}`),
			kvLine("Parsed mutants", String(outcome.mutantCount)),
			kvLine("Parsed survivors", String(outcome.survivorCount)),
			...renderSurvivorLines(outcome.survivors),
		];
	}
	if (outcome.status === "not_measurable") {
		return [c.yellow(`  NOT MEASURABLE: ${outcome.reason ?? "unknown reason"}`)];
	}
	if (outcome.status === "busy") {
		// Deliberately NOT rendered as NOT MEASURABLE: a busy runner never
		// answered, so this is not a no_tests verdict — conflating the two is
		// the exact measurement-integrity defect that drops a contended file
		// out of the campaign's denominator.
		return [c.yellow(`  RUNNER BUSY: ${outcome.reason ?? "all endpoints busy"} — not measured, retry later`)];
	}
	if (outcome.status === "error") {
		return [c.red(`  FAILED: ${outcome.reason ?? "unknown error"}`)];
	}
	return [
		kvLine("Mutants", String(outcome.mutantCount)),
		kvLine("Survivors", String(outcome.survivorCount)),
		...renderSurvivorLines(outcome.survivors),
	];
}

function renderRecordSummary(record: MeasureRecordSummary | null): string[] {
	if (!record) return [];
	if (!record.recorded) return ["", c.yellow(`  Not recorded: ${record.reason ?? "unknown reason"}`)];
	const before = record.before ? `${record.before.survivors}/${record.before.mutants}` : "?";
	const after = record.after ? `${record.after.survivors}/${record.after.mutants}` : "?";
	return ["", c.green(`  ✓ Recorded: ${before} → ${after} survivors/mutants (survivors/mutants, before → after)`)];
}

export function renderMeasureCommand(
	file: string,
	outcome: MeasureOutcome,
	record: MeasureRecordSummary | null,
): string {
	return [header(`Mutation Measure — ${file}`), ...renderMeasureOutcome(outcome), ...renderRecordSummary(record)].join(
		"\n",
	);
}
