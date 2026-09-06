// Malformed corpus, part 3 — the outcome union (memo §8.1 exit gate: unknown
// field, unknown version, out-of-range integer, empty-string brand, and the
// named "reason/phase mismatch" case).
//
// The structural invariants under test are the ones a type alone cannot hold
// at a wire boundary: a complete run never terminated by a signal, a
// diagnostics count that agrees with its array, an attestation that cannot
// exist without a verifier result, and a non-empty mismatch list.

import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import type { ShadowParseOutcome } from "./parse-core-entries.js";
import { parseAuthoringAttestation, parseCompleteTscResult, parseShadowOutcome } from "./parse-outcome.js";
import { REASON_PHASES } from "./reason-phases.js";
import type { ShadowPhase, ShadowUnavailableReason } from "./types-outcome.js";

const HEX = "a".repeat(64);
const SHA = "b".repeat(40);
const WHEN = "2026-09-03T12:00:00Z";

type Obj = Record<string, unknown>;

function accepted<T>(outcome: ShadowParseOutcome<T>): T {
	if (!outcome.ok) throw new Error(`expected acceptance, got rejection: ${outcome.reason}`);
	return outcome.value;
}

function reasonOf(outcome: ShadowParseOutcome<unknown>): string {
	return outcome.ok ? "<accepted>" : outcome.reason;
}

// ── fixtures ───────────────────────────────────────────────────────────────

const mirror = (): Obj => ({
	key: { repository_id: "repo_01", session_id: "sess_01", kind: "synthetic_full_tree" },
	version: 3,
});

const claim = (): Obj => ({
	mirror: mirror(),
	base_ref: SHA,
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: HEX,
	overlay_bytes_hash: HEX,
	pre_tree_hash: HEX,
	post_image_set_hash: HEX,
	post_tree_hash: HEX,
	dependencies: { mode: "npm-v1", input_hash: HEX },
});

const resolved = (): Obj => ({
	mode: "npm-v1",
	source: "fresh",
	input_hash: HEX,
	tree_algo: "shadow-dependency-tree-v1",
	tree_hash: HEX,
});

const measured = (): Obj => ({ ...claim(), dependencies: resolved(), env_digest: HEX, exec_config_hash: HEX });

const policy = (): Obj => ({
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: HEX,
	env_digest: HEX,
	exec_config_hash: HEX,
	broker_scanner_policy_digest: HEX,
	deadline_at: WHEN,
});

const freshness = (): Obj => ({
	base_local_head: SHA,
	local_head: SHA,
	input_hash: HEX,
	local_pre_tree_hash: HEX,
	local_overlay_manifest_hash: HEX,
	local_post_image_set_hash: HEX,
});

const changeset = (): Obj => ({
	schema_version: 1,
	pre_tree_hash: HEX,
	post_image_set_hash: HEX,
	touched_paths: ["src/a.ts"],
});

const diagnostic = (): Obj => ({
	file: "src/a.ts",
	line: 12,
	col: 3,
	category: "error",
	code: 2322,
	message: "Type 'string' is not assignable to type 'number'.",
});

const completeRun = (diagnostics: readonly Obj[] = []): Obj => ({
	status: "complete",
	termination: { kind: "exited", code: 0 },
	diagnostics_total: diagnostics.length,
	diagnostics,
});

const compiler = (): Obj => ({ path: "node_modules/.bin/tsc", sha256: HEX, version: "5.9.2", image_digest: "sha256:cafe" });

const invocation = (): Obj => ({ argv: ["--noEmit"], cwd: "/w", locale: "en", pretty: false });

const completeVerifier = (): Obj => ({
	result_schema: "shadow-tsc-result-v1",
	mode: "introduced-only",
	compiler: compiler(),
	invocation: invocation(),
	dependencies: resolved(),
	pre: completeRun(),
	post: completeRun([diagnostic()]),
	introduced: [diagnostic()],
});

const incompleteVerifier = (): Obj => ({
	result_schema: "shadow-tsc-result-v1",
	mode: "introduced-only",
	compiler: compiler(),
	invocation: invocation(),
	dependencies: { mode: "none" },
	pre: { status: "timeout", diagnostics_partial: [] },
	incomplete: true,
});

