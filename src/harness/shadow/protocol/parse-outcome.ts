// ===========================================
// Shadow protocol v1 — strict parsers: verifier results and the outcome union
// ===========================================
// The outcome union is the daemon's whole read surface, so this parser carries
// the STRUCTURAL invariants a wire type alone cannot hold (memo §8.0):
//
//   • one completed shape per operation — `materialized` invents no process
//     termination, and an attestation without a verifier result is
//     unrepresentable (it is an undeclared field on every other shape).
//   • a completed outcome carries the claim, the policy, the measurement AND
//     the echoed freshness claim as four DISTINCT fields — the daemon must be
//     able to tell asserted from expected from measured.
//   • a `complete` run exited normally (a signal is never complete) and its
//     `diagnostics_total` agrees with its array; `introduced` therefore exists
//     exactly when both runs are complete.
//   • `binding_mismatch` carries the claim and a NON-EMPTY mismatch list;
//     every other reason is the other-unavailable shape.
//   • EVERY diagnostic array (`diagnostics`, `diagnostics_partial`,
//     `introduced`) is bounded by COUNT then by aggregate UTF-8 message BYTES,
//     and must already be in the memo's canonical order — file bytewise, line,
//     col (nulls FIRST at each), then category, code, message bytewise. An
//     unsorted array REJECTS; a consumer that re-sorts one changes its hash.
//   • every (reason, phase) pairing is checked against REASON_PHASES — an
//     undeclared pairing REJECTS, because one of the two fields is wrong and
//     nobody downstream can tell which.
//
// A parser proves SHAPE ONLY: it never verifies a signature, recomputes a
// digest, or compares a claim to disk. An accepted outcome is well-formed
// evidence, not trusted evidence.

