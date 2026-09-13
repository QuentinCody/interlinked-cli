// ===========================================
// Protocol v3 — strict UNTRUSTED-envelope parser
// ===========================================
// The ONE entry point through which a raw wire value becomes a typed
// `V3Envelope`. Strict recursively: unknown keys at ANY level, malformed
// hash/timestamp/path formats, unbounded inputs, census arithmetic
// violations, and kind-contract violations all reject with a specific
// reason. Parsing proves SHAPE ONLY — the output is still untrusted
// evidence until verify.ts checks hashes, signatures, and job echoes.
// Both repositories must produce/accept the same corpus
// (protocol/mutation-v3/fixtures); change this parser only with it.

import { deepFreeze, safeStructuredClone } from "./canonical.js";
import {
	checkBool,
	checkBoundedString,
	checkImageDigest,
	checkPolicyId,
	checkReportBytes,
	checkRepoRelativePath,
	checkRfc3339,
	checkSafeNonNegInt,
	checkSha256Hex,
	firstReason,
	isRecord,
	MAX_TEST_FILES,
	type Reason,
	unknownKeysIn,
} from "./field-checks.js";
import {
	checkCensusBlock,
	checkGeneratedCensusGroup,
	checkOptionalCensusGroup,
} from "./parse-census.js";
import type { V3Envelope, V3Kind } from "./types.js";
import { PROTOCOL_V3_VERSION, V3_EVIDENCE_KINDS, V3_KINDS } from "./types.js";

const PARSED: unique symbol = Symbol("interlinked.protocol-v3.parsed");
/** Branded: only parseUntrustedEnvelope can mint one, so "verified" can
 *  never be reached without "parsed" (review 2026-08-31 third pass: a
 *  signed envelope the parser REJECTED still verified when the verifier
 *  accepted any V3Envelope-shaped value). */
export type ParsedEnvelope = V3Envelope & { readonly [PARSED]: true };

export type ParseOutcome = { ok: true; envelope: ParsedEnvelope } | { ok: false; reason: string };

type Raw = Record<string, unknown>;

function mintParsedEnvelope(value: Raw): ParsedEnvelope {
	// Symbol keys never enter JSON/Object.entries, so the concrete runtime brand
	// preserves the wire payload instead of relying on a type-only assertion.
	const branded = Object.assign(value, { [PARSED]: true as const });
	// SAFETY: this helper has one caller, after every kind-specific validator
	// succeeds; the concrete brand above makes this the sole runtime mint site.
	return branded as unknown as ParsedEnvelope;
}

const COMMON_KEYS = [
	"protocol_version",
	"kind",
	"job",
	"acceptance_receipt_hash",
	"execution_receipt_hash",
	"terminalization_record_hash",
	"attempt_id",
	"result_hash",
	"signature",
	"seq",
	"occurred_at",
];

/** Top-level keys allowed per kind (COMMON_KEYS are always allowed). */
const KIND_KEYS: Record<V3Kind, string[]> = {
	mutation_result: ["scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"],
	suite_red: ["scope", "engine", "runner", "test_run", "census", "excluded", "mutants", "identity_algorithm"],
	not_mutatable: ["scope", "engine", "runner", "census", "test_run", "report", "no_test_policy"],
	execution_failed: [
		"failure_classification",
		"evidence_completeness",
		"scope",
		"engine",
		"runner",
		"census",
		"excluded",
		"mutants",
		"identity_algorithm",
		"test_run",
	],
	cancelled: ["cancellation_reason"],
	expired: ["expiry_reason"],
};

function checkBlock(raw: Raw, key: string, check: (o: Raw, where: string) => Reason): Reason {
	const v = raw[key];
	if (!isRecord(v)) return `${key} must be an object`;
	return check(v, key);
}

function optionalBlock(raw: Raw, key: string, check: (o: Raw, where: string) => Reason): Reason {
	return raw[key] === undefined ? null : checkBlock(raw, key, check);
}

function checkJob(o: Raw, where: string): Reason {
	return firstReason([
		unknownKeysIn(o, ["tenant", "project", "repository", "commit", "target_file", "target_content_hash", "job_key"], where),
		checkBoundedString(o.tenant, `${where}.tenant`),
		checkBoundedString(o.project, `${where}.project`),
		checkBoundedString(o.repository, `${where}.repository`),
		checkBoundedString(o.commit, `${where}.commit`),
		checkRepoRelativePath(o.target_file, `${where}.target_file`),
		checkSha256Hex(o.target_content_hash, `${where}.target_content_hash`),
		checkBoundedString(o.job_key, `${where}.job_key`),
	]);
}