const attestation = (): Obj => ({
	signed: {
		domain: "interlinked-shadow-authoring",
		protocol_version: 1,
		key_id: "key-2026-09",
		occurred_at: WHEN,
		result_hash: HEX,
		payload: {
			scope: "authoring",
			tenant: "tenant_01",
			project: "proj_01",
			repository_id: "repo_01",
			session_id: "sess_01",
			measured_execution: measured(),
			freshness_claim_echo: freshness(),
			changeset: changeset(),
			request_nonce: "nonce_01",
			command_hash: HEX,
			command_display: "tsc --noEmit",
			verifier_kind: "tsc",
			ruleset_hash: HEX,
			key_purpose: "shadow-authoring",
		},
	},
	signature: "ZmFrZS1zaWc",
});

const completedBase = (): Obj => ({
	schema_version: 1,
	status: "completed",
	request_id: "req_01",
	bundle_id: "bundle_01",
	execution_claim: claim(),
	expected_execution: policy(),
	measured_execution: measured(),
	freshness_claim: freshness(),
	duration_ms: 4200,
});

const materialized = (): Obj => ({ ...completedBase(), kind: "materialized" });
const verified = (): Obj => ({ ...completedBase(), kind: "verified", verifier: completeVerifier() });
const attested = (): Obj => ({ ...verified(), kind: "attested", attestation: attestation() });

const rehearsed = (): Obj => ({
	...completedBase(),
	kind: "rehearsed",
	termination: { kind: "signaled", signal: "SIGKILL" },
	workspace_diff: { added: ["src/new.ts"], modified: [], deleted: [], bytes_changed: 120 },
	stdout_head: "",
	stderr_head: "boom",
	divergence_risk: "medium",
});

const unavailableBase = (): Obj => ({
	schema_version: 1,
	status: "unavailable",
	request_id: "req_01",
	phase: "fetch",
	detail: "mirror is behind the claimed version",
	duration_ms: 12,
});

const mismatch = (): Obj => ({
	field: "post_tree_hash",
	comparison: "claim_vs_measurement",
	expected: `"${HEX}"`,
	measured: `"${"c".repeat(64)}"`,
});

const bindingMismatch = (): Obj => ({
	...unavailableBase(),
	phase: "materialize",
	reason: "binding_mismatch",
	execution_claim: claim(),
	mismatches: [mismatch()],
});

const otherUnavailable = (): Obj => ({ ...unavailableBase(), reason: "mirror_lag" });

// ── positive ───────────────────────────────────────────────────────────────