import {
	checkArray,
	checkBoundedString,
	checkBoundedText,
	checkEnum,
	checkOpaqueId,
	checkRfc3339,
	checkSafeNonNegInt,
	checkSha256Hex,
	type Reason,
	utf8Bytes,
} from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import {
	arrayOf,
	boundedInt,
	checkFields,
	type FieldCheck,
	type FieldSpec,
	fieldsCheck,
	literal,
	nested,
	optional,
	type ShadowParseOutcome,
	parseRecord,
	pathArray,
	type RecordCheck,
} from "./parse-core-entries.js";
import {
	checkResolvedDependency,
	parseExpectedExecutionPolicy,
	parseShadowChangeSet,
	parseShadowExecutionBinding,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "./parse-core.js";
import { checkCanonicalPath } from "./path-rules.js";
import { bindingLeaves } from "./provenance.js";
import { isReasonLegalInPhase, SHADOW_PHASES, SHADOW_UNAVAILABLE_REASONS } from "./reason-phases.js";
import type { AuthoringAttestationV1 } from "./types-attestation.js";
import type { ExecutionBindingLeaf } from "./types-binding.js";
import type {
	CompleteShadowTscResultV1,
	DiagnosticV1,
	ShadowOutcome,
	ShadowPhase,
	ShadowUnavailableReason,
} from "./types-outcome.js";

const LIMITS = SHADOW_LIMITS_V1;
/** A process exit status is one byte. */
const MAX_EXIT_CODE = 255;
/** TS diagnostic codes are five digits; the bound is a wire sanity limit. */
const MAX_DIAGNOSTIC_CODE = 999_999;
/** A day — any longer and the deadline machinery, not the parser, is broken. */
const MAX_DURATION_MS = 86_400_000;
/** Bound on any argv-shaped list. Exported because `parse-records.ts` bounds
 *  `ShadowEnvV1.argv` and `env_allowlist` by the same policy — two constants
 *  for one number is the drift `duplicated_policy_constant` exists to catch. */
export const MAX_ARGV = 256;
/** A wire sanity limit on a 1-based line/column: no source file a compiler
 *  reported on has a billion of either. */
const MAX_POSITION = 1_000_000_000;

// ── shared combinators (also used by `parse-transport.ts`) ─────────────────

/** A field whose value is a whole record another parser already owns. The
 *  inner parser's clone is discarded — the OUTER `parseRecord` snapshot is the
 *  value — so this composes without minting two copies of one record. */
export function embedded<T>(parse: (raw: unknown) => ShadowParseOutcome<T>): FieldCheck {
	return (value, where) => {
		const outcome = parse(value);
		return outcome.ok ? null : `${where}: ${outcome.reason}`;
	};
}

/** An explicitly nullable field. `null` is a VALUE here (a diagnostic with no
 *  file); absence is `optional`, and the two are never interchangeable. */
export function nullable(check: FieldCheck): FieldCheck {
	return (value, where) => (value === null ? null : check(value, where));
}

/** An array of scalars, bounded BEFORE any per-item work. */
export function listOf(check: FieldCheck, max: number): FieldCheck {
	return (value, where) => {
		if (!Array.isArray(value)) return `${where} must be an array`;
		const bound = checkArray(value, where, max);
		if (bound !== null) return bound;
		for (let index = 0; index < value.length; index += 1) {
			const reason = check(value[index], `${where}[${index}]`);
			if (reason !== null) return reason;
		}
		return null;
	};
}

export function enumField(allowed: readonly string[]): FieldCheck {
	return (value, where) => checkEnum(value, allowed, where);
}

export const boundedText: FieldCheck = (value, where) => checkBoundedString(value, where);

// ── diagnostics and process terminations ───────────────────────────────────

/** A diagnostic position is 1-BASED: line 1, column 1 is the first character.
 *  Zero is therefore not a position — it is a producer that emitted an offset,
 *  or a default-initialized field, and either way the record lies about where
 *  the finding is. A diagnostic may legitimately have NO position at all
 *  (file/line/col null); what is refused is a PRESENT position of 0 or less. */
const checkPosition: FieldCheck = (value, where) => {
	const integer = checkSafeNonNegInt(value, where, MAX_POSITION);
	if (integer !== null) return integer;
	return value === 0 ? `${where} is 1-based; 0 is not a position` : null;
};

const DIAGNOSTIC_FIELDS: readonly FieldSpec[] = [
	["file", nullable(checkCanonicalPath)],
	["line", nullable(checkPosition)],
	["col", nullable(checkPosition)],
	["category", enumField(["error", "warning", "suggestion", "message"])],
	["code", boundedInt(MAX_DIAGNOSTIC_CODE)],
	["message", (value, where) => checkBoundedString(value, where, LIMITS.diagnostics_bytes)],
];

/** UTF-8 byte order, not UTF-16 code-unit order: `String` comparison orders a
 *  supplementary character before U+E000, and UTF-8 orders it after, so the two
 *  parties would disagree about a legal array. */
function compareBytes(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareNumbers(left: number, right: number): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

/** NULL FIRST — the memo's key. A missing position sorts before every present
 *  one, so a fileless diagnostic has exactly one legal home. */
function compareNullable<T>(left: T | null, right: T | null, compare: (a: T, b: T) => number): number {
	if (left === null) return right === null ? 0 : -1;
	if (right === null) return 1;
	return compare(left, right);
}

function compareDiagnostics(left: DiagnosticV1, right: DiagnosticV1): number {
	return (
		compareNullable(left.file, right.file, compareBytes) ||
		compareNullable(left.line, right.line, compareNumbers) ||
		compareNullable(left.col, right.col, compareNumbers) ||
		compareBytes(left.category, right.category) ||
		compareNumbers(left.code, right.code) ||
		compareBytes(left.message, right.message)
	);
}

/** The AGGREGATE budget. A per-message bound alone lets 10 000 legal messages
 *  carry 50 GB, and a CHARACTER count under-measures every non-ASCII message,
 *  so the walk sums UTF-8 bytes and stops at the cap. */
function diagnosticsByteFailure(items: readonly DiagnosticV1[], where: string): Reason {
	let total = 0;
	for (const item of items) {
		total += utf8Bytes(item.message);
		if (total > LIMITS.diagnostics_bytes) return `${where} exceeds ${LIMITS.diagnostics_bytes} diagnostic message bytes`;
	}
	return null;
}

/** Order is REFUSED, never repaired: a consumer that re-sorts an array the
 *  producer hashed in a different order computes a different `result_hash`,
 *  and neither party can tell which of them is wrong. Equal keys are legal
 *  (the memo accepts duplicate diagnostics), so the rule is non-decreasing. */
function diagnosticsOrderFailure(items: readonly DiagnosticV1[], where: string): Reason {
	let previous: DiagnosticV1 | undefined;
	let index = 0;
	for (const current of items) {
		if (previous !== undefined && compareDiagnostics(previous, current) > 0) {
			return `${where}[${index}] breaks the canonical order (file, line, col, category, code, message — nulls first)`;
		}
		previous = current;
		index += 1;
	}
	return null;
}

/** Count FIRST (a huge array is refused before it is measured), then per-item
 *  shape, then the aggregate byte budget, then the canonical order. */
const diagnosticArray: FieldCheck = (value, where) => {
	const shape = arrayOf(fieldsCheck(DIAGNOSTIC_FIELDS), LIMITS.diagnostics_count)(value, where);
	if (shape !== null) return shape;
	// SAFETY: every item just passed `DIAGNOSTIC_FIELDS` with unknown keys refused.
	const items = value as readonly DiagnosticV1[];
	return diagnosticsByteFailure(items, where) ?? diagnosticsOrderFailure(items, where);
};

const EXITED_FIELDS: readonly FieldSpec[] = [
	["kind", literal("exited")],
	["code", boundedInt(MAX_EXIT_CODE)],
];
const SIGNALED_FIELDS: readonly FieldSpec[] = [
	["kind", literal("signaled")],
	["signal", boundedText],
];

const checkTermination: RecordCheck = (value, where) => {
	if (value.kind === "exited") return checkFields(value, where, EXITED_FIELDS);
	if (value.kind === "signaled") return checkFields(value, where, SIGNALED_FIELDS);
	return `${where}.kind must be one of: exited, signaled`;
};

// ── tsc runs (memo §4.2) ───────────────────────────────────────────────────
// A `complete` run declares a NORMAL exit — a signalled process never produced
// a complete diagnostic list — and its count agrees with its array, so a
// truncated list must travel as `output_truncated` instead.

/** The refusal names the INVARIANT, not the missing key: a reader who sees
 *  "unknown field: signal" learns nothing about why a signal is illegal here. */
const checkNormalExit: RecordCheck = (value, where) =>
	value.kind === "signaled"
		? `${where}.kind must be "exited" — a signalled process never produced a complete run`
		: checkFields(value, where, EXITED_FIELDS);

const COMPLETE_RUN_FIELDS: readonly FieldSpec[] = [
	["status", literal("complete")],
	["termination", nested(checkNormalExit)],
	["diagnostics_total", boundedInt(LIMITS.diagnostics_count)],
	["diagnostics", diagnosticArray],
];

const checkCompleteRun: RecordCheck = (value, where) => {
	const shape = checkFields(value, where, COMPLETE_RUN_FIELDS);
	if (shape !== null) return shape;
	// SAFETY: `diagnosticArray` accepted the field, so it is an array.
	const diagnostics = value.diagnostics as readonly unknown[];
	return value.diagnostics_total === diagnostics.length
		? null
		: `${where}.diagnostics_total must equal diagnostics.length (${diagnostics.length})`;
};

const INCOMPLETE_RUN_FIELDS: readonly FieldSpec[] = [
	["status", enumField(["crashed", "timeout", "output_truncated"])],
	["termination", optional(nested(checkTermination))],
	["diagnostics_partial", diagnosticArray],
];

const checkTscRun: RecordCheck = (value, where) =>
	value.status === "complete" ? checkCompleteRun(value, where) : checkFields(value, where, INCOMPLETE_RUN_FIELDS);

// ── verifier results ───────────────────────────────────────────────────────

const COMPILER_FIELDS: readonly FieldSpec[] = [
	["path", boundedText],
	["sha256", checkSha256Hex],
	["version", boundedText],
	["image_digest", boundedText],
];
const INVOCATION_FIELDS: readonly FieldSpec[] = [
	["argv", listOf(boundedText, MAX_ARGV)],
	["cwd", boundedText],
	["locale", literal("en")],
	["pretty", literal(false)],
];
const RESULT_COMMON_FIELDS: readonly FieldSpec[] = [
	["result_schema", literal("shadow-tsc-result-v1")],
	["mode", literal("introduced-only")],
	["compiler", nested(fieldsCheck(COMPILER_FIELDS))],
	["invocation", nested(fieldsCheck(INVOCATION_FIELDS))],
];

/** A run that COMPLETED resolved its dependencies, so `mode: "none"` is not a
 *  representable dependency binding on the complete result. */
const checkInstalledDependency: RecordCheck = (value, where) =>
	value.mode === "none"
		? `${where}.mode must not be "none" — a completed verifier run resolved its dependencies`
		: checkResolvedDependency(value, where);

export const COMPLETE_RESULT_FIELDS: readonly FieldSpec[] = [
	...RESULT_COMMON_FIELDS,
	["dependencies", nested(checkInstalledDependency)],
	["pre", nested(checkCompleteRun)],
	["post", nested(checkCompleteRun)],
	["introduced", diagnosticArray],
];
const INCOMPLETE_RESULT_FIELDS: readonly FieldSpec[] = [
	...RESULT_COMMON_FIELDS,
	["dependencies", nested(checkResolvedDependency)],
	["pre", nested(checkTscRun)],
	["post", optional(nested(checkTscRun))],
	["incomplete", literal(true)],
];

export function parseCompleteTscResult(raw: unknown): ShadowParseOutcome<CompleteShadowTscResultV1> {
	return parseRecord(raw, "verifier_result", fieldsCheck(COMPLETE_RESULT_FIELDS));
}

// ── the authoring attestation ──────────────────────────────────────────────
// It signs EXECUTION FACTS and the ECHOED freshness claim; it never attests
// that the claim matched local disk (memo I4).

const ATTESTATION_PAYLOAD_FIELDS: readonly FieldSpec[] = [
	["scope", literal("authoring")],
	["tenant", checkOpaqueId],
	["project", checkOpaqueId],
	["repository_id", checkOpaqueId],
	["session_id", checkOpaqueId],
	["measured_execution", embedded(parseShadowExecutionBinding)],
	["freshness_claim_echo", embedded(parseShadowFreshnessBinding)],
	["changeset", embedded(parseShadowChangeSet)],
	["request_nonce", checkOpaqueId],
	["command_hash", checkSha256Hex],
	["command_display", boundedText],
	["verifier_kind", literal("tsc")],
	["ruleset_hash", checkSha256Hex],
	["key_purpose", literal("shadow-authoring")],
];
const SIGNED_FIELDS: readonly FieldSpec[] = [
	["domain", literal("interlinked-shadow-authoring")],
	["protocol_version", literal(1)],
	["key_id", boundedText],
	["occurred_at", checkRfc3339],
	["result_hash", checkSha256Hex],
	["payload", nested(fieldsCheck(ATTESTATION_PAYLOAD_FIELDS))],
];
export const ATTESTATION_FIELDS: readonly FieldSpec[] = [
	["signed", nested(fieldsCheck(SIGNED_FIELDS))],
	["signature", boundedText],
];
const attestationField = nested(fieldsCheck(ATTESTATION_FIELDS));

export function parseAuthoringAttestation(raw: unknown): ShadowParseOutcome<AuthoringAttestationV1> {
	return parseRecord(raw, "attestation", fieldsCheck(ATTESTATION_FIELDS));
}

// ── completed outcomes ─────────────────────────────────────────────────────
// Four distinct held values travel side by side: what the daemon ASSERTED,
// what policy EXPECTED, what the materializer MEASURED, and the freshness
// claim ECHOED back for the daemon's own local check.

const OUTCOME_BASE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["status", literal("completed")],
	["request_id", checkOpaqueId],
	["bundle_id", checkOpaqueId],
	["execution_claim", embedded(parseShadowExecutionClaim)],
	["expected_execution", embedded(parseExpectedExecutionPolicy)],
	["measured_execution", embedded(parseShadowExecutionBinding)],
	["freshness_claim", embedded(parseShadowFreshnessBinding)],
	["duration_ms", boundedInt(MAX_DURATION_MS)],
];
const verifierField = nested(fieldsCheck(COMPLETE_RESULT_FIELDS));
const stdioHead: FieldCheck = (value, where) => checkBoundedText(value, where, LIMITS.stdio_head_bytes);
const WORKSPACE_DIFF_FIELDS: readonly FieldSpec[] = [
	["added", pathArray(LIMITS.entries)],
	["modified", pathArray(LIMITS.entries)],
	["deleted", pathArray(LIMITS.entries)],
	["bytes_changed", boundedInt(LIMITS.working_tree_bytes)],
];

export const COMPLETED_SHAPES: Record<string, readonly FieldSpec[]> = {
	materialized: [...OUTCOME_BASE_FIELDS, ["kind", literal("materialized")]],
	verified: [...OUTCOME_BASE_FIELDS, ["kind", literal("verified")], ["verifier", verifierField]],
	attested: [
		...OUTCOME_BASE_FIELDS,
		["kind", literal("attested")],
		["verifier", verifierField],
		["attestation", attestationField],
	],
	rehearsed: [
		...OUTCOME_BASE_FIELDS,
		["kind", literal("rehearsed")],
		["termination", nested(checkTermination)],
		["workspace_diff", nested(fieldsCheck(WORKSPACE_DIFF_FIELDS))],
		["stdout_head", stdioHead],
		["stderr_head", stdioHead],
		["divergence_risk", enumField(["low", "medium", "high"])],
	],
};

const checkCompletedOutcome: RecordCheck = (value, where) => {
	const fields = typeof value.kind === "string" ? COMPLETED_SHAPES[value.kind] : undefined;
	if (fields === undefined) {
		return `${where}.kind must be one of: ${Object.keys(COMPLETED_SHAPES).sort().join(", ")}`;
	}
	return checkFields(value, where, fields);
};

// ── unavailable outcomes ───────────────────────────────────────────────────

/** The leaves a measurement can disagree about — DERIVED from the binding
 *  type's own leaf census (`bindingLeaves()`), not restated here. A field
 *  added to `ShadowExecutionBinding` therefore becomes an accepted mismatch
 *  target automatically, and a freshness leaf can never appear: freshness is
 *  daemon-local and its census is a separate function. */
const EXECUTION_BINDING_LEAVES: readonly ExecutionBindingLeaf[] = bindingLeaves();

/** Canonical-JSON values: any field type is representable, bounded by the
 *  path limit — every comparable leaf is a hash, an id, a path or a scalar. */
const canonicalJson: FieldCheck = (value, where) => checkBoundedString(value, where, LIMITS.path_bytes);
const MISMATCH_COMMON: readonly FieldSpec[] = [
	["field", enumField(EXECUTION_BINDING_LEAVES)],
	["comparison", enumField(["claim_vs_measurement", "policy_vs_measurement", "authority_vs_measurement", "cache_vs_measurement"])],
	["expected", canonicalJson],
];
const MISMATCH_MEASURED_FIELDS: readonly FieldSpec[] = [...MISMATCH_COMMON, ["measured", canonicalJson]];
const MISMATCH_ABSENT_FIELDS: readonly FieldSpec[] = [
	...MISMATCH_COMMON,
	["unavailable_reason", enumField(["not_reached", "not_provisioned", "not_applicable"])],
];

/** No empty-string sentinel: an absent measurement states WHY it is absent,
 *  and the two shapes are exclusive (`measured` is undeclared on the second,
 *  so carrying both rejects as an unknown field). */
const checkMismatch: RecordCheck = (value, where) =>
	"unavailable_reason" in value
		? checkFields(value, where, MISMATCH_ABSENT_FIELDS)
		: checkFields(value, where, MISMATCH_MEASURED_FIELDS);

const UNAVAILABLE_BASE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["status", literal("unavailable")],
	["request_id", checkOpaqueId],
	["phase", enumField(SHADOW_PHASES)],
	["detail", boundedText],
	["duration_ms", boundedInt(MAX_DURATION_MS)],
];
export const BINDING_MISMATCH_FIELDS: readonly FieldSpec[] = [
	...UNAVAILABLE_BASE_FIELDS,
	["reason", literal("binding_mismatch")],
	["execution_claim", embedded(parseShadowExecutionClaim)],
	["mismatches", arrayOf(checkMismatch, LIMITS.entries)],
];
const OTHER_REASONS: readonly string[] = SHADOW_UNAVAILABLE_REASONS.filter((reason) => reason !== "binding_mismatch");
export const OTHER_UNAVAILABLE_FIELDS: readonly FieldSpec[] = [
	...UNAVAILABLE_BASE_FIELDS,
	["reason", enumField(OTHER_REASONS)],
	["execution_claim", optional(embedded(parseShadowExecutionClaim))],
	["verifier_result", optional(nested(fieldsCheck(INCOMPLETE_RESULT_FIELDS)))],
];

