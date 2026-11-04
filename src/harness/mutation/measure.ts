// ===========================================
// Per-edit mutation — out-of-band single-file measurement + optional recording
// ===========================================
// Closes the campaign feedback-loop gap: `scratch/measure-file.mts` POSTs to the
// runner and prints results, but never writes them anywhere — so hardening work
// re-measured out of band stays invisible to the manifest the per-edit gate
// enforces against. This module is the first-class, testable replacement the
// `interlinked mutation measure` CLI command composes: request → summarize →
// (optionally) record, built ENTIRELY from existing primitives.
//
// IDENTITY-MATCH SOUNDNESS (investigated, not assumed — see the task that
// created this module): recording goes through `seedFileBaseline` (adopt.ts),
// which derives identities via
//   deriveIdentities(file, content, adapted.map((m) => m.raw))
// — i.e. FROM the exact array it is about to zip against, inside one `.map()`
// call. `Array.prototype.map` is order-preserving, so `identities[i]`
// corresponds to `adapted[i]` BY CONSTRUCTION, regardless of what order the
// runner emitted its mutants in. "The zip is only sound if the runner returns
// mutants in the same order identity computation produced them" describes a
// DIFFERENT, unsound design — deriving identities independently of the
// runner's own array and then matching positionally — which nothing in this
// codebase does. This module never diverges from the safe recipe: it hands
// the runner's raw JSON to `seedFileBaseline` UNMODIFIED and never separately
// re-derives or re-orders identities itself.
//
// PARTIAL RUNS ARE NEVER RECORDABLE. Transport-level shard partiality is
// excluded by construction:
// `requestWholeFileReport` (re-exported from measure-request.ts) talks to
// exactly ONE endpoint per attempt
// (redundant failover across configured endpoints, never concurrent
// sharding — line-range/shard execution is retired from v1 entirely).
// A sharded fan-out could succeed
// on some line-range shards and fail on others, and `applyMeasuredRun` has no
// way to distinguish "this symbol has zero mutants because its shard's
// request never completed" from "this symbol genuinely has zero mutable
// expressions" — silently recording the former as a clean symbol. Restricting
// this path to one whole-file answer per attempt means one endpoint owns the
// answer. `measureFile` still distinguishes a syntactically usable but
// evidentially incomplete HTTP-200 as `partial`: its findings remain visible,
// but `rawReport` is withheld and the manifest cannot move.

import { readFileSync } from "node:fs";
import { isTestPath } from "../coverage-test-selector.js";
import { seedFileBaseline } from "./adopt.js";
import {
	parseTestRun,
	readEngineExitCode,
	readExecutedTestCount,
	readNotMeasurable,
	selectTargetEntry,
} from "./cloud-runner.js";
import { v2RunEvidenceGaps } from "./evaluate.js";
import { computeSymbolHashes, deriveIdentities, mutationIdentityAvailable } from "./identity.js";
import {
	missingUnchangedMutants,
	type MeasuredMutant,
	normalizeManifestKey,
	stampProvenance,
} from "./manifest.js";
import type { MeasureOverlay } from "./measure-overlays.js";
import { requestWholeFileReport } from "./measure-request.js";
import type { ClaimFetchLike, FetchLike } from "./measure-request.js";
import { strykerToAdapted } from "./stryker-adapter.js";
import type { AdaptedFile } from "./stryker-adapter.js";
import type { MeasurementProvenance, MutantIdentity, MutantStatus, MutationManifest } from "./types.js";

// ============================================================
// Stable public facade for overlay, transport, and endpoint helpers
// ============================================================

export {
	buildMeasureOverlays,
	buildScopedMeasureOverlays,
	MAX_MEASURE_OVERLAYS,
} from "./measure-overlays.js";
export type { MeasureOverlay, ScopedOverlayResult } from "./measure-overlays.js";
export { requestWholeFileReport } from "./measure-request.js";
export type { ClaimFetchLike, FetchLike, FetchResponseLike, RequestArgs, RequestOutcome } from "./measure-request.js";
export { type ConfiguredEndpoints, configuredRunnerEndpoints } from "./runner-endpoints.js";

// ============================================================
// Report summarization (measure-only display — no identity work here)
// ============================================================

export interface SurvivorEntry {
	line: number;
	mutator: string;
	replacement: string;
}

const LINE_FEED = 10;