const SCOPE_MODES = ["import_graph", "companion_fallback", "glob_fallback"];

function checkTestFiles(files: unknown, where: string): Reason {
	if (!Array.isArray(files) || files.length > MAX_TEST_FILES) {
		return `${where} must be an array of at most ${MAX_TEST_FILES} paths`;
	}
	const seen = new Set<string>();
	for (const f of files) {
		if (typeof f !== "string") return `${where}[] must be a repository-relative path`;
		const path = checkRepoRelativePath(f, `${where}[]`);
		if (path !== null) return path;
		if (seen.has(f)) return `${where} must not contain duplicates`;
		seen.add(f);
	}
	return null;
}

function validatedRecord(raw: Raw, key: string): Raw {
	// SAFETY: callers have passed checkRunBlocks/checkCensusBlock on the detached
	// snapshot; no getters or external references can change a validated field.
	return raw[key] as Raw;
}

function validatedNumber(raw: Raw, key: string): number {
	// SAFETY: checkTestRun already validated this field on the detached snapshot.
	return raw[key] as number;
}

function checkScope(o: Raw, where: string): Reason {
	if (typeof o.mode !== "string" || !SCOPE_MODES.includes(o.mode)) {
		return `${where}.mode must be one of ${SCOPE_MODES.join("|")}`;
	}
	if (o.incremental !== false) return `${where}.incremental must be false (v1 retires incremental scope)`;
	if (o.mutation_scope !== "whole_file") return `${where}.mutation_scope must be "whole_file"`;
	return firstReason([
		unknownKeysIn(o, ["mode", "test_files", "incremental", "mutation_scope"], where),
		checkTestFiles(o.test_files, `${where}.test_files`),
	]);
}

function checkEngine(o: Raw, where: string): Reason {
	if (typeof o.exit_code !== "number" || !Number.isSafeInteger(o.exit_code)) {
		return `${where}.exit_code must be a safe integer`;
	}
	return firstReason([
		unknownKeysIn(o, ["name", "version", "config_hash", "exit_code"], where),
		checkBoundedString(o.name, `${where}.name`),
		checkBoundedString(o.version, `${where}.version`),
		checkSha256Hex(o.config_hash, `${where}.config_hash`),
	]);
}

function checkRunner(o: Raw, where: string): Reason {
	return firstReason([
		unknownKeysIn(o, ["build", "image_digest"], where),
		checkBoundedString(o.build, `${where}.build`),
		checkImageDigest(o.image_digest, `${where}.image_digest`),
	]);
}

function checkTestRun(o: Raw, where: string): Reason {
	const rw = o.red_witness_satisfied;
	if (rw !== null && typeof rw !== "boolean") {
		return `${where}.red_witness_satisfied must be a boolean or null`;
	}
	return firstReason([
		unknownKeysIn(
			o,
			["executed_test_count", "overlay_green", "red_witness_satisfied", "command_hash", "runner_name", "runner_version"],
			where,
		),
		checkSafeNonNegInt(o.executed_test_count, `${where}.executed_test_count`),
		checkBool(o.overlay_green, `${where}.overlay_green`),
		checkSha256Hex(o.command_hash, `${where}.command_hash`),
		checkBoundedString(o.runner_name, `${where}.runner_name`),
		checkBoundedString(o.runner_version, `${where}.runner_version`),
	]);
}

function checkSignature(o: Raw, where: string): Reason {
	return firstReason([
		unknownKeysIn(o, ["key_id", "value"], where),
		checkBoundedString(o.key_id, `${where}.key_id`),
		checkBoundedString(o.value, `${where}.value`),
	]);
}

function checkReport(o: Raw, where: string): Reason {
	return firstReason([
		unknownKeysIn(o, ["r2_sha256", "bytes", "content_hash"], where),
		checkSha256Hex(o.r2_sha256, `${where}.r2_sha256`),
		checkReportBytes(o.bytes, `${where}.bytes`),
		checkSha256Hex(o.content_hash, `${where}.content_hash`),
	]);
}

/** Execution-receipt arm: hash format + the attempt id it requires. */
function checkExecutionReceiptArm(raw: Raw): Reason {
	return firstReason([
		checkSha256Hex(raw.execution_receipt_hash, "execution_receipt_hash"),
		checkBoundedString(raw.attempt_id, "attempt_id (required with an execution receipt)"),
	]);
}