describe("parse-outcome — positive (must accept)", () => {
	it("P1: accepts a materialized outcome and returns a frozen own-data copy", () => {
		const raw = materialized();
		const value = accepted(parseShadowOutcome(raw));
		expect(value.status).toBe("completed");
		expect(Object.isFrozen(value)).toBe(true);
		raw.duration_ms = 9;
		expect(value.duration_ms).toBe(4200);
	});

	it("P2: accepts a verified outcome carrying a complete verifier result", () => {
		const value = accepted(parseShadowOutcome(verified()));
		expect(value.status).toBe("completed");
		expect(accepted(parseCompleteTscResult(completeVerifier())).introduced).toHaveLength(1);
	});

	it("P3: accepts an attested outcome — verifier result AND attestation together", () => {
		expect(parseShadowOutcome(attested()).ok).toBe(true);
		expect(accepted(parseAuthoringAttestation(attestation())).signed.protocol_version).toBe(1);
	});

	it("P4: accepts a rehearsed outcome — termination, diff, stdio heads, divergence risk", () => {
		expect(parseShadowOutcome(rehearsed()).ok).toBe(true);
	});

	it("P5: accepts a binding_mismatch carrying the claim and both mismatch shapes", () => {
		expect(parseShadowOutcome(bindingMismatch()).ok).toBe(true);
		const unreached = { field: "env_digest", comparison: "policy_vs_measurement", expected: `"${HEX}"`, unavailable_reason: "not_reached" };
		expect(reasonOf(parseShadowOutcome({ ...bindingMismatch(), mismatches: [unreached] }))).toBe("<accepted>");
	});

	it("P6: accepts the other-unavailable shape bare, with a claim, and with an INCOMPLETE verifier", () => {
		expect(parseShadowOutcome(otherUnavailable()).ok).toBe(true);
		expect(parseShadowOutcome({ ...otherUnavailable(), execution_claim: claim() }).ok).toBe(true);
		const incomplete = { ...unavailableBase(), phase: "verify", reason: "verifier_incomplete", verifier_result: incompleteVerifier() };
		expect(reasonOf(parseShadowOutcome(incomplete))).toBe("<accepted>");
	});

	it("P7: accepts every unavailable reason in every phase REASON_PHASES declares for it", () => {
		for (const [reason, phases] of Object.entries(REASON_PHASES)) {
			// SAFETY: REASON_PHASES is declared `satisfies Record<reason, readonly ShadowPhase[]>`.
			for (const phase of phases as readonly ShadowPhase[]) {
				const raw =
					reason === "binding_mismatch"
						? { ...bindingMismatch(), phase }
						: { ...unavailableBase(), phase, reason };
				expect(reasonOf(parseShadowOutcome(raw))).toBe("<accepted>");
			}
		}
	});

	it("P8: accepts both incomplete-run shapes — a signaled crash and a timeout with no termination", () => {
		const crashed = { status: "crashed", termination: { kind: "signaled", signal: "SIGSEGV" }, diagnostics_partial: [diagnostic()] };
		const raw = { ...unavailableBase(), phase: "verify", reason: "verifier_incomplete" };
		expect(parseShadowOutcome({ ...raw, verifier_result: { ...incompleteVerifier(), pre: crashed } }).ok).toBe(true);
		expect(parseShadowOutcome({ ...raw, verifier_result: { ...incompleteVerifier(), post: completeRun() } }).ok).toBe(true);
	});

	it("P9: accepts a complete run with the maximum declared diagnostics count agreement", () => {
		// In canonical order: the position-less one first (nulls sort first),
		// then "error" before "message" at the same position.
		const three = [{ ...diagnostic(), line: null, col: null, file: null }, diagnostic(), { ...diagnostic(), category: "message" }];
		expect(parseCompleteTscResult({ ...completeVerifier(), post: completeRun(three) }).ok).toBe(true);
	});
});

// ── negative ───────────────────────────────────────────────────────────────