function lineForOffset(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (content.charCodeAt(i) === LINE_FEED) line++;
	}
	return line;
}

function summarizeTarget(entry: AdaptedFile | null): { mutantCount: number; survivors: SurvivorEntry[] } {
	if (entry === null) return { mutantCount: 0, survivors: [] };
	const survivors = entry.mutants
		.filter((mutant) => mutant.status === "survived")
		.map((mutant) => ({
			line: lineForOffset(entry.content, mutant.raw.startOffset),
			mutator: mutant.raw.mutator,
			replacement: mutant.raw.replacement,
		}));
	return { mutantCount: entry.mutants.length, survivors };
}

interface ReportInspection {
	target: AdaptedFile | null;
	gaps: string[];
}

function inspectedTarget(args: {
	body: unknown;
	file: string;
	content: string;
	cwd?: string | undefined;
}): { target: AdaptedFile | null; gap?: string } {
	const adapted = strykerToAdapted(args.body);
	if (adapted === null) {
		return { target: null, gap: "the runner response was not a recognizable mutation report" };
	}
	try {
		return { target: selectTargetEntry(adapted, args.file, args.content, args.cwd) };
	} catch (error) {
		return {
			target: null,
			gap: error instanceof Error ? error.message : "the report target could not be verified",
		};
	}
}

function reportConclusionGaps(target: AdaptedFile | null): string[] {
	if (target === null) return [];
	const gaps: string[] = [];
	if (target.mutants.length === 0) gaps.push("the runner reported zero mutants for this file — nothing to record");
	const inconclusive = target.mutants.filter(
		(mutant) => mutant.status === "timeout" || mutant.status === "indeterminate",
	).length;
	if (inconclusive > 0) {
		gaps.push(`${inconclusive} mutant(s) returned timeout/indeterminate — inconclusive evidence cannot replace a baseline`);
	}
	return gaps;
}

/** The non-negotiable, report-local half of record admission. */
function inspectReport(args: { body: unknown; file: string; content: string; cwd?: string | undefined }): ReportInspection {
	const inspected = inspectedTarget(args);
	const { target } = inspected;
	const gaps = inspected.gap === undefined ? [] : [inspected.gap];
	const testRun = parseTestRun(args.body);
	gaps.push(
		...v2RunEvidenceGaps({
			testRun,
			executedTestCount: readExecutedTestCount(args.body),
			engineExitCode: readEngineExitCode(args.body),
			droppedMutants: target?.dropped,
		}),
	);
	if (testRun?.overlayGreen === false) {
		gaps.push("the runner reported a RED overlay suite — red tests cannot establish a mutation baseline");
	}
	gaps.push(...reportConclusionGaps(target));
	return { target, gaps };
}

// ============================================================
// The measure-only entry point
// ============================================================

export const DEFAULT_MEASURE_DEADLINE_MS = 900_000;
export const DEFAULT_MEASURE_REQUEST_TIMEOUT_MS = 300_000;

export interface MeasureFileArgs {
	/** Repo-relative path — used verbatim as the request's `file` AND (via
	 *  `normalizeManifestKey`, applied downstream by the recorder) the manifest
	 *  key basis. Callers resolve their own path shape to this form first. */
	file: string;
	content: string;
	overlays: MeasureOverlay[];
	endpoints: string[];
	token?: string;
	fetchImpl: FetchLike;
	/** See `RequestArgs.claimFetch`: lets a timed-out request be observed again
	 *  instead of run again. The CLI always supplies it. */
	claimFetch?: ClaimFetchLike;
	jobId?: string;
	deadlineMs?: number;
	requestTimeoutMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** See `RequestArgs.testScope` — forwarded verbatim, untouched here. */
	testScope?: string[];
}

/** How the report was obtained — recorded so a measurement that ran twice, or
 *  was resumed after a timeout, is never indistinguishable from a plain one. */
export interface MeasureRequestRecord {
	/** POSTs the runner accepted for this job id; 2 = the file was measured twice. */
	attempts: number;
	/** The report was claimed from `/job/<id>` after the POST timed out — same execution. */
	resumed: boolean;
}

