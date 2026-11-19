// ===========================================
// PostToolUse — instruction-packet delivery phase (stage 2)
// ===========================================
// Appends `[interlinked:packet]` warnings for packets at warn/cosign whose
// judgment crossed tau (packets/evaluator.ts collectPacketWarnings). The §3
// decision table on this side is simple: the decision is never changed — a
// non-allow decision from an earlier phase is left byte-identical, a delivered
// warning rides an allow, and a failed, slow or empty evaluation changes
// nothing. When no live packet exists the evaluator runs in shadow (fire and
// forget) and this phase returns at once. The await is bounded: a Jev round
// trip is ~200 ms; past `timeoutMs` the judgment still lands in the ledger but
// is not delivered.

import { withPacketDeliveryTimeout } from "./packet-delivery-timeout.js";
import { join } from "node:path";
import { packetRoot } from "../packets/source-path.js";
import { getAdapter } from "../adapters/index.js";
import { collectPacketWarnings } from "../packets/evaluator.js";
import type { FallbackEntry } from "../packets/fallback.js";
import { deliveredIds, fallbackIdsIn } from "../packets/fallback-ledger.js";
import { hasRelease, startFallbackEntries } from "../packets/fallback-start.js";
import { runnerIdOf } from "../packets/support.js";
import { drainWindowWarnings } from "../packets/trajectory-ledger.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";

const PACKET_DELIVERY_TIMEOUT_MS = 2_500;

export interface PacketPhaseDeps {
	collect?: (event: HarnessEvent, rules: GuardRulesConfig) => Promise<string[]>;
	/** Window warnings queued by the trajectory layer for this session (drained once). */
	drain?: (cwd: string, sessionId: string) => string[];
	/** Whether any installed post-tool event of this runner reaches the model (adapter capability `model_context`). */
	postVisible?: (agentSource: string) => boolean;
	/** Released instruction text for packets not live here (design §9). */
	startFallback?: (cwd: string, rules: GuardRulesConfig, agentSource: string) => FallbackEntry[];
	/** Released packet ids this session already received (recorded by the hook after encoding). */
	delivered?: (cwd: string, sessionId: string) => ReadonlySet<string>;
	/** Clock for the proposal lease (tests). */
	now?: () => number;
	timeoutMs?: number;
}

function reachesModel(agentSource: string, phase: "session-start" | "post-tool"): boolean {
	const events = getAdapter(runnerIdOf(agentSource))?.capabilities.events ?? [];
	return events.some((e) => e.install && e.phase === phase && e.model_context);
}

/** True when the runner's installed SessionStart carries model-visible context; unknown runners count as not. */
export function sessionStartReachesModel(agentSource: string): boolean {
	return reachesModel(agentSource, "session-start");
}

/** True when some installed post-tool event of the runner carries model-visible context (Windsurf, Antigravity
 *  and Crush have none: proposing there only repeats the text to a terminal every call). */
export function postToolReachesModel(agentSource: string): boolean {
	return reachesModel(agentSource, "post-tool");
}

/** Released text whose packet is not live here, by the static oracle (config, key, sources, status, binding,
 *  support, consent) and the daemon's runtime state — proposed on EVERY PostToolUse that has a release: the
 *  first call of a runner whose SessionStart never reaches the model (Copilot, Gemini, Cursor, OpenCode, Pi), and
 *  any later call after a packet goes non-live mid-session. What was already received is filtered centrally. */
function pendingReleasedFallback(root: string, event: HarnessEvent, rules: GuardRulesConfig, deps: PacketPhaseDeps): string[] {
	if (!(deps.postVisible ?? postToolReachesModel)(event.agent_source)) return []; // never reaches the model: skip the load
	if (!deps.startFallback && !hasRelease(root)) return [];
	return (deps.startFallback ?? startFallbackEntries)(root, rules, event.agent_source).map((e) => e.line);
}

/** A proposed fallback line waits this long before it is proposed again in the same session: parallel tool calls
 *  each reach the daemon before any hook has recorded a receipt (break R3, P2-a), and an invisible event delays
 *  the next proposal by at most this much. */
export const PROPOSAL_LEASE_MS = 20_000;
const leases = new Map<string, number>();

/** Test seam: forget the proposal leases (per daemon process). */
export function resetPacketPhaseState(): void {
	leases.clear();
}

/** ONE filter for every fallback line, whichever path proposed it (static, outage, window queue): drop them all on
 *  a runner no post-tool output reaches (break R3, P2-b), drop ids the session already received (one ledger read),
 *  drop ids proposed within the lease, keep the first line per id. Non-fallback lines pass untouched. */
function deliverable(lines: readonly string[], root: string, event: HarnessEvent, deps: PacketPhaseDeps): string[] {
	const ids = lines.map((line) => fallbackIdsIn([line])[0]);
	if (ids.every((id) => id === undefined)) return [...lines];
	const visible = (deps.postVisible ?? postToolReachesModel)(event.agent_source);
	const received = visible ? (deps.delivered ?? ((c: string, s: string) => deliveredIds(join(c, ".interlinked"), s)))(root, event.session_id) : new Set<string>();
	const now = (deps.now ?? Date.now)();
	if (leases.size > 4_096) for (const [k, until] of leases) if (until <= now) leases.delete(k);
	return lines.filter((_, i) => {
		const id = ids[i];
		if (id === undefined) return true;
		const key = `${root}\u0000${event.session_id}\u0000${id}`;
		if (!visible || received.has(id) || (leases.get(key) ?? 0) > now) return false;
		leases.set(key, now + PROPOSAL_LEASE_MS);
		return true;
	});
}

/** Append delivered packet warnings to an allow decision; never throws, never changes the decision. */
export async function appendPacketWarnings(event: HarnessEvent, rules: GuardRulesConfig, decision: HarnessDecision, deps: PacketPhaseDeps = {}): Promise<void> {
	if (event.dry_run === true || decision.decision !== "allow") return;
	const collect = deps.collect ?? collectPacketWarnings;
	let lines: string[];
	try {
		lines = await withPacketDeliveryTimeout(collect(event, rules), deps.timeoutMs ?? PACKET_DELIVERY_TIMEOUT_MS, []);
	} catch {
		// A failing evaluator is exactly when the released words are needed: fall through to the fallback.
		lines = [];
	}
	const root = packetRoot(event);
	// Trajectory findings from the session's last Stop/SessionEnd ride this allow too (Stop warnings reach no agent).
	const queued = (deps.drain ?? drainWindowWarnings)(root, event.session_id);
	let pending: string[];
	try {
		pending = pendingReleasedFallback(root, event, rules, deps);
	} catch {
		pending = [];
	}
	const all = deliverable([...lines, ...queued, ...pending], root, event, deps);
	if (all.length === 0) return;
	// Released words go FIRST: a runner that keeps only the head of the context (Codex, 2,500 chars) keeps them.
	const fallbacks = all.filter((line) => fallbackIdsIn([line]).length > 0);
	const others = all.filter((line) => fallbackIdsIn([line]).length === 0);
	decision.warnings = [...fallbacks, ...(decision.warnings ?? []), ...others];
}
