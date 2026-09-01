// ===========================================
// Hook cold-path daemon self-heal — the PROACTIVE (Stop-phase) trigger
// ===========================================
// `attemptDaemonSelfHeal` (hook-entry-daemon-gate.ts) is REACTIVE: it only
// runs as a side effect of a blocked PreToolUse call. Root-caused 2026-08-22:
// a daemon hard-aborted mid-session and stayed dead for 22 minutes because the
// agent's next turn was pure thinking with zero tool calls — nothing reached
// the PreToolUse cold path to trigger it. Stop fires at the end of EVERY
// turn, tool calls or not, so it is the natural proactive trigger: a daemon
// dead for longer than a bounded window gets exactly one recovery attempt
// through the SAME startup-lock/backoff machinery the reactive gate already
// uses (`attemptDaemonSelfHeal`) — no second protocol.
//
// Deliberately not wired into the pre-tool block path: this function never
// blocks anything. A Stop event has nothing to refuse — it just gets a free
// chance to notice the daemon is gone and start bringing it back before the
// next tool call needs it.

import { join } from "node:path";
import { readRecentDaemonEvents } from "./harness/daemon-ledger.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import {
	attemptDaemonSelfHeal,
	daemonCutOut,
	discoverDaemonPid,
	resolveGateRoot,
	type SelfHealDeps,
	type SelfHealResult,
} from "./hook-entry-daemon-gate.js";
import { readGuardDisable } from "./lib/guard-state.js";

const STOP_PHASES = new Set(["stop", "subagent-stop"]);

/** Only self-heal proactively once an outage has held for at least this long.
 *  A graceful handover's successor binds within ~1-2s; Stop can legitimately
 *  fire during that ordinary gap, and a premature proactive spawn there would
 *  just contend uselessly for the startup mutex the real successor already
 *  holds. Well above that, well below "a whole turn goes by unrevived". */
const STOP_SELF_HEAL_MIN_DOWN_MS = 60_000;

/** Injectable clock/ledger seam for tests; production reads the real ledger. */
export interface StopSelfHealClock {
	now?: () => number;
	/** Epoch ms of the most recent daemon-ledger event for `root` (any kind,
	 *  any pid) — the same "when did anything last happen" signal the block
	 *  message's context line already reads. 0 when the ledger is empty. */
	lastLedgerEventAt?: (root: string) => number;
}

function defaultLastLedgerEventAt(root: string): number {
	const events = readRecentDaemonEvents(root);
	return events.at(-1)?.at ?? 0;
}

/**
 * Proactive self-heal for Stop/SubagentStop events. Returns `"not-applicable"`
 * for every case that is not a genuine, long-held cutout (wrong phase, no
 * repo, disabled, healthy, or too recent to distinguish from an ordinary
 * handover) — otherwise delegates to {@link attemptDaemonSelfHeal}, which is
 * itself mutex- and backoff-guarded, so calling this once per turn is safe
 * even when the outage persists across many consecutive Stops.
 */
export function attemptSelfHealOnStop(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: SelfHealDeps = {},
	clock: StopSelfHealClock = {},
): SelfHealResult | "not-applicable" {
	if (!STOP_PHASES.has(event.phase)) return "not-applicable";
	const root = resolveGateRoot(event, cwd);
	if (!root) return "not-applicable";
	if (readGuardDisable(join(root, ".interlinked"))) return "not-applicable";
	const dir = join(root, ".interlinked");
	const pid = discoverDaemonPid(dir);
	if (!daemonCutOut(dir, pid)) return "not-applicable";
	const now = (clock.now ?? Date.now)();
	const lastAt = (clock.lastLedgerEventAt ?? defaultLastLedgerEventAt)(root);
	if (now - lastAt < STOP_SELF_HEAL_MIN_DOWN_MS) return "not-applicable";
	return attemptDaemonSelfHeal(cwd ?? event.context?.cwd, env, deps);
}