export interface MeasureOutcome {
	/**
	 * "busy" is its OWN terminal state, deliberately distinct from "error": every
	 * attempt up to the deadline was a contended runner (HTTP 503) or unreachable
	 * endpoint, so NOBODY ever answered the question "does this file have
	 * tests?" — reporting that as "error" (implies a broken runner) or, worse,
	 * as "not_measurable" (implies a definitive no_tests verdict) is exactly the
	 * measurement-integrity defect this type exists to prevent. Retry later.
	 */
	status: "measured" | "partial" | "not_measurable" | "error" | "busy";
	/** Set for "partial" (the evidence gaps), "not_measurable" (the runner's own reason), "error", and "busy"
	 *  (why the request could not produce a report). Absent on "measured". */
	reason?: string;
	mutantCount: number;
	survivorCount: number;
	survivors: SurvivorEntry[];
	/** The untouched runner response — present ONLY on "measured", and the ONLY
	 *  thing a caller may pass on to `recordMeasurement`. */
	rawReport?: unknown;
	/** Present whenever a report arrived (measured / partial / not_measurable). */
	request?: MeasureRequestRecord;
}

/** Measure one file end to end (request → classify → summarize). Never
 *  writes anything — recording is a deliberately separate, explicit step
 *  (`recordMeasurement`) so a caller can always choose measure-only. */
export async function measureFile(args: MeasureFileArgs): Promise<MeasureOutcome> {
	const result = await requestWholeFileReport({
		file: args.file,
		content: args.content,
		overlays: args.overlays,
		endpoints: args.endpoints,
		fetchImpl: args.fetchImpl,
		jobId: args.jobId ?? `measure-${args.file.replace(/\W/g, "-")}-${Date.now().toString(36)}`,
		deadlineMs: args.deadlineMs ?? DEFAULT_MEASURE_DEADLINE_MS,
		requestTimeoutMs: args.requestTimeoutMs ?? DEFAULT_MEASURE_REQUEST_TIMEOUT_MS,
		...(args.claimFetch !== undefined ? { claimFetch: args.claimFetch } : {}),
		...(args.token !== undefined ? { token: args.token } : {}),
		...(args.now !== undefined ? { now: args.now } : {}),
		...(args.sleep !== undefined ? { sleep: args.sleep } : {}),
		...(args.testScope !== undefined ? { testScope: args.testScope } : {}),
	});
	if (!result.ok) {
		const status = result.busy ? "busy" : "error";
		return { status, reason: result.reason, mutantCount: 0, survivorCount: 0, survivors: [] };
	}
	const request: MeasureRequestRecord = { attempts: result.attempts, resumed: result.resumed === true };
	const notMeasurable = readNotMeasurable(result.body);
	if (notMeasurable) {
		return {
			status: "not_measurable",
			reason: notMeasurable.detail ? `${notMeasurable.reason}: ${notMeasurable.detail}` : notMeasurable.reason,
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
			request,
		};
	}
	const inspection = inspectReport({ body: result.body, file: args.file, content: args.content });
	const { mutantCount, survivors } = summarizeTarget(inspection.target);
	if (inspection.gaps.length > 0) {
		return {
			status: "partial",
			reason: inspection.gaps.join("; "),
			mutantCount,
			survivorCount: survivors.length,
			survivors,
			request,
		};
	}
	return { status: "measured", mutantCount, survivorCount: survivors.length, survivors, rawReport: result.body, request };
}

// ============================================================
// Recording — the ONLY write path, and it goes through seedFileBaseline
// ============================================================

export interface FileSurvivorSummary {
	mutants: number;
	survivors: number;
}

export interface RecordArgs {
	base: MutationManifest;
	/** Same repo-relative path handed to `measureFile` — re-normalized
	 *  internally exactly as `seedFileBaseline`/`applyMeasuredRun` do. */
	file: string;
	content: string;
	/** Must be a "measured" outcome's `rawReport`, untouched. */
	rawReport: unknown;
	at: string;
	cwd?: string;
	/** The conditions this measurement ran under. Omitted ⇒ the file's records
	 *  carry NO provenance and every reader treats them as unqualified — which
	 *  is the honest reading, not a defect. */
	provenance?: Omit<MeasurementProvenance, "at"> | undefined;
}

export interface RecordOutcome {
	recorded: boolean;
	/** Human-readable reason recording was refused — set only when !recorded. */
	reason?: string;
	/** Present only when recorded — the caller persists this via `saveManifest`. */
	manifest?: MutationManifest;
	before: FileSurvivorSummary;
	after?: FileSurvivorSummary;
}