/** `binding_mismatch` without a mismatch is a verdict with no evidence. */
const checkBindingMismatch: RecordCheck = (value, where) => {
	const shape = checkFields(value, where, BINDING_MISMATCH_FIELDS);
	if (shape !== null) return shape;
	// SAFETY: `arrayOf` accepted the field, so it is an array.
	const mismatches = value.mismatches as readonly unknown[];
	return mismatches.length > 0 ? null : `${where}.mismatches must not be empty`;
};

const checkUnavailableOutcome: RecordCheck = (value, where) => {
	const shape =
		value.reason === "binding_mismatch"
			? checkBindingMismatch(value, where)
			: checkFields(value, where, OTHER_UNAVAILABLE_FIELDS);
	if (shape !== null) return shape;
	// SAFETY: both fields were just validated as members of their own enums.
	const reason = value.reason as ShadowUnavailableReason;
	// SAFETY: `phase` passed `enumField(SHADOW_PHASES)` immediately above.
	const phase = value.phase as ShadowPhase;
	return isReasonLegalInPhase(reason, phase) ? null : `${where}.reason "${reason}" is not legal in phase "${phase}"`;
};

const checkShadowOutcome: RecordCheck = (value, where) => {
	if (value.status === "completed") return checkCompletedOutcome(value, where);
	if (value.status === "unavailable") return checkUnavailableOutcome(value, where);
	return `${where}.status must be one of: completed, unavailable`;
};

export function parseShadowOutcome(raw: unknown): ShadowParseOutcome<ShadowOutcome> {
	return parseRecord(raw, "outcome", checkShadowOutcome);
}
