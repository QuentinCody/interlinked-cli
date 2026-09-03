import { describeErrorResponse } from "./cloud-runner.js";
import type { MeasureOverlay } from "./measure-overlays.js";

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	/** Optional so a test double stays a two-method object; real `fetch` always
	 * has it, and it is the only way to recover an error response's body. */
	text?: () => Promise<string>;
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface RequestArgs {
	file: string;
	content: string;
	overlays: MeasureOverlay[];
	endpoints: string[];
	token?: string;
	fetchImpl: FetchLike;
	jobId: string;
	/**
	 * Repo-relative test paths selected via the reverse import graph
	 * (`test-scope.ts::computeMutationTestScope`), forwarded so the runner can
	 * use the CORRECT suite instead of its own filename-glob guess. Absent (or
	 * omitted) ⇒ the runner falls back to its existing `testScopeFor` — this is
	 * an additive wire field an older runner can safely ignore.
	 */
	testScope?: string[];
	/** Total time to keep retrying busy/unreachable endpoints before giving up. */
	deadlineMs: number;
	/** Per-request abort timeout. */
	requestTimeoutMs: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export type RequestOutcome =
	| { ok: true; body: unknown }
	| {
			ok: false;
			reason: string;
			/** Set ONLY when every attempt up to the deadline was busy (HTTP 503) or
			 * unreachable — i.e. no endpoint ever gave a definitive answer. Absent
			 * for a genuine non-503 HTTP error, which IS a definitive (if unhappy)
			 * answer. Callers must not fold this into "error": a busy runner has
			 * said nothing about whether the file has tests, so it must never be
			 * read as (or reported alongside) a no_tests verdict. */
			busy?: true;
	  };

function headersFor(token?: string): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

/**
 * One endpoint attempt, with BUSY and UNREACHABLE kept apart.
 *
 * Both used to collapse to `null`, and the caller then retried until its whole
 * deadline elapsed — correct for a contended runner (it will free up) and
 * badly wrong for a disconnected one (it will not). A sweep with a 900s budget
 * spent fifteen minutes per file posting to a laptop that had closed.
 */
type EndpointAttempt =
	| { kind: "response"; res: FetchResponseLike }
	| { kind: "busy" }
	| { kind: "unreachable" };

async function tryEndpoint(
	url: string,
	body: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
	requestTimeoutMs: number,
): Promise<EndpointAttempt> {
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
		return res.status === 503 ? { kind: "busy" } : { kind: "response", res };
	} catch {
		return { kind: "unreachable" };
	}
}

/**
 * Rounds of "every endpoint refused the connection" before giving up early.
 *
 * More than one, because a single round can fail for reasons that clear on
 * their own — a Wi-Fi handover, a runner restarting, a VPN re-key. Few, because
 * once a host is actually gone, every further round is dead time multiplied by
 * every remaining file.
 */
const UNREACHABLE_ROUNDS_BEFORE_GIVING_UP = 3;

/** Outcome of trying every configured endpoint once, in order. */
type EndpointsRoundResult =
	| { kind: "done"; outcome: RequestOutcome }
	| { kind: "continue"; reachedSomeone: boolean };

/**
 * Try each endpoint in turn for one round. Returns as soon as any endpoint
 * gives a definitive (non-busy, reachable) answer; otherwise reports whether
 * at least one endpoint was reachable (busy counts as reached — it is a
 * disconnected host, not a bad answer, that should not count toward the
 * unreachable-rounds budget).
 */
async function attemptAllEndpoints(
	endpoints: string[],
	body: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
	requestTimeoutMs: number,
): Promise<EndpointsRoundResult> {
	let reachedSomeone = false;
	for (const url of endpoints) {
		const endpointAttempt = await tryEndpoint(url, body, headers, fetchImpl, requestTimeoutMs);
		if (endpointAttempt.kind === "busy") {
			reachedSomeone = true;
			continue;
		}
		if (endpointAttempt.kind === "unreachable") continue;
		const res = endpointAttempt.res;
		// Quote the runner rather than reducing it to a status code. This path
		// is the SWEEP's, distinct from cloud-runner.ts's (the per-edit gate's)
		// — the same defect existed in both, and a live 719-file sweep found
		// this copy by reporting a bare `runner HTTP 500` for a file whose
		// runner had explained itself perfectly well.
		if (!res.ok) return { kind: "done", outcome: { ok: false, reason: await describeErrorResponse(res) } };
		return { kind: "done", outcome: { ok: true, body: await res.json() } };
	}
	return { kind: "continue", reachedSomeone };
}

function requestBody(args: RequestArgs): string {
	return JSON.stringify({
		file: args.file,
		overlayContent: args.content,
		overlays: args.overlays,
		// Explicit protocol v2 fields: the runner selects cache behavior ONLY
		// from the explicit `incremental` field — `range` is retired (protocol
		// v2 REJECTS it) and cache-avoidance is no longer smuggled through a
		// synthetic whole-file range (measure-file.mts learned the stale
		// `--incremental` replay the hard way).
		scope: "whole_file",
		incremental: false,
		job_id: args.jobId,
		// Omitted (not even an empty array) when absent, matching `overlays`'
		// own back-compat convention — an older runner that doesn't recognize
		// the key just ignores it and falls back to its own scoping.
		...(args.testScope ? { testScope: args.testScope } : {}),
	});
}

/**
 * POST one whole-file measurement, trying each configured endpoint in turn and
 * retrying the whole round (jittered backoff) until `deadlineMs` elapses.
 * Exactly one endpoint's answer is ever used — see measure.ts's module
 * docstring for why this never fans the request out across concurrent shards.
 */
export async function requestWholeFileReport(args: RequestArgs): Promise<RequestOutcome> {
	const now = args.now ?? Date.now;
	const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const body = requestBody(args);
	const headers = headersFor(args.token);
	const deadline = now() + args.deadlineMs;
	let attempt = 0;
	let allUnreachableRounds = 0;
	while (now() < deadline) {
		const round = await attemptAllEndpoints(args.endpoints, body, headers, args.fetchImpl, args.requestTimeoutMs);
		if (round.kind === "done") return round.outcome;
		allUnreachableRounds = round.reachedSomeone ? 0 : allUnreachableRounds + 1;
		if (allUnreachableRounds >= UNREACHABLE_ROUNDS_BEFORE_GIVING_UP) {
			return {
				ok: false,
				busy: true,
				reason: `runner_unreachable: no runner answered on ${args.endpoints.join(", ")} across ${allUnreachableRounds} rounds — the host is down or the network is gone, NOT evidence this file lacks tests`,
			};
		}
		attempt++;
		const waitMs = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 750);
		await sleep(waitMs);
	}
	// Every attempt across every round was 503-busy or unreachable — nobody ever
	// gave a definitive answer. That is NOT the same failure as a non-503 HTTP
	// error (handled above, immediately, without this label): this is a
	// contended-but-presumably-working runner, and the caller must be able to
	// tell the two apart rather than reporting either one as "error" generically
	// (and NEVER as a no_tests verdict — the runner never got to answer).
	return {
		ok: false,
		busy: true,
		reason: `runner_busy: all runner(s) busy or unreachable after ${Math.round(args.deadlineMs / 1000)}s — retry later; NOT evidence this file lacks tests`,
	};
}