/** Terminalization arm: hash format; an attempt id is a contradiction. */
function checkTerminalizationArm(raw: Raw): Reason {
	if (raw.attempt_id !== undefined) {
		return "attempt_id requires an execution receipt — no attempt ran";
	}
	return checkSha256Hex(raw.terminalization_record_hash, "terminalization_record_hash");
}

/** XOR receipt binding + attempt coupling + evidence-kind receipt rule. */
function checkReceiptBinding(raw: Raw, kind: V3Kind): Reason {
	const exec = raw.execution_receipt_hash !== undefined;
	const term = raw.terminalization_record_hash !== undefined;
	if (exec === term) {
		return "exactly one of execution_receipt_hash / terminalization_record_hash must be present";
	}
	const arm = exec ? checkExecutionReceiptArm(raw) : checkTerminalizationArm(raw);
	if (arm !== null) return arm;
	if (V3_EVIDENCE_KINDS.includes(kind) && !exec) {
		return `${kind} carries run evidence and requires an execution receipt, not a terminalization record`;
	}
	return null;
}

function checkCommon(raw: Raw, kind: V3Kind): Reason {
	if (raw.protocol_version !== PROTOCOL_V3_VERSION) {
		return `protocol_version must be exactly "${PROTOCOL_V3_VERSION}"`;
	}
	return firstReason([
		checkBlock(raw, "job", checkJob),
		checkSha256Hex(raw.acceptance_receipt_hash, "acceptance_receipt_hash"),
		checkReceiptBinding(raw, kind),
		checkSha256Hex(raw.result_hash, "result_hash"),
		checkBlock(raw, "signature", checkSignature),
		checkSafeNonNegInt(raw.seq, "seq"),
		checkRfc3339(raw.occurred_at, "occurred_at"),
	]);
}

function checkRunBlocks(raw: Raw): Reason {
	return firstReason([
		checkBlock(raw, "scope", checkScope),
		checkBlock(raw, "engine", checkEngine),
		checkBlock(raw, "runner", checkRunner),
		checkBlock(raw, "test_run", checkTestRun),
	]);
}

function checkMutationResult(raw: Raw): Reason {
	const blocks = firstReason([
		checkRunBlocks(raw),
		checkGeneratedCensusGroup(raw),
		checkBlock(raw, "report", checkReport),
	]);
	if (blocks !== null) return blocks;
	const testRun = validatedRecord(raw, "test_run");
	if (validatedNumber(testRun, "executed_test_count") < 1) {
		return "mutation_result requires executed_test_count >= 1 — a run that executed no test proves nothing";
	}
	if (testRun.overlay_green !== true) {
		return "mutation_result requires overlay_green === true — a red overlay is the suite_red kind";
	}
	const engine = validatedRecord(raw, "engine");
	if (engine.exit_code !== 0) {
		return "mutation_result requires engine exit_code 0 — a non-zero exit is execution_failed";
	}
	return null;
}

function checkSuiteRed(raw: Raw): Reason {
	const blocks = checkRunBlocks(raw);
	if (blocks !== null) return blocks;
	const group = [raw.census, raw.excluded, raw.mutants, raw.identity_algorithm];
	const present = group.filter((g) => g !== undefined).length;
	if (present !== 0 && present !== group.length) {
		return "suite_red partial evidence: census, excluded, mutants, and identity_algorithm must travel together or not at all";
	}
	if (present === group.length) {
		const evidence = checkOptionalCensusGroup(raw);
		if (evidence !== null) return evidence;
	}
	const testRun = validatedRecord(raw, "test_run");
	return testRun.overlay_green === false ? null : "suite_red requires test_run.overlay_green === false";
}

/** The zero-test escape: valid only under a recorded, controlled policy. */
function checkNoTestPolicy(raw: Raw, testRun: Raw): Reason {
	const policy = raw.no_test_policy;
	if (validatedNumber(testRun, "executed_test_count") >= 1) {
		return policy === undefined ? null : checkPolicyId(policy, "no_test_policy");
	}
	const policyReason = checkPolicyId(policy, "no_test_policy");
	if (policyReason !== null) {
		return `not_mutatable proof contract requires executed_test_count >= 1 or a recorded no_test_policy (${policyReason})`;
	}
	return null;
}

