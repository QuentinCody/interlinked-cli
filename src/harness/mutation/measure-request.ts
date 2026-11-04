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

/** The GET that claims a retained result (`<endpoint>/job/<jobId>`); a separate
 *  shape because a GET carries no body and `fetch` refuses one on GET. */
export type ClaimFetchLike = (
	url: string,
	init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface RequestArgs {
	file: string;
	content: string;
	overlays: MeasureOverlay[];
	endpoints: string[];
	token?: string;
	fetchImpl: FetchLike;
	/**
	 * Claims the retained result of a POST whose HTTP window closed before the
	 * engine finished (`GET <endpoint>/job/<jobId>`; the LAN runner and the
	 * per-edit harvest path serve the same route, single-use, 404 = not
	 * finished). Absent ⇒ a timed-out request can only be re-POSTed, which
	 * starts a SECOND execution; the product command always supplies it.
	 */
	claimFetch?: ClaimFetchLike;
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
	| {
			ok: true;
			body: unknown;
			/** How many POSTs the runner ACCEPTED for this job id (a 503 or a refused
			 * connection is not a start). 1 is the normal case; 2 means a timed-out
			 * execution could not be claimed and the measurement was run again —
			 * a recorded second attempt, never a silent one. */
			attempts: number;
			/** Set when the body came from `GET /job/<id>` — the SAME execution the
			 * timed-out POST started, observed again rather than re-run. */
			resumed?: true;
	  }
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
	| { kind: "unreachable" }
	/** The request was sent and the client gave up waiting. The runner may still
	 * be executing it (a Stryker run outlives undici's 300 s header timeout
	 * routinely); only a later claim can tell. */
	| { kind: "timeout" };

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
	} catch (err) {
		return isTimeoutError(err) ? { kind: "timeout" } : { kind: "unreachable" };
	}
}

/** `AbortSignal.timeout` aborts with a DOMException named TimeoutError (fetch
 *  rethrows it as-is); undici's own header/body timeouts surface as
 *  `HeadersTimeoutError` / `BodyTimeoutError` under a wrapping `TypeError`. */
function isTimeoutError(err: unknown): boolean {
	const seen = new Set<unknown>();
	let cur: unknown = err;
	while (cur && typeof cur === "object" && !seen.has(cur)) {
		seen.add(cur);
		const name = (cur as { name?: unknown }).name;
		const code = (cur as { code?: unknown }).code;
		if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") return true;
		if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return true;
		cur = (cur as { cause?: unknown }).cause;
	}
	return false;
}

type ClaimAttempt =
	| { kind: "claimed"; body: unknown }
	| { kind: "not_finished" }
	| { kind: "unreachable" }
	| { kind: "error"; res: FetchResponseLike };

/** Ask the runner for the retained result of `jobId`. 404 is "not finished, or
 *  never existed" — the caller falls through to the normal POST, which the
 *  runner answers 503 while that very job is still running. */
async function claimJob(
	url: string,
	jobId: string,
	headers: Record<string, string>,
	claimFetch: ClaimFetchLike,
	requestTimeoutMs: number,
): Promise<ClaimAttempt> {
	try {
		const res = await claimFetch(`${url.replace(/\/$/, "")}/job/${encodeURIComponent(jobId)}`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
		if (res.status === 404) return { kind: "not_finished" };
		if (!res.ok) return { kind: "error", res };
		return { kind: "claimed", body: await res.json() };
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

/** What the rounds remember about one job: which endpoints may still be
 *  executing a POST that timed out, and how many POSTs were accepted. */
interface JobState {
	inFlight: Set<string>;
	attempts: number;
}

/** The claim step for an endpoint whose POST timed out earlier. A claimed body
 *  is the SAME execution observed again (`resumed`); a runner error is final;
 *  "not_finished" and "unreachable" hand the decision back to the round. */
async function claimFirst(
	url: string,
	headers: Record<string, string>,
	claimFetch: ClaimFetchLike,
	args: Pick<RequestArgs, "jobId" | "requestTimeoutMs">,
	state: JobState,
): Promise<EndpointsRoundResult | "not_finished" | "unreachable"> {
	const claim = await claimJob(url, args.jobId, headers, claimFetch, args.requestTimeoutMs);
	if (claim.kind === "claimed") {
		return { kind: "done", outcome: { ok: true, body: claim.body, attempts: state.attempts, resumed: true } };
	}
	if (claim.kind === "error") return { kind: "done", outcome: { ok: false, reason: await describeErrorResponse(claim.res) } };
	return claim.kind;
}

/**
 * Try each endpoint in turn for one round. Returns as soon as any endpoint
 * gives a definitive (non-busy, reachable) answer; otherwise reports whether
 * at least one endpoint was reachable (busy counts as reached — it is a
 * disconnected host, not a bad answer, that should not count toward the
 * unreachable-rounds budget).
 *
 * An endpoint whose POST timed out in an earlier round is asked for the
 * retained result FIRST: a claim is the same execution observed again. Only
 * when the runner says it holds nothing (404) is the POST repeated — and a
 * repeat the runner accepts is counted as a second attempt, so the caller can
 * record that the measurement ran twice.
 */
async function attemptAllEndpoints(
	endpoints: string[],
	body: string,
	headers: Record<string, string>,
	args: Pick<RequestArgs, "fetchImpl" | "claimFetch" | "jobId" | "requestTimeoutMs">,
	state: JobState,
): Promise<EndpointsRoundResult> {
	let reachedSomeone = false;
	for (const url of endpoints) {
		if (state.inFlight.has(url) && args.claimFetch) {
			const claimed = await claimFirst(url, headers, args.claimFetch, args, state);
			if (claimed === "unreachable") continue;
			if (claimed !== "not_finished") return claimed;
			// not_finished: the run is still going (the POST below answers 503) or
			// never reached the runner (the POST below starts it) — either way the
			// POST is the right next move.
		}
		const endpointAttempt = await tryEndpoint(url, body, headers, args.fetchImpl, args.requestTimeoutMs);
		if (endpointAttempt.kind === "busy") {
			reachedSomeone = true;
			continue;
		}
		if (endpointAttempt.kind === "unreachable") continue;
		if (endpointAttempt.kind === "timeout") {
			// The request was sent, so the runner may be executing it: remember to
			// claim before posting again. Counts as an accepted attempt until a
			// claim proves otherwise (a runner that never got it answers 404 and
			// the next POST is then counted in its place).
			reachedSomeone = true;
			if (!state.inFlight.has(url)) state.attempts++;
			state.inFlight.add(url);
			continue;
		}
		const res = endpointAttempt.res;
		// An accepted POST is one more execution — the second one when it follows
		// a timed-out POST the runner held nothing for.
		state.attempts++;
		// Quote the runner rather than reducing it to a status code. This path
		// is the SWEEP's, distinct from cloud-runner.ts's (the per-edit gate's)
		// — the same defect existed in both, and a live 719-file sweep found
		// this copy by reporting a bare `runner HTTP 500` for a file whose
		// runner had explained itself perfectly well.
		if (!res.ok) return { kind: "done", outcome: { ok: false, reason: await describeErrorResponse(res) } };
		return { kind: "done", outcome: { ok: true, body: await res.json(), attempts: state.attempts } };
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
	const state: JobState = { inFlight: new Set(), attempts: 0 };
	while (now() < deadline) {
		const round = await attemptAllEndpoints(args.endpoints, body, headers, args, state);
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