describe("parse-outcome — negative (must reject)", () => {
	it("N1: rejects an unknown field at the top level", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), extra: 1 }))).toContain("unknown field(s): extra");
	});

	it("N2: rejects an unknown field NESTED inside the verifier result", () => {
		const bad = { ...verified(), verifier: { ...completeVerifier(), compiler: { ...compiler(), rogue: true } } };
		expect(reasonOf(parseShadowOutcome(bad))).toContain("unknown field(s): rogue");
	});

	it("N3: rejects an unknown status and an unknown completed kind", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), status: "partial" }))).toContain("status must be one of");
		expect(reasonOf(parseShadowOutcome({ ...materialized(), kind: "guessed" }))).toContain("kind must be one of");
	});

	it("N4: rejects an unknown version", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), schema_version: 2 }))).toContain("schema_version must be 1");
	});

	it("N5: rejects out-of-range integers — a negative duration and an over-cap diagnostics total", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), duration_ms: -1 }))).toContain("non-negative integer");
		const over = { ...completeRun(), diagnostics_total: SHADOW_LIMITS_V1.diagnostics_count + 1 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), pre: over }))).toContain("exceeds");
	});

	it("N6: rejects an empty-string brand", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), request_id: "" }))).toContain("opaque URL-safe id");
	});

	it("N7: rejects a reason/phase mismatch — the memo's named malformed case", () => {
		const bad = { ...unavailableBase(), phase: "fetch", reason: "projection" };
		expect(reasonOf(parseShadowOutcome(bad))).toContain('is not legal in phase "fetch"');
		expect(reasonOf(parseShadowOutcome({ ...bindingMismatch(), phase: "admit" }))).toContain("is not legal in phase");
	});

	it("N8: rejects an attestation with no verifier result — on a completed and on an unavailable outcome", () => {
		expect(reasonOf(parseShadowOutcome({ ...materialized(), attestation: attestation() }))).toContain("unknown field(s): attestation");
		expect(reasonOf(parseShadowOutcome({ ...verified(), attestation: attestation() }))).toContain("unknown field(s): attestation");
		expect(reasonOf(parseShadowOutcome({ ...otherUnavailable(), attestation: attestation() }))).toContain("unknown field(s): attestation");
	});

	it("N9: rejects a SIGNALED termination inside a run claiming to be complete", () => {
		const signaled = { ...completeRun(), termination: { kind: "signaled", signal: "SIGKILL" } };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), pre: signaled }))).toContain('kind must be "exited"');
	});

	it("N10: rejects diagnostics_total disagreeing with the array length", () => {
		const lying = { ...completeRun([diagnostic()]), diagnostics_total: 4 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), post: lying }))).toContain("diagnostics_total must equal");
	});

	it("N11: rejects an EMPTY mismatch list on binding_mismatch", () => {
		expect(reasonOf(parseShadowOutcome({ ...bindingMismatch(), mismatches: [] }))).toContain("must not be empty");
	});

	it("N12: rejects a binding_mismatch with no execution_claim", () => {
		const { execution_claim: _dropped, ...rest } = bindingMismatch();
		expect(reasonOf(parseShadowOutcome(rest))).toContain("execution_claim");
	});

	it("N13: rejects a mismatch carrying BOTH measured and unavailable_reason", () => {
		const both = { ...mismatch(), unavailable_reason: "not_reached" };
		expect(reasonOf(parseShadowOutcome({ ...bindingMismatch(), mismatches: [both] }))).toContain("unknown field(s): measured");
	});

	it("N14: rejects a mismatch naming a leaf that is not an execution-binding field", () => {
		const bad = { ...mismatch(), field: "local_head" };
		expect(reasonOf(parseShadowOutcome({ ...bindingMismatch(), mismatches: [bad] }))).toContain("must be one of");
	});

	it("N15: rejects a COMPLETE verifier result whose dependencies resolved to none", () => {
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), dependencies: { mode: "none" } }))).toContain('must not be "none"');
	});

	it("N16: rejects a complete result missing its post run, and an incomplete result on the completed path", () => {
		const { post: _dropped, ...rest } = completeVerifier();
		expect(parseCompleteTscResult(rest).ok).toBe(false);
		expect(parseCompleteTscResult(incompleteVerifier()).ok).toBe(false);
	});

	it("N17: rejects an attestation signed under the wrong domain or purpose", () => {
		// SAFETY: the fixture literal above declares `signed` as an object.
		const signed = attestation().signed as Obj;
		expect(reasonOf(parseAuthoringAttestation({ ...attestation(), signed: { ...signed, domain: "interlinked-shadow-admission" } }))).toContain("domain must be");
	});

	it("N18: rejects an unknown unavailable reason", () => {
		// SAFETY: deliberately an ILLEGAL reason — the case exists to prove the parser refuses it.
		const raw = { ...unavailableBase(), reason: "vibes" as unknown as ShadowUnavailableReason };
		expect(reasonOf(parseShadowOutcome(raw))).toContain("reason must be one of");
	});
});

// ── positive: diagnostic positions, canonical order, budgets ───────────────
// The sort key is the memo's (§4.2 verifier-result bullet): file bytewise with
// NULL FIRST, line null-first, col null-first, category, code, message
// bytewise. The reviewer's brief proposed "nulls last"; the memo wins.

