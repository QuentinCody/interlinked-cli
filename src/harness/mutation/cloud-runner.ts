// ===========================================
// Per-edit mutation — cloud runner client (build steps 4–5, daemon side)
// ===========================================
// The daemon-side MutationRunner: forward the edited file + its proposed overlay
// content to the cloud Worker, which runs Stryker inside a Sandbox and returns a
// mutation-testing report; adapt that into RawMutants. This is the VERIFIABLE
// half of the runner (unit-tested with an injected fetch); the Worker
// (cloud/mutation-worker/) is the deploy-gated half. A non-ok response /
// unrecognized report THROWS — the gate turns that into an honest not-measured
// allow, never a forged clean pass (spec §12).

import { isJsonObject } from "../../lib/json-types.js";
import type { FileOverlay } from "./gate-overlays.js";
import type { MutationRunner, MutationRunOptions } from "./gate.js";
import { normalizeManifestKey } from "./manifest-key.js";
import { type AdaptedFile, type MutationRunOutput, strykerToAdapted } from "./stryker-adapter.js";
import type { TestRunResult } from "./types.js";

export interface CloudRunnerConfig {
	url: string;
	token?: string | undefined;
	timeoutMs: number;
	/** Repo root for canonicalizing the requested path against report entries
	 *  (the daemon threads its ctx.cwd). Absent ⇒ process.cwd(), same as every
	 *  other manifest-key call site. */
	cwd?: string | undefined;
}

/**
 * Thrown when the budget expired before the runner answered.
 *
 * Carries the job handle so the caller can claim the result in a LATER window
 * rather than discarding work the engine has already paid for. The id is minted
 * by the CLIENT before the request precisely so it survives this case — a
 * server-minted id would only ever arrive in the response we just gave up on.
 *
 * It is still an error, not a result: the caller must report honest
 * not-measured for this window and only upgrade if the harvest succeeds.
 */

/** Structured "nothing to measure" payload, if the runner sent one. Exported so
 *  `measure.ts` (the out-of-band single-file path) shares this ONE parser
 *  rather than growing its own second reading of the same wire shape. */
export function readNotMeasurable(body: unknown): { reason: string; detail?: string } | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = (body as { not_measurable?: unknown }).not_measurable;
	if (typeof raw !== "object" || raw === null) return null;
	const reason = (raw as { reason?: unknown }).reason;
	if (typeof reason !== "string" || reason === "") return null;
	const detail = (raw as { detail?: unknown }).detail;
	return typeof detail === "string" ? { reason, detail } : { reason };
}

/**
 * The runner answered, and the honest answer is "there is nothing to measure
 * here" — most often because no test exercises the target file.
 *
 * This is NOT a runner failure, and collapsing the two costs real time: a whole
 * session was spent debugging "the mutation runner failed" that actually meant
 * "the engine ran zero tests because this file has no companion test". It is
 * also the more USEFUL signal of the two — a file with no tests is precisely
 * what a test-enforcement harness should be saying out loud.
 */
export class MutationNotMeasurableError extends Error {
	readonly reason: string;

	constructor(reason: string, detail?: string) {
		super(detail ? `${reason}: ${detail}` : reason);
		this.name = "MutationNotMeasurableError";
		this.reason = reason;
	}
}

export class MutationRunPendingError extends Error {
	readonly jobId: string;
	readonly runnerUrl: string;

	constructor(jobId: string, runnerUrl: string, cause?: unknown) {
		super(`mutation run still pending (job ${jobId})`, cause === undefined ? undefined : { cause });
		this.name = "MutationRunPendingError";
		this.jobId = jobId;
		this.runnerUrl = runnerUrl;
	}
}

