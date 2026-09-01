// ===========================================
// Hash-chained audit verification for guard decision events
// ===========================================
// Borrowed from Microsoft Agent Governance Toolkit's audit.mjs pattern
// (`agent-governance-claude-code/lib/audit.mjs`, MIT). Maps to OWASP ASI11
// "Agent Untraceability" — tamper-evident decision audit.
//
// Scope: the chain covers `guard_block` / `guard_warn` / `guard_allow`
// records written by the hook template's `appendGuardDecision`, PLUS
// `session_end` records written by `appendLocal` (which applies chain
// fields when the event type is session_end so the chain captures *how*
// the session ended via Claude Code's `reason` field). All chained
// records live in .interlinked/activity.jsonl
// (src/lib/hook-template-chunks/session-state.ts).
//
// Non-decision entries (other event_types written by `appendLocal`)
// share the same file but live outside the chain by design — the chain's
// `previousHash` walks back to the most recent chained entry of any
// supported type, skipping transcript noise.
//
// This module is the verifier. The writer is inlined in the hook template
// so the generated .mjs stays self-contained per CLAUDE.md.

import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ArchiveEvidenceError,
	iterateAllAuditLines,
	iterateAllAuditLinesStreaming,
} from "./audit-chain-io.js";
import { getDataDir } from "./config.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { isJsonObject, type JsonObject } from "./json-types.js";
import { readRecentLines } from "./reverse-line-reader.js";

export { iterateFileLines } from "./audit-chain-io.js";

export const GENESIS_HASH = "0".repeat(64);
// Record types that participate in the hash chain. Originally guard_* only;
// session_end was added 2026-05 so the audit chain captures *how* sessions
// terminate (Claude Code's `reason` field). The set name is historical —
// kept for back-compat with consumers reading the field name; semantically
// these are "chained record types," not just guard decisions.
const CHAINED_AUDIT_TYPES = new Set([
	"guard_block",
	"guard_warn",
	"guard_allow",
	"session_end",
]);
const AUDIT_TAIL_BYTES = 64 * 1024;

interface GuardChainEntry {
	ts?: string;
	type?: string;
	previousHash?: string;
	hash?: string;
	[k: string]: unknown;
}

export interface AuditVerifyResult {
	valid: boolean;
	total_events: number;
	guard_events: number;
	chained_events: number;
	unchained_guard_events: number;
	first_bad_index?: number;
	first_bad_reason?: string;
	first_bad_line_number?: number;
	last_hash?: string | undefined;
}

/**
 * Canonical JSON for a record so hash inputs are stable across re-serializations
 * (V8 preserves insertion order, but engines aren't strictly required to — we
 * don't rely on that). Keys at every level are sorted lexicographically.
 */
export function canonicalJson(value: unknown): string {
	// lib.es5's `JSON.stringify` signature claims a `string` return
	// unconditionally, but at runtime it returns `undefined` for
	// `undefined`/function/symbol inputs — the declared type lies here, so
	// the undefined case is handled explicitly rather than via `?? "null"`
	// (which type-checks as dead code against the dishonest signature).
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const obj = value as JsonObject;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Hash for one guard-decision record. The `hash` field itself is excluded
 * (recursive otherwise) but every other field — including `previousHash` —
 * is in the canonical payload. Any mutation of any captured field breaks
 * the chain at that entry.
 */
export function computeEntryHash<T extends object>(record: Readonly<T>): string {
	const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "hash"));
	return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** Find the newest chain head using the same bounded-tail policy as the
 * self-contained legacy hook runtime. Callers hold the activity mutation lock,
 * so the chosen predecessor and appended record are one critical section. */