function checkNotMutatable(raw: Raw): Reason {
	const blocks = firstReason([
		checkRunBlocks(raw),
		checkCensusBlock(raw),
		checkBlock(raw, "report", checkReport),
	]);
	if (blocks !== null) return blocks;
	const census = validatedRecord(raw, "census");
	if (census.generated !== 0 || census.executable !== 0) {
		return "not_mutatable proof contract requires census.generated === 0 and census.executable === 0";
	}
	const engine = validatedRecord(raw, "engine");
	if (engine.exit_code !== 0) return "not_mutatable proof contract requires engine exit_code 0";
	const testRun = validatedRecord(raw, "test_run");
	if (testRun.overlay_green !== true) {
		return "not_mutatable proof contract requires a green affected suite";
	}
	return checkNoTestPolicy(raw, testRun);
}

const EVIDENCE_BLOCK_KEYS = ["scope", "engine", "runner", "census", "excluded", "mutants", "test_run"];

function checkExecutionFailed(raw: Raw): Reason {
	const classification = checkBoundedString(raw.failure_classification, "failure_classification");
	if (classification !== null) return classification;
	const completeness = raw.evidence_completeness;
	if (completeness !== "none" && completeness !== "partial") {
		return 'evidence_completeness must be "none" or "partial" — no consumer may infer completeness';
	}
	const presentBlocks = EVIDENCE_BLOCK_KEYS.filter((k) => raw[k] !== undefined);
	if (completeness === "none") {
		return presentBlocks.length === 0
			? null
			: `evidence_completeness "none" forbids evidence blocks (found ${presentBlocks[0]})`;
	}
	if (presentBlocks.length === 0) {
		return 'evidence_completeness "partial" requires at least one evidence block';
	}
	if (raw.execution_receipt_hash === undefined) {
		return "partial evidence requires an execution receipt — evidence cannot precede execution";
	}
	return checkPartialEvidenceBlocks(raw);
}

function checkPartialEvidenceBlocks(raw: Raw): Reason {
	const group = [raw.census, raw.excluded, raw.mutants, raw.identity_algorithm];
	const present = group.filter((g) => g !== undefined).length;
	if (present !== 0 && present !== group.length) {
		return "partial evidence: census, excluded, mutants, and identity_algorithm must travel together or not at all";
	}
	return firstReason([
		optionalBlock(raw, "scope", checkScope),
		optionalBlock(raw, "engine", checkEngine),
		optionalBlock(raw, "runner", checkRunner),
		optionalBlock(raw, "test_run", checkTestRun),
		present === group.length ? checkOptionalCensusGroup(raw) : null,
	]);
}

const KIND_CHECKS: Record<V3Kind, (raw: Raw) => Reason> = {
	mutation_result: checkMutationResult,
	suite_red: checkSuiteRed,
	not_mutatable: checkNotMutatable,
	execution_failed: checkExecutionFailed,
	cancelled: (raw) => checkBoundedString(raw.cancellation_reason, "cancellation_reason"),
	expired: (raw) => checkBoundedString(raw.expiry_reason, "expiry_reason"),
};

function unknownKeyError(raw: Raw, kind: V3Kind): Reason {
	return unknownKeysIn(raw, [...COMMON_KEYS, ...KIND_KEYS[kind]], `kind "${kind}"`);
}

/** Parse one raw wire value into a typed, still-UNTRUSTED v3 envelope, or
 *  reject with the first specific reason. Never throws. Trust (hashes,
 *  signatures, job echoes) is verify.ts's job. Tenth pass P0-1: the raw
 *  value is SNAPSHOTTED FIRST (getters read exactly once), the snapshot
 *  is validated, and the returned envelope is deep-frozen — the caller's
 *  reference can never mutate authenticated evidence afterward. */
export function parseUntrustedEnvelope(raw: unknown): ParseOutcome {
	const snapshot = safeStructuredClone(raw);
	if (snapshot === null || !isRecord(snapshot)) {
		return { ok: false, reason: "envelope must be a plain JSON object" };
	}
	const kind = V3_KINDS.find((candidate) => candidate === snapshot.kind);
	if (kind === undefined) {
		return { ok: false, reason: `kind must be one of ${V3_KINDS.join("|")}` };
	}
	const reason = firstReason([
		checkCommon(snapshot, kind),
		unknownKeyError(snapshot, kind),
		KIND_CHECKS[kind](snapshot),
	]);
	if (reason !== null) return { ok: false, reason };
	const envelope = mintParsedEnvelope(snapshot);
	deepFreeze(envelope);
	// SAFETY: every field, format, and invariant of the kind was validated
	// on the frozen snapshot; it structurally satisfies the union member.
	// This is the ONE mint site of the ParsedEnvelope brand.
	return { ok: true, envelope };
}