/**
 * The runner answered HTTP 503 — a single-worktree runner's honest "I am
 * currently running someone else's job" signal (`scratch/two-box-runner/runner.mjs`'s
 * `busy` lock), never a body the runner composed by actually attempting the run.
 *
 * This MUST stay distinct from both `MutationNotMeasurableError` (a completed,
 * definitive "no test exercises this file" verdict the runner reached BY
 * running) and a generic non-ok Error (an actually broken runner). Collapsing
 * "busy" into either of those is exactly the measurement-integrity defect this
 * type exists to prevent: a contended runner is not evidence of an absent
 * test, and a caller that cannot tell the two apart silently drops the file
 * out of the denominator every time the fleet is loaded.
 */
export class MutationRunnerBusyError extends Error {
	constructor() {
		super("mutation runner is busy with another job (HTTP 503) — not measured, not evidence of no_tests");
		this.name = "MutationRunnerBusyError";
	}
}

/** Distinct per request; the runner keys its retained report by this. */
function mintJobId(): string {
	return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	/** Optional so an injected test double stays a two-method object. Real
	 *  `fetch` always provides it, and it is the ONLY way to recover the body of
	 *  an error response — see `describeErrorResponse`. */
	text?: () => Promise<string>;
}

/** How much of a runner's error body to carry into the harness message. Long
 *  enough for a stack's first frames, short enough not to flood a hook warning. */
const ERROR_BODY_CHARS = 400;

/**
 * Turn a non-ok response into a message that says what actually went wrong.
 *
 * The status alone was all this client kept, and it was the least useful thing
 * available: `mutation runner HTTP 500` reached the agent as "the mutation
 * runner failed", with the runner's own explanation — clone failed, install
 * failed, engine crashed, wrong repo — discarded one function call from where
 * it arrived. A runner that bothers to explain itself must be quoted, not
 * summarized into a status code.
 *
 * Never throws: a body that cannot be read degrades to the bare status, which
 * is exactly the previous behavior.
 */
export async function describeErrorResponse(res: FetchResponse): Promise<string> {
	const detail = await readErrorBody(res);
	return detail === null
		? `mutation runner HTTP ${res.status}`
		: `mutation runner HTTP ${res.status}: ${detail}`;
}

async function readErrorBody(res: FetchResponse): Promise<string | null> {
	if (!res.text) return null;
	try {
		const raw = (await res.text()).trim();
		if (raw === "") return null;
		return collapse(extractMessage(raw)).slice(0, ERROR_BODY_CHARS);
	} catch {
		return null;
	}
}

/** Prefer a JSON body's own error field; fall back to the raw text. */
function extractMessage(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") return parsed;
		if (isJsonObject(parsed)) {
			for (const key of ["error", "message", "detail", "reason"]) {
				const value = parsed[key];
				if (typeof value === "string" && value.trim() !== "") return value;
			}
		}
	} catch {
		// Not JSON — the raw text IS the message.
	}
	return raw;
}

/**
 * Select the requested target's OWN report entry — the trust boundary of the
 * whole runner (review 2026-08-25, pass 6).
 *
 * Three reviewer-reproduced defects live here, each refused explicitly:
 * - suffix matching accepted `packages/x/src/a.ts` for `src/a.ts` — canonical
 *   EXACT equality only, through the same `normalizeManifestKey` choke point
 *   the manifest uses;
 * - `flatMap` pulled every report file's mutants into the target's verdict —
 *   only the target entry's mutants are returned;
 * - a report describing OLDER source text certified the new edit — the entry's
 *   source must equal the proposed overlay content byte-for-byte (a content
 *   hash echoed by the Worker is the eventual protocol; strict equality is the
 *   conservative first implementation).
 */
export function selectTargetEntry(
	adapted: AdaptedFile[],
	file: string,
	overlayContent: string,
	cwd: string | undefined,
): AdaptedFile {
	const canonical = normalizeManifestKey(file, cwd);
	const targets = adapted.filter((f) => normalizeManifestKey(f.file, cwd) === canonical);
	const target = targets[0];
	if (target === undefined) {
		throw new Error(
			`the mutation report has no entry for ${canonical} — a missing target is not a clean measurement`,
		);
	}
	if (targets.length > 1) {
		throw new Error(
			`the mutation report carries ${targets.length} entries resolving to ${canonical} — an ambiguous target is not a measurement`,
		);
	}
	if (target.content !== overlayContent) {
		throw new Error(
			`the mutation report describes different source than the proposed overlay for ${canonical} — a stale result never certifies a new edit`,
		);
	}
	return target;
}

