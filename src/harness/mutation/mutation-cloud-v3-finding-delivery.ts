import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, parse, posix, resolve } from "node:path";
import type { ClaimedOutboxEntry, OutboxLeaseRef } from "./mutation-journal-types.js";

export const MUTATION_FINDING_DELIVERY_RELATIVE_PATH = ".interlinked/mutation-findings.jsonl";

const MAX_OWNER_LENGTH = 128;
const MAX_LEASE_MS = 60 * 60 * 1_000;
const MAX_TARGET_LENGTH = 512;
const MAX_SOURCE_MESSAGE_LENGTH = 16_384;
const MAX_AGENT_MESSAGE_LENGTH = 640;
const MAX_POLICY_VERSION_LENGTH = 128;
const MAX_DATE_MS = 8_640_000_000_000_000;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const FINDING_KEYS = new Set([
	"finding_version",
	"delivery_finding_id",
	"semantic_finding_fingerprint",
	"category",
	"severity",
	"verdict",
	"message",
	"target",
	"acceptance_receipt_hash",
	"result_hash",
	"evaluator_policy_version",
	"evidence_completeness",
]);

type FindingCategory = "not_measured" | "baseline_adoption" | "adverse" | "red_witness";
type FindingSeverity = "error" | "warning";
type FindingVerdict = "clean" | "adverse" | "not_measured" | "baseline_adopted";
type EvidenceCompleteness = "complete" | "partial" | "none";

interface DeliveredMutationFindingPayload {
	finding_version: "1" | "unrecognized";
	delivery_finding_id?: string;
	semantic_finding_fingerprint?: string;
	category: FindingCategory | "unknown";
	severity: FindingSeverity;
	verdict: FindingVerdict | "unknown";
	target?: string;
	evidence_completeness?: EvidenceCompleteness;
	message: string;
}

export interface MutationFindingDeliveryRecord {
	delivery_version: "1";
	outbox_id: string;
	topic: "mutation.finding";
	delivery_attempt: number;
	delivered_at: string;
	payload: DeliveredMutationFindingPayload;
}

export interface MutationFindingOutbox {
	claimOutbox(owner: string, nowMs: number, leaseMs: number): ClaimedOutboxEntry | null;
	releaseOutbox(input: OutboxLeaseRef): boolean;
	acknowledgeOutbox(input: OutboxLeaseRef): boolean;
}

interface MutationFindingDeliveryOptions {
	root: string;
	owner: string;
	leaseMs: number;
	journal: MutationFindingOutbox;
	clock?: () => number;
	append?: (root: string, record: MutationFindingDeliveryRecord) => Promise<void>;
}

export type MutationFindingDeliveryOutcome =
	| { kind: "idle" }
	| { kind: "delivered"; outboxId: string; message: string }
	| { kind: "retry"; outboxId: string; stage: "sink" | "acknowledge"; message: string }
	| {
			kind: "lost_lease";
			outboxId: string;
			stage: "before_append" | "release" | "acknowledge";
			message: string;
	  };

interface ParsedFindingPayload {
	deliveryFindingId: string;
	semanticFindingFingerprint: string;
	category: FindingCategory;
	severity: FindingSeverity;
	verdict: FindingVerdict;
	target: string;
	evidenceCompleteness: EvidenceCompleteness;
}

function requireRoot(root: string): string {
	if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
		throw new TypeError("mutation finding delivery root must be a non-empty absolute path");
	}
	const normalized = resolve(root);
	if (normalized === parse(normalized).root) {
		throw new RangeError("mutation finding delivery root must not be a filesystem root");
	}
	return normalized;
}

function requireOwner(owner: string): void {
	if (
		typeof owner !== "string" ||
		owner.length === 0 ||
		owner.length > MAX_OWNER_LENGTH ||
		!SAFE_TOKEN.test(owner)
	) {
		throw new TypeError("mutation finding delivery owner must be a bounded identifier");
	}
}

function requireLeaseMs(leaseMs: number): void {
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
		throw new RangeError(`mutation finding delivery leaseMs must be an integer from 1 through ${MAX_LEASE_MS}`);
	}
}

function readClock(clock: () => number): number {
	const nowMs = clock();
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS) {
		throw new RangeError("mutation finding delivery clock must return a valid non-negative epoch millisecond");
	}
	return nowMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFindingKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === FINDING_KEYS.size && keys.every((key) => FINDING_KEYS.has(key));
}

function findingCategory(value: unknown): FindingCategory | null {
	switch (value) {
		case "not_measured":
		case "baseline_adoption":
		case "adverse":
		case "red_witness":
			return value;
		default:
			return null;
	}
}