function summarizeManifestFile(manifest: MutationManifest, key: string): FileSurvivorSummary {
	const symbols = manifest.files[key] ?? {};
	let mutants = 0;
	let survivors = 0;
	for (const symbol of Object.values(symbols)) {
		for (const mutant of Object.values(symbol.mutants)) {
			mutants++;
			if (mutant.status === "survived" || mutant.status === "equivalent") survivors++;
		}
	}
	return { mutants, survivors };
}

/** Convert the already-validated target census into the continuity helper's
 *  input without inventing a status or silently shortening the zip. */
function measuredMutant(identity: MutantIdentity | undefined, status: MutantStatus): MeasuredMutant {
	if (identity === undefined) {
		throw new Error("identity derivation returned fewer rows than the validated mutant census");
	}
	return { identity, status };
}

function measuredMutants(target: AdaptedFile, identities: MutantIdentity[]): MeasuredMutant[] {
	return target.mutants.map((mutant, index) => measuredMutant(identities[index], mutant.status));
}

function recordEvidenceRefusal(args: RecordArgs, key: string): string | null {
	if (isTestPath(key)) {
		return "test files are not mutation targets — mutating a test proves nothing (the test is the oracle)";
	}
	if (!mutationIdentityAvailable()) {
		return "the TypeScript API is unavailable — install the `typescript` optionalDependency to enable identity-based recording";
	}
	const inspection = inspectReport({
		body: args.rawReport,
		file: args.file,
		content: args.content,
		cwd: args.cwd,
	});
	if (inspection.gaps.length > 0) return inspection.gaps.join("; ");
	const target = inspection.target;
	if (target === null) return "the report target could not be verified";
	const identities = deriveIdentities(
		args.file,
		args.content,
		target.mutants.map((mutant) => mutant.raw),
	);
	const overlayHashes = computeSymbolHashes(args.file, args.content);
	if (identities === null || overlayHashes === null) {
		return "the TypeScript API is unavailable — install the `typescript` optionalDependency to enable identity-based recording";
	}
	const missing = missingUnchangedMutants(
		args.base,
		key,
		overlayHashes,
		measuredMutants(target, identities),
	);
	if (missing.length > 0) {
		return `incomplete unchanged-symbol census — ${missing.length} prior mutant(s) were absent from the full current report (${missing.join(", ")})`;
	}
	return null;
}

/**
 * Record a measured run into the manifest through `seedFileBaseline` (adopt.ts)
 * — the SAME primitive the brownfield-adoption sweep already uses. Never
 * constructs a `SymbolRecord`/`MutantRecord` by hand: every field of the
 * returned manifest traces through `applyMeasuredRun`'s existing key
 * normalization, test-file rejection, and instability bookkeeping.
 *
 * Callers MUST only invoke this with a "measured" `MeasureOutcome`'s
 * `rawReport` — `measureFile` never returns one for partial, busy,
 * not-measurable, or failed runs. This function independently repeats the
 * evidence and continuity admission before calling the existing writer, so a
 * direct caller cannot bypass the command-level classification.
 */
export function recordMeasurement(args: RecordArgs): RecordOutcome {
	const key = normalizeManifestKey(args.file, args.cwd);
	const before = summarizeManifestFile(args.base, key);
	const evidenceRefusal = recordEvidenceRefusal(args, key);
	if (evidenceRefusal !== null) return { recorded: false, reason: evidenceRefusal, before };
	const seeded = seedFileBaseline({
		base: args.base,
		file: args.file,
		content: args.content,
		report: args.rawReport,
		at: args.at,
		...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
	});
	if (seeded === null) {
		return {
			recorded: false,
			reason: "seedFileBaseline rejected evidence that passed record admission — this indicates a consistency bug, not a safe write",
			before,
		};
	}
	// Stamp the regime alongside the records it produced. A survivor count is
	// only comparable to another one measured the same way — see
	// `MeasurementScope` for the 186-vs-18 measurement that forced this.
	const manifest = args.provenance
		? stampProvenance({
				manifest: seeded,
				file: args.file,
				provenance: { ...args.provenance, at: args.at },
				...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
			})
		: seeded;
	return { recorded: true, manifest, before, after: summarizeManifestFile(manifest, key) };
}

/** Convenience for CLI/script callers that just want to read a file off disk;
 *  not used by the pure functions above (which all take an injected reader). */
export function readDiskSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