/** One line, so a multi-line stack cannot wreck a terminal warning's shape. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponse>;

function headersFor(config: CloudRunnerConfig): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.token) headers.authorization = `Bearer ${config.token}`;
	return headers;
}

/** Recover the mutation engine's process exit status from the Worker response.
 *
 *  Three outcomes, deliberately distinct, because collapsing any pair of them
 *  reopens a false clean (goal 28 §8):
 *   - a number  — the engine reported that status; only `0` certifies.
 *   - `null`    — the Worker ran the engine but could not recover its status.
 *                 Not success. The Worker itself refuses to collapse this to 0,
 *                 and so must we.
 *   - `undefined` — the response carries no `engine` field at all, i.e. the
 *                 runner said nothing on the subject. Also not success.
 *
 *  A malformed `engine` field (present but not an object, or an `exitCode` that
 *  is neither a finite number nor null) reads as `null` rather than `undefined`:
 *  the runner CLAIMED to report a status and produced garbage, which is a
 *  stronger failure than staying silent, and must not be softened into "the
 *  runner never mentioned it". */
export function readEngineExitCode(body: unknown): number | null | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	if (!("engine" in body)) return undefined;
	const engine = (body as { engine?: unknown }).engine;
	if (typeof engine !== "object" || engine === null) return null;
	const code = (engine as { exitCode?: unknown }).exitCode;
	if (code === null) return null;
	if (typeof code === "number" && Number.isFinite(code)) return code;
	return null;
}

/** Parse the overlay test-run signal from the Worker response (spec §7).
 *  Absent / malformed ⇒ undefined — which, under the strict evidence rules
 *  (2026-08-28), the EVALUATOR refuses as not-measured rather than treating as
 *  "not red": a response with no test-run evidence can never certify clean. */
export function parseTestRun(body: unknown): TestRunResult | undefined {
	if (!isJsonObject(body) || !isJsonObject(body.testRun)) return undefined;
	const overlayGreen = body.testRun.overlayGreen;
	if (typeof overlayGreen !== "boolean") return undefined;
	const witness = body.testRun.redWitnessSatisfied;
	return { overlayGreen, redWitnessSatisfied: typeof witness === "boolean" ? witness : null };
}

/**
 * Read the runner-minted executed-test count.
 *
 * Stryker's JSON report cannot supply this evidence after the fact:
 * `testFiles[*].tests` includes skipped tests, then discards their status while
 * rendering the report. Counting those rows would let an all-skipped suite
 * claim that test oracles ran. Absence and malformed values therefore remain
 * `null`; only an explicit non-negative safe integer can cross this boundary.
 */
