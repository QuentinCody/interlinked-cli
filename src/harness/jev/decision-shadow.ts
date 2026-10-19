// Decision shadows — shared core (program 2026-10-08, unit U1).
//
// A decision shadow asks a decision model ONE fixed Noul question about an
// event the guard already decided, and LOGS the answer. It never warns,
// never blocks, never changes a decision and never delays the hook response:
// callers schedule it with `scheduleShadow` (setImmediate) and nothing awaits
// it. Two surfaces use this core:
//
//   * `guard_block` (block-shadow.ts) — E20: "is this blocked shell command
//     destructive as it would execute?" → would_release / would_hold.
//   * `secret_hit` (secret-shadow.ts) — E19: "is this secret-signature match a
//     real credential?" → would_clear / would_keep.
//
// Rows go to `.interlinked/decision-shadow.jsonl` (the E7 edit-shadow ledger;
// rows are told apart by `surface`). Gates, in order: `event.dry_run`
// (`interlinked harness test` probes), `decision_shadow.enabled` + the
// per-surface switch (default OFF), one call per (hook event, tool_use_id),
// at most MAX_INFLIGHT concurrent requests and DAEMON_CALL_CAP calls per
// daemon, resolvable backend credentials. A backend failure writes NO row:
// it bumps a counter and the shadow stays silent (fail open).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { resolveApiKey } from "../policy-classifier.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { JEV_API_KEY_ENV, JevClient, type JevFetch } from "./client.js";
import { EDIT_SHADOW_LEDGER } from "./edit-shadow.js";
import type { DecisionShadowBackend, DecisionShadowConfig, JevEntry, JevNoulQuestion } from "./types.js";

export const DECISION_SHADOW_LEDGER = EDIT_SHADOW_LEDGER;
/** Hard ceiling on one request; `decision_shadow.timeout_ms` may only lower it. */
export const DECISION_SHADOW_MAX_TIMEOUT_MS = 3_000;
export const CLEF_FLASH_MODEL = "clef-flash";
export const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
export const CLOUDFLARE_ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";
/** Concurrent requests above this are skipped (counted), never queued. */
const MAX_INFLIGHT = 4;
/** Per-daemon call ceiling: a runaway loop cannot turn into a bill. */
const DAEMON_CALL_CAP = 5_000;
/** Bound on remembered (hook event, tool_use_id) claims. */
const SEEN_CAP = 4_096;

export type DecisionShadowSurface = "guard_block" | "secret_hit";
export type DecisionShadowVerdict = "would_release" | "would_hold" | "would_clear" | "would_keep";

export interface DecisionShadowRow {
	ts: string;
	session_id: string;
	surface: DecisionShadowSurface;
	rule_id: string | null;
	tool: string;
	tool_use_id: string | null;
	p: number;
	verdict: DecisionShadowVerdict;
	threshold_used: number;
	backend: DecisionShadowBackend;
	model: string | null;
	latency_ms: number;
	state_sha256: string;
	dry_run: boolean;
}

/** One question to ask about one event. `verdicts` maps p < threshold /
 *  p ≥ threshold to the surface's two labels. */
export interface ShadowRequest {
	event: HarnessEvent;
	surface: DecisionShadowSurface;
	ruleId: string | null;
	tool: string;
	state: JevEntry;
	question: JevNoulQuestion;
	threshold: number;
	verdicts: { below: DecisionShadowVerdict; atOrAbove: DecisionShadowVerdict };
}

export interface DecisionShadowDeps {
	/** Injected in tests; global fetch otherwise. */
	fetchImpl?: JevFetch;
	/** Injected in tests; `resolveApiKey` (env, then config.local.json) otherwise. */
	resolveKey?: (name: string) => string | undefined;
}

export interface DecisionShadowCounters {
	calls: number;
	rows: number;
	failures: number;
	unconfigured: number;
	skipped_busy: number;
	skipped_cap: number;
	skipped_unsafe_state: number;
	ledger_errors: number;
	last_error: string | null;
}

interface CoreState {
	counters: DecisionShadowCounters;
	seen: Set<string>;
	inflight: Set<Promise<unknown>>;
}

function freshState(): CoreState {
	return {
		counters: {
			calls: 0, rows: 0, failures: 0, unconfigured: 0, skipped_busy: 0, skipped_cap: 0,
			skipped_unsafe_state: 0, ledger_errors: 0, last_error: null,
		},
		seen: new Set(),
		inflight: new Set(),
	};
}

let state: CoreState = freshState();

/** Test seam: counters, claims and in-flight set are per daemon process. */
export function resetDecisionShadowState(): void {
	state = freshState();
}

/** Snapshot of this process's counters. */
export function decisionShadowCounters(): DecisionShadowCounters {
	return { ...state.counters };
}

/** Count an error a surface swallowed so the hook response never sees it. */
export function noteShadowFailure(err: unknown): void {
	state.counters.failures++;
	state.counters.last_error = err instanceof Error ? err.message : String(err);
}