function findingSeverity(value: unknown): FindingSeverity | null {
	return value === "error" || value === "warning" ? value : null;
}

function findingVerdict(value: unknown): FindingVerdict | null {
	switch (value) {
		case "clean":
		case "adverse":
		case "not_measured":
		case "baseline_adopted":
			return value;
		default:
			return null;
	}
}

function evidenceCompleteness(value: unknown): EvidenceCompleteness | null {
	return value === "complete" || value === "partial" || value === "none" ? value : null;
}

function isSafeTarget(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TARGET_LENGTH ||
		value.startsWith("/") ||
		value.includes("\\") ||
		CONTROL_CHARACTER.test(value)
	) {
		return false;
	}
	return posix.normalize(value) === value && value.split("/").every((part) => part !== "." && part !== "..");
}

function parseFindingIdentity(
	payload: Record<string, unknown>,
	outboxId: string,
): Pick<ParsedFindingPayload, "deliveryFindingId" | "semanticFindingFingerprint"> | null {
	const deliveryFindingId = payload.delivery_finding_id;
	const semanticFindingFingerprint = payload.semantic_finding_fingerprint;
	if (typeof deliveryFindingId !== "string" || !SHA256_HEX.test(deliveryFindingId)) return null;
	if (!outboxId.endsWith(`:${deliveryFindingId}`)) return null;
	if (typeof semanticFindingFingerprint !== "string" || !SHA256_HEX.test(semanticFindingFingerprint)) {
		return null;
	}
	return { deliveryFindingId, semanticFindingFingerprint };
}

function parseFindingClassification(
	payload: Record<string, unknown>,
): Pick<ParsedFindingPayload, "category" | "severity" | "verdict" | "evidenceCompleteness"> | null {
	const category = findingCategory(payload.category);
	const severity = findingSeverity(payload.severity);
	const verdict = findingVerdict(payload.verdict);
	const completeness = evidenceCompleteness(payload.evidence_completeness);
	if (category === null || severity === null || verdict === null || completeness === null) return null;
	return { category, severity, verdict, evidenceCompleteness: completeness };
}

function hasSafeProvenance(payload: Record<string, unknown>): boolean {
	if (typeof payload.message !== "string" || payload.message.length > MAX_SOURCE_MESSAGE_LENGTH) return false;
	if (typeof payload.acceptance_receipt_hash !== "string" || !SHA256_HEX.test(payload.acceptance_receipt_hash)) {
		return false;
	}
	if (typeof payload.result_hash !== "string" || !SHA256_HEX.test(payload.result_hash)) return false;
	return (
		typeof payload.evaluator_policy_version === "string" &&
		payload.evaluator_policy_version.length > 0 &&
		payload.evaluator_policy_version.length <= MAX_POLICY_VERSION_LENGTH &&
		!CONTROL_CHARACTER.test(payload.evaluator_policy_version)
	);
}

function parseFindingPayload(payload: unknown, outboxId: string): ParsedFindingPayload | null {
	if (!isRecord(payload) || !hasOnlyFindingKeys(payload) || payload.finding_version !== "1") return null;
	const identity = parseFindingIdentity(payload, outboxId);
	const classification = parseFindingClassification(payload);
	if (identity === null || classification === null || !isSafeTarget(payload.target) || !hasSafeProvenance(payload)) {
		return null;
	}
	return { ...identity, ...classification, target: payload.target };
}

function capMessage(message: string): string {
	if (message.length <= MAX_AGENT_MESSAGE_LENGTH) return message;
	return `${message.slice(0, MAX_AGENT_MESSAGE_LENGTH - 1)}…`;
}

function findingMessage(finding: ParsedFindingPayload): string {
	const target = finding.target;
	const messages: Record<FindingCategory, string> = {
		not_measured: `[interlinked:mutation] Mutation was not measured for ${target}; inspect the authenticated local journal before treating the change as clean.`,
		baseline_adoption: `[interlinked:mutation] Mutation baseline adopted for ${target}; adoption is not a clean verdict.`,
		adverse: `[interlinked:mutation] Mutation testing found an adverse result for ${target}; inspect the authenticated local journal for details.`,
		red_witness: `[interlinked:mutation] A new mutation test for ${target} did not fail against the base revision.`,
	};
	return capMessage(messages[finding.category]);
}