export function readExecutedTestCount(body: unknown): number | null {
	if (!isJsonObject(body)) return null;
	if (!isJsonObject(body.testRun) || !("executedTestCount" in body.testRun)) return null;
	const count = body.testRun.executedTestCount;
	return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Send the request and adapt the response into a `MutationRunOutput` — the
 * body of `run`'s try block, extracted so the timeout/abort bookkeeping
 * around it in `run` reads at its own nesting depth.
 */
async function attemptOperation(
	fetchImpl: FetchLike,
	config: CloudRunnerConfig,
	file: string,
	overlayContent: string,
	overlays: FileOverlay[] | undefined,
	options: MutationRunOptions | undefined,
	jobId: string,
	signal: AbortSignal,
): Promise<MutationRunOutput> {
	const res = await fetchImpl(config.url, {
		method: "POST",
		headers: headersFor(config),
		// `overlays` (full proposed state incl. the companion test) is
		// omitted when absent — an older Worker just ignores it.
		// Explicit scope + cache fields (review pass 19): the per-edit path
		// is ALWAYS whole-file with the incremental cache OFF, stated on
		// the wire — never inferred from a missing `range`. `range` and
		// `shard` no longer exist in the client (v1 line-range/shard
		// execution retired, passes 11-19); a runner that keys cache
		// behavior off range-absence must read these explicit fields.
		body: JSON.stringify({
			file,
			overlayContent,
			overlays,
			testScope: options?.testFiles,
			test_scope_mode: options?.scopeMode,
			scope: "whole_file",
			incremental: false,
			job_id: jobId,
		}),
		signal,
	});
	// 503 is the single-worktree runner's "busy" lock, which is neither a
	// failure nor evidence of a missing test — throw the dedicated type here
	// rather than leaving `gate.ts` to recover it from message text.
	if (res.status === 503) throw new MutationRunnerBusyError();
	if (!res.ok) throw new Error(await describeErrorResponse(res));
	const body = await res.json();
	// A runner that knows WHY it produced nothing says so, rather than
	// leaving the gate to report a generic failure.
	const notMeasurable = readNotMeasurable(body);
	if (notMeasurable) throw new MutationNotMeasurableError(notMeasurable.reason, notMeasurable.detail);
	// Review 2026-08-25, pass 7: the Worker reports a RED overlay suite as
	// `{files:{}, testRun:{overlayGreen:false}}` — Stryker never ran, so
	// there legitimately is no target entry. Selecting the target first
	// threw "no entry", the gate read that as unavailable, and a KNOWN red
	// suite failed to block. Red evidence short-circuits target selection.
	const testRun = parseTestRun(body);
	if (testRun?.overlayGreen === false) return { mutants: [], testRun };
	const adapted = strykerToAdapted(body);
	if (adapted === null) throw new Error("unrecognized mutation report");
	// The target's OWN entry, exact-path-matched and bound to the proposed
	// overlay content — see selectTargetEntry for the three refusals.
	const entry = selectTargetEntry(adapted, file, overlayContent, config.cwd);
	const mutants = entry.mutants;
	// Carry the parse loss to the evaluator rather than absorbing it here:
	// the runner's job is to report what arrived, the evaluator's is to
	// decide whether that is enough to certify.
	const dropped = entry.dropped > 0 ? { droppedMutants: entry.dropped } : {};
	// Same division of labour as `dropped`: carry the engine's status up
	// rather than judging it here. Absent stays absent, so the evaluator
	// can tell "the runner said nothing about the engine" apart from
	// "the engine reported a status".
	const engine = readEngineExitCode(body);
	const engineEvidence = engine === undefined ? {} : { engineExitCode: engine };
	const executedTestCount = readExecutedTestCount(body);
	return testRun
		? { mutants, testRun, executedTestCount, ...dropped, ...engineEvidence }
		: { mutants, executedTestCount, ...dropped, ...engineEvidence };
}

/** Daemon-side MutationRunner forwarding to the cloud Sandbox Worker (spec §8). */
export function createCloudMutationRunner(config: CloudRunnerConfig, fetchImpl: FetchLike): MutationRunner {
	return {
		available: () => config.url.length > 0,
		run: async (file, overlayContent, overlays, options) => {
			const controller = new AbortController();
			const jobId = mintJobId();
			// A bare `let` mutated only inside the setTimeout callback below is
			// invisible to TS's control-flow analysis at the read site in the catch
			// block — it wrongly proves that read always false. Routing the mutation
			// through an object property keeps the (real) runtime possibility honest.
			const timeoutState = { timedOut: false };
			const timer = setTimeout(() => {
				timeoutState.timedOut = true;
				controller.abort();
			}, config.timeoutMs);
			try {
				return await attemptOperation(
					fetchImpl,
					config,
					file,
					overlayContent,
					overlays,
					options,
					jobId,
					controller.signal,
				);
			} catch (err) {
				// Budget expiry is NOT the same failure as a broken runner. The engine
				// is still working and the result is retained under our job id, so
				// surface a handle the caller can harvest in its next window instead
				// of throwing away work that is already paid for.
				if (timeoutState.timedOut) throw new MutationRunPendingError(jobId, config.url, err);
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