/** Count a state a surface refused to send (e.g. an unmasked residue). */
export function noteUnsafeState(): void {
	state.counters.skipped_unsafe_state++;
}

/** The section, when the master switch and this surface's switch are on. */
export function activeShadowConfig(rules: GuardRulesConfig, surface: DecisionShadowSurface): DecisionShadowConfig | null {
	const cfg = rules.decision_shadow;
	if (cfg?.enabled !== true) return null;
	return cfg.surfaces?.[surface] === false ? null : cfg;
}

type Credentials =
	| { backend: "clef_flash"; token: string; account: string }
	| { backend: "jev"; apiKey: string };

/** Credentials for the configured backend, or the reason there are none. */
export function resolveBackend(
	rules: GuardRulesConfig,
	resolveKey: (name: string) => string | undefined = resolveApiKey,
): { ok: true; creds: Credentials } | { ok: false; backend: DecisionShadowBackend; reason: string } {
	const backend = rules.decision_shadow?.backend ?? "clef_flash";
	if (backend === "jev") {
		if (rules.jev?.enabled !== true) return { ok: false, backend, reason: "jev.enabled is false" };
		const apiKey = resolveKey(JEV_API_KEY_ENV);
		return apiKey ? { ok: true, creds: { backend, apiKey } } : { ok: false, backend, reason: `${JEV_API_KEY_ENV} not found` };
	}
	const token = resolveKey(CLOUDFLARE_TOKEN_ENV);
	const account = resolveKey(CLOUDFLARE_ACCOUNT_ENV);
	if (!token || !account) {
		const missing = [!token ? CLOUDFLARE_TOKEN_ENV : null, !account ? CLOUDFLARE_ACCOUNT_ENV : null].filter(Boolean).join(" + ");
		return { ok: false, backend, reason: `${missing} not found (env or .interlinked/config.local.json)` };
	}
	return { ok: true, creds: { backend, token, account } };
}