function safePayload(payload: unknown, outboxId: string): DeliveredMutationFindingPayload {
	const parsed = parseFindingPayload(payload, outboxId);
	if (parsed === null) {
		return {
			finding_version: "unrecognized",
			category: "unknown",
			severity: "warning",
			verdict: "unknown",
			message: "[interlinked:mutation] A mutation finding is available; inspect the authenticated local journal for details.",
		};
	}
	return {
		finding_version: "1",
		delivery_finding_id: parsed.deliveryFindingId,
		semantic_finding_fingerprint: parsed.semanticFindingFingerprint,
		category: parsed.category,
		severity: parsed.severity,
		verdict: parsed.verdict,
		target: parsed.target,
		evidence_completeness: parsed.evidenceCompleteness,
		message: findingMessage(parsed),
	};
}

function validClaim(claim: ClaimedOutboxEntry, claimNowMs: number): boolean {
	return (
		/^[1-9][0-9]*:[0-9a-f]{64}$/.test(claim.outboxId) &&
		Number.isSafeInteger(claim.evaluationId) &&
		claim.evaluationId > 0 &&
		claim.outboxId.startsWith(`${claim.evaluationId}:`) &&
		UUID.test(claim.leaseToken) &&
		Number.isSafeInteger(claim.leaseExpiresAtMs) &&
		claim.leaseExpiresAtMs > claimNowMs &&
		Number.isSafeInteger(claim.attemptCount) &&
		claim.attemptCount > 0
	);
}

async function appendMutationFindingRecord(
	root: string,
	record: MutationFindingDeliveryRecord,
): Promise<void> {
	const directory = join(root, ".interlinked");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error("mutation finding delivery directory must be a real directory");
	}
	const target = join(root, MUTATION_FINDING_DELIVERY_RELATIVE_PATH);
	const handle = await open(
		target,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function deliveryRecord(claim: ClaimedOutboxEntry, deliveredAtMs: number): MutationFindingDeliveryRecord {
	return {
		delivery_version: "1",
		outbox_id: claim.outboxId,
		topic: claim.topic,
		delivery_attempt: claim.attemptCount,
		delivered_at: new Date(deliveredAtMs).toISOString(),
		payload: safePayload(claim.payload, claim.outboxId),
	};
}

function lostLease(
	claim: ClaimedOutboxEntry,
	stage: "before_append" | "release" | "acknowledge",
	record: MutationFindingDeliveryRecord,
): MutationFindingDeliveryOutcome {
	return { kind: "lost_lease", outboxId: claim.outboxId, stage, message: record.payload.message };
}

async function releaseAfterSinkFailure(input: {
	options: MutationFindingDeliveryOptions;
	claim: ClaimedOutboxEntry;
	record: MutationFindingDeliveryRecord;
	clock: () => number;
}): Promise<MutationFindingDeliveryOutcome> {
	try {
		const released = input.options.journal.releaseOutbox({
			outboxId: input.claim.outboxId,
			leaseToken: input.claim.leaseToken,
			nowMs: readClock(input.clock),
		});
		if (!released) return lostLease(input.claim, "release", input.record);
	} catch {
		return lostLease(input.claim, "release", input.record);
	}
	return {
		kind: "retry",
		outboxId: input.claim.outboxId,
		stage: "sink",
		message: input.record.payload.message,
	};
}

export async function deliverOneMutationFinding(
	options: MutationFindingDeliveryOptions,
): Promise<MutationFindingDeliveryOutcome> {
	const root = requireRoot(options.root);
	requireOwner(options.owner);
	requireLeaseMs(options.leaseMs);
	const clock = options.clock ?? Date.now;
	if (typeof clock !== "function") throw new TypeError("mutation finding delivery clock must be a function");
	const append = options.append ?? appendMutationFindingRecord;
	if (typeof append !== "function") throw new TypeError("mutation finding delivery append must be a function");
	const claimNowMs = readClock(clock);
	const claim = options.journal.claimOutbox(options.owner, claimNowMs, options.leaseMs);
	if (claim === null) return { kind: "idle" };
	if (!validClaim(claim, claimNowMs)) throw new Error("mutation finding outbox returned an invalid lease claim");
	const deliveredAtMs = readClock(clock);
	const record = deliveryRecord(claim, deliveredAtMs);
	if (deliveredAtMs >= claim.leaseExpiresAtMs) return lostLease(claim, "before_append", record);
	try {
		await append(root, record);
	} catch {
		return releaseAfterSinkFailure({ options, claim, record, clock });
	}
	try {
		const acknowledged = options.journal.acknowledgeOutbox({
			outboxId: claim.outboxId,
			leaseToken: claim.leaseToken,
			nowMs: deliveredAtMs,
		});
		if (!acknowledged) return lostLease(claim, "acknowledge", record);
	} catch {
		return { kind: "retry", outboxId: claim.outboxId, stage: "acknowledge", message: record.payload.message };
	}
	return { kind: "delivered", outboxId: claim.outboxId, message: record.payload.message };
}