function readPreviousAuditHash(path: string): string {
	try {
		if (!existsSync(path)) return GENESIS_HASH;
		for (const line of readRecentLines(path, Number.MAX_SAFE_INTEGER, AUDIT_TAIL_BYTES)) {
			try {
				const record: unknown = JSON.parse(line);
				if (
					isJsonObject(record) &&
					typeof record.type === "string" &&
					CHAINED_AUDIT_TYPES.has(record.type) &&
					typeof record.hash === "string" &&
					record.hash.length === 64
				) {
					return record.hash;
				}
			} catch {
				// Intentional: a clipped or malformed tail row is not a usable chain head.
			}
		}
	} catch {
		// Intentional: match the legacy hook's availability contract — a read failure
		// starts a new verifiable segment rather than breaking the tool hook.
	}
	return GENESIS_HASH;
}

/** Append one guard/session audit record with the predecessor selection, hash,
 * and JSONL append serialized against every participating writer and compactor.
 * This is the canonical TypeScript counterpart to the generated hook's
 * self-contained `appendGuardDecision` hash format. */
export function appendChainedAuditRecord<T extends { type: string }>(
	record: Readonly<T>,
	cwd: string = process.cwd(),
): void {
	if (!CHAINED_AUDIT_TYPES.has(record.type)) {
		throw new TypeError("only chained audit record types may use appendChainedAuditRecord");
	}
	const path = getActivityPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	withFileMutationLock(path, () => {
		const chained = {
			...record,
			previousHash: readPreviousAuditHash(path),
		};
		const complete = { ...chained, hash: computeEntryHash(chained) };
		appendFileSync(path, `${JSON.stringify(complete)}\n`);
	});
}

function safeEqualHex(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}

export function getActivityPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "activity.jsonl");
}

function unreadableAuditResult(err: unknown): AuditVerifyResult {
	return {
		valid: false,
		total_events: 0,
		guard_events: 0,
		chained_events: 0,
		unchained_guard_events: 0,
		// Archive failures name the manifest/segment; generic I/O points at the
		// live activity log. In both cases unread evidence is never called valid.
		first_bad_reason:
			err instanceof ArchiveEvidenceError
				? err.message
				: `activity.jsonl unreadable: ${err instanceof Error ? err.message : String(err)}`,
	};
}

/**
 * Walk activity.jsonl forward, treating guard_* entries with a `hash` field
 * as chain links. Returns the first integrity failure (or success at end).
 *
 * Mixed-file tolerant: non-guard records and hashless legacy guards count
 * in `total_events` / `unchained_guard_events` but don't break the chain.
 */
export function verifyAuditChain(cwd: string = process.cwd()): AuditVerifyResult {
	const path = getActivityPath(cwd);
	try {
		return walkChain(iterateAllAuditLines(cwd, path));
	} catch (err) {
		return unreadableAuditResult(err);
	}
}

/** Memory-bounded verifier for the user-facing audit command. Gzip segments
 * and the live log are consumed incrementally; archive size is unrestricted,
 * while any individual JSONL record remains bounded and fails closed. */
export async function verifyAuditChainStreaming(
	cwd: string = process.cwd(),
): Promise<AuditVerifyResult> {
	try {
		return await walkChainStreaming(iterateAllAuditLinesStreaming(cwd, getActivityPath(cwd)));
	} catch (err) {
		return unreadableAuditResult(err);
	}
}

interface ChainWalkState {
	totalEvents: number;
	guardEvents: number;
	chainedEvents: number;
	unchainedGuardEvents: number;
	expectedPrev: string;
	lastHash: string | undefined;
}

function newChainWalkState(): ChainWalkState {
	return {
		totalEvents: 0,
		guardEvents: 0,
		chainedEvents: 0,
		unchainedGuardEvents: 0,
		expectedPrev: GENESIS_HASH,
		lastHash: undefined,
	};
}

type ParsedAuditRecord =
	| { ok: true; record: GuardChainEntry }
	| { ok: false; reason: string };

function validateParsedAuditRecord(value: unknown): ParsedAuditRecord {
	if (!isJsonObject(value)) return { ok: false, reason: "audit row is not a JSON object" };
	if (typeof value.type !== "string" || value.type.length === 0) {
		return { ok: false, reason: "audit row has no valid type" };
	}
	return { ok: true, record: value };
}