export function clefFlashUrl(account: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/cloudflare/${CLEF_FLASH_MODEL}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Workers AI wraps the System One answer in `result`; accept either shape. */
function parseClefAnswer(raw: unknown): { p: number; model: string | null } | null {
	if (!isRecord(raw)) return null;
	const res = isRecord(raw.result) ? raw.result : raw;
	const answers = res.answers;
	const q1 = isRecord(answers) ? answers.q1 : undefined;
	const p = isRecord(q1) ? q1.noul : undefined;
	if (typeof p !== "number") return null;
	return { p, model: typeof res.model === "string" ? res.model : CLEF_FLASH_MODEL };
}

type AskOutcome = { ok: true; p: number; model: string | null } | { ok: false; error: string };

async function askClef(creds: { token: string; account: string }, body: string, timeoutMs: number, fetchImpl: JevFetch): Promise<AskOutcome> {
	try {
		const res = await fetchImpl(clefFlashUrl(creds.account), {
			method: "POST",
			headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, error: `http_${res.status}` };
		const parsed = parseClefAnswer(await res.json());
		return parsed ? { ok: true, ...parsed } : { ok: false, error: "malformed" };
	} catch (err) {
		return { ok: false, error: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network" };
	}
}

async function askJev(apiKey: string, rules: GuardRulesConfig, req: ShadowRequest, timeoutMs: number, fetchImpl: JevFetch | undefined): Promise<AskOutcome> {
	const client = new JevClient({ apiKey, config: { ...rules.jev, timeout_ms: timeoutMs }, ...(fetchImpl ? { fetchImpl } : {}) });
	const result = await client.askDetailed(req.state, { q1: req.question });
	if (!result.ok) return { ok: false, error: result.error };
	const answer = result.response.answers.q1;
	return answer?.type === "noul" ? { ok: true, p: answer.noul, model: result.response.model } : { ok: false, error: "missing_answer" };
}

/** Claim this (hook event, tool call); false on a repeat delivery. */
function claim(event: HarnessEvent): boolean {
	if (!event.tool_use_id) return true;
	const key = `${event.hook_event}:${event.tool_use_id}`;
	if (state.seen.has(key)) return false;
	if (state.seen.size >= SEEN_CAP) state.seen.clear();
	state.seen.add(key);
	return true;
}

function admit(event: HarnessEvent): boolean {
	if (state.inflight.size >= MAX_INFLIGHT) {
		state.counters.skipped_busy++;
		return false;
	}
	if (state.counters.calls >= DAEMON_CALL_CAP) {
		state.counters.skipped_cap++;
		return false;
	}
	return claim(event);
}

function appendRow(cwd: string, row: DecisionShadowRow): void {
	const dir = join(cwd, ".interlinked");
	try {
		if (!existsSync(dir)) return;
		appendFileSync(join(dir, DECISION_SHADOW_LEDGER), `${JSON.stringify(row)}\n`);
		state.counters.rows++;
	} catch (err) {
		state.counters.ledger_errors++;
		state.counters.last_error = err instanceof Error ? err.message : String(err);
	}
}

/**
 * Ask one shadow question and log the row. Resolves to the row, or null when
 * a gate refused or the backend failed. Never rejects.
 */
export async function runShadowAsk(rules: GuardRulesConfig, req: ShadowRequest, deps: DecisionShadowDeps = {}): Promise<DecisionShadowRow | null> {
	try {
		if (req.event.dry_run === true) return null;
		const cfg = activeShadowConfig(rules, req.surface);
		if (!cfg) return null;
		const resolved = resolveBackend(rules, deps.resolveKey);
		if (!resolved.ok) {
			state.counters.unconfigured++;
			return null;
		}
		if (!admit(req.event)) return null;
		const pending = askAndRecord(rules, cfg, req, resolved.creds, deps);
		state.inflight.add(pending);
		try {
			return await pending;
		} finally {
			state.inflight.delete(pending);
		}
	} catch (err) {
		noteShadowFailure(err);
		return null;
	}
}

async function askAndRecord(
	rules: GuardRulesConfig,
	cfg: DecisionShadowConfig,
	req: ShadowRequest,
	creds: Credentials,
	deps: DecisionShadowDeps,
): Promise<DecisionShadowRow | null> {
	const timeoutMs = Math.min(cfg.timeout_ms ?? DECISION_SHADOW_MAX_TIMEOUT_MS, DECISION_SHADOW_MAX_TIMEOUT_MS);
	const stateJson = JSON.stringify(req.state);
	state.counters.calls++;
	const started = performance.now();
	const outcome =
		creds.backend === "clef_flash"
			? await askClef(creds, JSON.stringify({ model: CLEF_FLASH_MODEL, state: req.state, questions: { q1: req.question } }), timeoutMs, deps.fetchImpl ?? ((u, i) => fetch(u, i)))
			: await askJev(creds.apiKey, rules, req, timeoutMs, deps.fetchImpl);
	const latency = Math.round(performance.now() - started);
	if (!outcome.ok || !Number.isFinite(outcome.p) || outcome.p < 0 || outcome.p > 1) {
		state.counters.failures++;
		state.counters.last_error = outcome.ok ? "p_out_of_range" : outcome.error;
		return null;
	}
	const row: DecisionShadowRow = {
		ts: new Date().toISOString(),
		session_id: req.event.session_id,
		surface: req.surface,
		rule_id: req.ruleId,
		tool: req.tool,
		tool_use_id: req.event.tool_use_id ?? null,
		p: outcome.p,
		verdict: outcome.p < req.threshold ? req.verdicts.below : req.verdicts.atOrAbove,
		threshold_used: req.threshold,
		backend: creds.backend,
		model: outcome.model,
		latency_ms: latency,
		state_sha256: createHash("sha256").update(stateJson).digest("hex"),
		dry_run: req.event.dry_run === true,
	};
	appendRow(req.event.cwd || process.cwd(), row);
	return row;
}

const scheduled = new Set<Promise<unknown>>();

/** Hook-path entry: run `work` on a later tick; the hook response never waits.
 *  `work` must not throw (every surface wraps its body), but a rejection is
 *  still swallowed and counted. */
export function scheduleShadow(work: () => Promise<unknown>): void {
	setImmediate(() => {
		const p = work().catch(noteShadowFailure);
		scheduled.add(p);
		void p.finally(() => scheduled.delete(p));
	});
}

/** Test seam: wait for every scheduled shadow (one tick, then the requests). */
export async function drainDecisionShadows(): Promise<void> {
	await new Promise<void>((r) => setImmediate(r));
	while (scheduled.size > 0) await Promise.all([...scheduled]);
}

export interface DecisionShadowStatus {
	enabled: boolean;
	backend: DecisionShadowBackend;
	surfaces: DecisionShadowSurface[];
	configured: boolean;
	line: string;
}

/** One `harness status` line: off, on (backend, surfaces), or on but unconfigured. */
export function describeDecisionShadowStatus(
	rules: GuardRulesConfig,
	resolveKey: (name: string) => string | undefined = resolveApiKey,
): DecisionShadowStatus {
	const backend = rules.decision_shadow?.backend ?? "clef_flash";
	const surfaces = (["guard_block", "secret_hit"] as const).filter((s) => activeShadowConfig(rules, s) !== null);
	if (rules.decision_shadow?.enabled !== true) {
		return { enabled: false, backend, surfaces: [], configured: false, line: "off" };
	}
	const resolved = resolveBackend(rules, resolveKey);
	const on = `${backend}, ${surfaces.join(" + ") || "no surfaces"}`;
	return resolved.ok
		? { enabled: true, backend, surfaces, configured: true, line: `on (${on})` }
		: { enabled: true, backend, surfaces, configured: false, line: `on (${on}) — backend unconfigured: ${resolved.reason}` };
}
