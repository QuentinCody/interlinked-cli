// ===========================================
// Shadow protocol v1 — phases and the closed reason map
// ===========================================
// Every unavailable reason declares the phases it may occur in. The map is
// what keeps an outcome honest: a `projection` failure reported from `fetch`
// is a parser rejection, not a warning, because one of the two fields is
// wrong and nobody downstream can tell which.
//
// `timeout` and `cancelled` are legal in every REMOTE phase (the daemon can
// give up at any of them); `limits` is legal wherever bounded output is
// produced, which includes `admit` (a request too large to accept) and
// `verify` (diagnostics past the cap).

import type { ShadowPhase, ShadowUnavailableReason } from "./types-outcome.js";

export const SHADOW_PHASES: readonly ShadowPhase[] = ["admit", "fetch", "materialize", "project", "provision", "verify"];
/** Every phase except `admit` — admission happens at the broker, before any
 *  remote work exists to time out or cancel. */
export const REMOTE_PHASES: readonly ShadowPhase[] = ["fetch", "materialize", "project", "provision", "verify"];

export const SHADOW_UNAVAILABLE_REASONS: readonly ShadowUnavailableReason[] = [
	"mirror_lag",
	"mirror_unavailable",
	"mirror_integrity",
	"invalid_tree",
	"binding_mismatch",
	"projection",
	"symlink_escape",
	"dependency_source",
	"provisioning",
	"execution_failed",
	"secrets",
	"scanner_unavailable",
	"limits",
	"unsupported_capability",
	"verifier_incomplete",
	"timeout",
	"cancelled",
	"broker_unreachable",
	"classifier_disagreement",
	"idempotency_conflict",
	"bundle_expired",
];

export const REASON_PHASES = {
	mirror_lag: ["fetch"],
	mirror_unavailable: ["fetch"],
	mirror_integrity: ["fetch"],
	invalid_tree: ["materialize", "provision"],
	binding_mismatch: ["materialize", "project", "provision", "verify"],
	projection: ["project"],
	symlink_escape: ["materialize", "project", "provision"],
	dependency_source: ["provision"],
	provisioning: ["provision"],
	execution_failed: ["verify"],
	secrets: ["admit"],
	scanner_unavailable: ["admit"],
	limits: ["admit", "fetch", "materialize", "project", "provision", "verify"],
	unsupported_capability: ["admit"],
	verifier_incomplete: ["verify"],
	timeout: REMOTE_PHASES,
	cancelled: REMOTE_PHASES,
	broker_unreachable: ["admit"],
	classifier_disagreement: ["admit"],
	idempotency_conflict: ["admit"],
	bundle_expired: ["admit"],
} as const satisfies Record<ShadowUnavailableReason, readonly ShadowPhase[]>;

export function isReasonLegalInPhase(reason: ShadowUnavailableReason, phase: ShadowPhase): boolean {
	const phases: readonly ShadowPhase[] = REASON_PHASES[reason];
	return phases.includes(phase);
}