function auditJsonError(error: unknown): string {
	return `malformed JSON: ${error instanceof Error ? error.message : String(error)}`;
}

function parseAuditRecord(raw: string): ParsedAuditRecord {
	try {
		const parsed: unknown = JSON.parse(raw);
		// Structurally valid, explicitly typed non-chain records remain
		// legitimate transcript rows. Malformed physical evidence never does.
		return validateParsedAuditRecord(parsed);
	} catch (error) {
		return { ok: false, reason: auditJsonError(error) };
	}
}

function chainFailure(
	state: ChainWalkState,
	lineNumber: number,
	reason: string,
): AuditVerifyResult {
	return {
		valid: false,
		total_events: state.totalEvents,
		guard_events: state.guardEvents,
		chained_events: state.chainedEvents,
		unchained_guard_events: state.unchainedGuardEvents,
		first_bad_index: state.chainedEvents,
		first_bad_line_number: lineNumber,
		first_bad_reason: reason,
		last_hash: state.lastHash,
	};
}

/** Consume one physical JSONL line. A result is returned only on failure. */
function consumeAuditLine(
	state: ChainWalkState,
	rawLine: string,
	lineNumber: number,
): AuditVerifyResult | null {
	const raw = rawLine.trim();
	if (!raw) return null;
	state.totalEvents += 1;

	const parsed = parseAuditRecord(raw);
	if (!parsed.ok) {
		return chainFailure(state, lineNumber, `invalid audit row at line ${lineNumber}: ${parsed.reason}`);
	}
	const { record } = parsed;
	const type = record.type as string;
	if (!CHAINED_AUDIT_TYPES.has(type)) return null;
	state.guardEvents += 1;

	const storedHash =
		typeof record.hash === "string" && record.hash.length === 64 ? record.hash : null;
	if (!storedHash) {
		state.unchainedGuardEvents += 1;
		return null;
	}

	const previousHash =
		typeof record.previousHash === "string" ? record.previousHash : "";
	const startsNewSegment = safeEqualHex(previousHash, GENESIS_HASH);
	if (!startsNewSegment && !safeEqualHex(previousHash, state.expectedPrev)) {
		return chainFailure(
			state,
			lineNumber,
			`previousHash mismatch at chained event #${state.chainedEvents}: expected ${state.expectedPrev.slice(0, 12)}… (or GENESIS to start a segment), got ${previousHash.slice(0, 12) || "(missing)"}…`,
		);
	}

	const expectedHash = computeEntryHash(record);
	if (!safeEqualHex(storedHash, expectedHash)) {
		return chainFailure(
			state,
			lineNumber,
			`hash mismatch at chained event #${state.chainedEvents}: payload yields ${expectedHash.slice(0, 12)}…, stored ${storedHash.slice(0, 12)}…`,
		);
	}

	state.chainedEvents += 1;
	state.expectedPrev = storedHash;
	state.lastHash = storedHash;
	return null;
}

function successfulChainResult(state: ChainWalkState): AuditVerifyResult {
	return {
		valid: true,
		total_events: state.totalEvents,
		guard_events: state.guardEvents,
		chained_events: state.chainedEvents,
		unchained_guard_events: state.unchainedGuardEvents,
		last_hash: state.lastHash,
	};
}

/** The chain walk over the combined archived + live line stream. */
function walkChain(lines: Iterable<string>): AuditVerifyResult {
	const state = newChainWalkState();
	let lineNumber = 0;
	for (const rawLine of lines) {
		lineNumber += 1;
		const failure = consumeAuditLine(state, rawLine, lineNumber);
		if (failure) return failure;
	}
	return successfulChainResult(state);
}

async function walkChainStreaming(lines: AsyncIterable<string>): Promise<AuditVerifyResult> {
	const state = newChainWalkState();
	let lineNumber = 0;
	for await (const rawLine of lines) {
		lineNumber += 1;
		const failure = consumeAuditLine(state, rawLine, lineNumber);
		if (failure) return failure;
	}
	return successfulChainResult(state);
}