describe("parse-outcome diagnostics — positive (must accept)", () => {
	it("P10: accepts 1-based positions at their smallest legal value", () => {
		const first = { ...diagnostic(), line: 1, col: 1 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [first] }))).toBe("<accepted>");
	});

	it("P11: accepts a diagnostic with NO position — file, line and col all null", () => {
		const fileless = { ...diagnostic(), file: null, line: null, col: null };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [fileless] }))).toBe("<accepted>");
	});

	it("P12: accepts an array in canonical order — nulls first, then file, line, col", () => {
		const sorted = [
			{ ...diagnostic(), file: null, line: null, col: null },
			{ ...diagnostic(), file: "src/a.ts", line: null, col: null },
			{ ...diagnostic(), file: "src/a.ts", line: 12, col: 3 },
			{ ...diagnostic(), file: "src/b.ts", line: 1, col: 1 },
		];
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: sorted }))).toBe("<accepted>");
	});

	it("P13: accepts a duplicate-position pair ordered by code", () => {
		const pair = [
			{ ...diagnostic(), code: 2322 },
			{ ...diagnostic(), code: 2345 },
		];
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: pair }))).toBe("<accepted>");
	});

	it("P14: accepts a partial array on an incomplete run when it is in canonical order", () => {
		const partial = [
			{ ...diagnostic(), file: null, line: null, col: null },
			{ ...diagnostic(), line: 12, col: 3 },
		];
		const raw = { ...unavailableBase(), phase: "verify", reason: "verifier_incomplete" };
		const result = { ...incompleteVerifier(), pre: { status: "timeout", diagnostics_partial: partial } };
		expect(reasonOf(parseShadowOutcome({ ...raw, verifier_result: result }))).toBe("<accepted>");
	});
});

// ── negative: positions, order, budgets ────────────────────────────────────

/** `count` sorted diagnostics whose messages are multi-byte: a CHARACTER
 *  count of the whole array stays under the byte cap, so only a byte walk
 *  can refuse it. */
function multiByteDiagnostics(count: number, chars: number): Obj[] {
	const message = "é".repeat(chars);
	return Array.from({ length: count }, (_unused, index) => ({
		...diagnostic(),
		file: null,
		line: null,
		col: null,
		code: index,
		message,
	}));
}

describe("parse-outcome diagnostics — negative (must reject)", () => {
	it("N19: rejects line 0 — diagnostic positions are 1-based", () => {
		const zero = { ...diagnostic(), line: 0 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [zero] }))).toContain("1-based");
	});

	it("N20: rejects col 0 — diagnostic positions are 1-based", () => {
		const zero = { ...diagnostic(), col: 0 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [zero] }))).toContain("1-based");
	});

	it("N21: rejects a negative line and a negative col", () => {
		const negLine = { ...diagnostic(), line: -1 };
		const negCol = { ...diagnostic(), col: -3 };
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [negLine] }))).toContain("non-negative integer");
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: [negCol] }))).toContain("non-negative integer");
	});

	it("N22: rejects an UNSORTED array rather than silently re-ordering it", () => {
		const unsorted = [
			{ ...diagnostic(), file: "src/b.ts" },
			{ ...diagnostic(), file: "src/a.ts" },
		];
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: unsorted }))).toContain("canonical order");
	});

	it("N23: rejects an unsorted array on a complete run and on a partial array too", () => {
		const unsorted = [
			{ ...diagnostic(), line: 12 },
			{ ...diagnostic(), line: 2 },
		];
		const run = completeRun(unsorted);
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), post: run }))).toContain("canonical order");
		const raw = { ...unavailableBase(), phase: "verify", reason: "verifier_incomplete" };
		const result = { ...incompleteVerifier(), pre: { status: "timeout", diagnostics_partial: unsorted } };
		expect(reasonOf(parseShadowOutcome({ ...raw, verifier_result: result }))).toContain("canonical order");
	});

	it("N24: rejects a null position sorted AFTER a present one — nulls come first", () => {
		const unsorted = [
			{ ...diagnostic(), file: "src/a.ts" },
			{ ...diagnostic(), file: null, line: null, col: null },
		];
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: unsorted }))).toContain("canonical order");
	});

	it("N25: rejects an over-COUNT array", () => {
		const many = multiByteDiagnostics(SHADOW_LIMITS_V1.diagnostics_count + 1, 1);
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: many }))).toContain("entries");
	});

	it("N26: rejects an over-BYTES array whose COUNT and character total are both legal", () => {
		const heavy = multiByteDiagnostics(700, 4_000);
		const chars = heavy.length * 4_000;
		expect(heavy.length).toBeLessThanOrEqual(SHADOW_LIMITS_V1.diagnostics_count);
		expect(chars).toBeLessThan(SHADOW_LIMITS_V1.diagnostics_bytes);
		expect(reasonOf(parseCompleteTscResult({ ...completeVerifier(), introduced: heavy }))).toContain("diagnostic message bytes");
	});
});
