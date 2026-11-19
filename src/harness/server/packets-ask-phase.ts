// ===========================================
// PreToolUse — instruction-packet cosign phase (stage 4)
// ===========================================
// A packet at `cosign` may raise a deterministic ALLOW to ASK before the call
// runs (packets/evaluator.ts collectPacketAsk). The §3 decision table on this
// side: a local block or ask is left byte-identical and the evaluator is not
// even consulted; an allow becomes ask only on an eligible cosign judgment; a
// failed, slow or empty evaluation leaves allow standing. With no cosign
// packet the evaluator is not called (the PostToolUse shadow path still runs).

import { withPacketDeliveryTimeout } from "./packet-delivery-timeout.js";
import { collectPacketAsk } from "../packets/evaluator.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";

const PACKET_ASK_TIMEOUT_MS = 2_500;

export interface PacketAskPhaseDeps {
	collect?: (event: HarnessEvent, rules: GuardRulesConfig, local: HarnessDecision) => Promise<HarnessDecision>;
	timeoutMs?: number;
}

/** The decision after the cosign packets had their say; never throws, never loosens. */
export async function applyPacketAsk(event: HarnessEvent, rules: GuardRulesConfig, local: HarnessDecision, deps: PacketAskPhaseDeps = {}): Promise<HarnessDecision> {
	if (event.dry_run === true || event.hook_event !== "PreToolUse" || local.decision !== "allow") return local;
	const collect = deps.collect ?? ((e, r, l) => collectPacketAsk(e, r, l));
	try {
		const decision = await withPacketDeliveryTimeout(collect(event, rules, local), deps.timeoutMs ?? PACKET_ASK_TIMEOUT_MS, local);
		// Tighten only: whatever came back, a non-ask answer leaves the local allow as it was.
		return decision.decision === "ask" ? decision : local;
	} catch {
		return local;
	}
}
