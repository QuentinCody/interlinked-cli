// ===========================================
// Content Scanner — Review + Decision file lifecycle
// ===========================================
//
// Sibling to `redact-preview.ts`, kept separate so the prompt-side
// (PreToolUse Write/Edit/Bash ask-flow) and the response-side (PreToolUse
// WebFetch proxy 3-way review) don't share a writer. They have different
// schemas — the prompt-side carries scan parts; the response-side carries a
// fetched body — and bundling them would couple two unrelated change rates.
//
// File layout under `.interlinked/scanner/pending/`:
//   <key>.review.json      written when the proxy detects PII in a fetched body
//   <key>.decision.json    written by `interlinked scanner review` when the
//                          user picks allow / redact / block; consumed (and
//                          removed) by the proxy on the next invocation of the
//                          same URL
//
// `<key>` is `sha256(url + "\n" + prompt).slice(0,16)` — stable across re-runs
// of the same WebFetch, so the agent retrying after a CLI decision lands on
// the same file.
//
// Both files inherit the protections from commit 92aabc1: the `pending/**`
// glob is in `protected_files`, and `builtin-scanner-pending-access` blocks
// the long-tail (Bash/Grep/Glob) tools. The agent cannot read either file.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type { ScanFinding } from "./types.js";

const PENDING_DIR_PARTS = [".interlinked", "scanner", "pending"] as const;
const PENDING_FILE_MODE = 0o600;
const REVIEW_TTL_MS = 60 * 60 * 1000;

export type ReviewDecision = "allow" | "redact" | "block";

/** Stable cache key from `(url, prompt)`. 16 hex chars is plenty: 64 bits of
 *  collision space, and we only need uniqueness across a single user's
 *  pending dir — not against an adversary. */
export function cacheKey(url: string, prompt: string | undefined): string {
	return createHash("sha256")
		.update(`${url}\n${prompt ?? ""}`)
		.digest("hex")
		.slice(0, 16);
}

function pendingDir(cwd: string): string {
	return join(cwd, ...PENDING_DIR_PARTS);
}

function reviewPath(cwd: string, key: string): string {
	return join(pendingDir(cwd), `${key}.review.json`);
}

function decisionPath(cwd: string, key: string): string {
	return join(pendingDir(cwd), `${key}.decision.json`);
}

function ensureDir(cwd: string): boolean {
	const dir = pendingDir(cwd);
	if (existsSync(dir)) return true;
	try {
		mkdirSync(dir, { recursive: true });
		return true;
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] cannot create ${dir}: ${formatErr(err)}\n`,
		);
		return false;
	}
}

function formatErr(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ===========================================
// Review file (written by the proxy when PII is detected)
// ===========================================

export interface ReviewPayload {
	timestamp: string;
	url: string;
	prompt: string;
	tool_name: string;
	body: string;
	redacted_body: string;
	findings: ScanFinding[];
	cache_key: string;
}

interface WriteReviewArgs {
	cwd: string;
	key: string;
	url: string;
	prompt: string;
	toolName: string;
	body: string;
	redactedBody: string;
	findings: ScanFinding[];
}

function parseScanFinding(value: unknown): ScanFinding | null {
	if (!isJsonObject(value)) return null;
	const { label, start, end, text, source } = value;
	if (typeof label !== "string") return null;
	if (typeof start !== "number") return null;
	if (typeof end !== "number") return null;
	if (typeof text !== "string") return null;
	if (typeof source !== "string") return null;
	const score = value.score;
	return { label, start, end, text, source, score: typeof score === "number" ? score : undefined };
}

/** All-or-nothing: one malformed finding invalidates the whole array, matching
 *  the fail-closed posture of the unchecked cast this replaces (a torn/foreign
 *  file is rejected wholesale, not partially trusted). */
function parseScanFindings(value: unknown): ScanFinding[] | null {
	if (!Array.isArray(value)) return null;
	const findings: ScanFinding[] = [];
	for (const entry of value) {
		const finding = parseScanFinding(entry);
		if (!finding) return null;
		findings.push(finding);
	}
	return findings;
}

/**
 * Defensively narrow a parsed `<key>.review.json` body to a `ReviewPayload`,
 * or null for a torn/foreign file. The file is single-writer (`writeReview`
 * below is the only producer), but a validator earns its keep here anyway:
 * it's the only thing standing between a corrupted or hand-edited pending
 * file and every field-typed read the CLI does downstream.
 */
export function parseReviewPayload(value: unknown): ReviewPayload | null {
	if (!isJsonObject(value)) return null;
	const { timestamp, url, prompt, tool_name, body, redacted_body, findings, cache_key } = value;
	if (typeof timestamp !== "string") return null;
	if (typeof url !== "string") return null;
	if (typeof prompt !== "string") return null;
	if (typeof tool_name !== "string") return null;
	if (typeof body !== "string") return null;
	if (typeof redacted_body !== "string") return null;
	if (typeof cache_key !== "string") return null;
	const parsedFindings = parseScanFindings(findings);
	if (!parsedFindings) return null;
	return { timestamp, url, prompt, tool_name, body, redacted_body, findings: parsedFindings, cache_key };
}

/** Persist a review record for the user to inspect via `interlinked scanner
 *  review`. Returns the relative path on success, undefined on failure. */
export function writeReview(args: WriteReviewArgs): string | undefined {
	if (!ensureDir(args.cwd)) return undefined;
	pruneStale(args.cwd);
	const payload: ReviewPayload = {
		timestamp: new Date().toISOString(),
		url: args.url,
		prompt: args.prompt,
		tool_name: args.toolName,
		body: args.body,
		redacted_body: args.redactedBody,
		findings: args.findings,
		cache_key: args.key,
	};
	const abs = reviewPath(args.cwd, args.key);
	try {
		writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: PENDING_FILE_MODE,
		});
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] cannot write ${abs}: ${formatErr(err)}\n`,
		);
		return undefined;
	}
	return join(...PENDING_DIR_PARTS, `${args.key}.review.json`);
}

export function readReview(cwd: string, key: string): ReviewPayload | undefined {
	const abs = reviewPath(cwd, key);
	if (!existsSync(abs)) return undefined;
	try {
		const raw = readFileSync(abs, "utf-8");
		const payload = parseReviewPayload(JSON.parse(raw));
		if (!payload) {
			process.stderr.write(`[interlinked:scanner] malformed review payload ${abs}\n`);
			return undefined;
		}
		return payload;
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] cannot read review ${abs}: ${formatErr(err)}\n`,
		);
		return undefined;
	}
}

export interface PendingReviewSummary {
	key: string;
	path: string;
	timestamp: string;
	url: string;
	tool_name: string;
	finding_count: number;
}

/** List review files that don't yet have a sibling decision file. The CLI
 *  uses this to show the user the active review queue. Sorted newest-first. */
export function listPendingReviews(cwd: string): PendingReviewSummary[] {
	const dir = pendingDir(cwd);
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (readErr) {
		// Directory was removed between exists() and readdir() — caller will
		// just get an empty list, which is the right semantic.
		void readErr;
		return [];
	}
	const result: PendingReviewSummary[] = [];
	for (const name of entries) {
		if (!name.endsWith(".review.json")) continue;
		const key = name.slice(0, -".review.json".length);
		// Skip review files whose decision is already on disk — the CLI has
		// already handled them; the proxy will consume on the agent's next call.
		if (existsSync(decisionPath(cwd, key))) continue;
		const abs = join(dir, name);
		const review = readReview(cwd, key);
		if (!review) continue;
		result.push({
			key,
			path: abs,
			timestamp: review.timestamp,
			url: review.url,
			tool_name: review.tool_name,
			finding_count: review.findings.length,
		});
	}
	result.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
	return result;
}

/** Count of unresolved reviews — feeds the statusline indicator. */
export function countPendingReviews(cwd: string): number {
	return listPendingReviews(cwd).length;
}

// ===========================================
// Decision file (written by the CLI, consumed by the proxy)
// ===========================================

interface DecisionPayload {
	decision: ReviewDecision;
	timestamp: string;
	cache_key: string;
	actor: {
		user: string;
		host: string;
		tty: string | null;
	};
}

interface WriteDecisionArgs {
	cwd: string;
	key: string;
	decision: ReviewDecision;
	actor: DecisionPayload["actor"];
}

function isReviewDecision(value: unknown): value is ReviewDecision {
	return value === "allow" || value === "redact" || value === "block";
}

function parseDecisionActor(value: unknown): DecisionPayload["actor"] | null {
	if (!isJsonObject(value)) return null;
	const { user, host, tty } = value;
	if (typeof user !== "string") return null;
	if (typeof host !== "string") return null;
	if (tty !== null && typeof tty !== "string") return null;
	return { user, host, tty };
}

/** Defensively narrow a parsed `<key>.decision.json` body to a
 *  `DecisionPayload`, or null for a torn/foreign file — same rationale as
 *  `parseReviewPayload` above. */
export function parseDecisionPayload(value: unknown): DecisionPayload | null {
	if (!isJsonObject(value)) return null;
	const { decision, timestamp, cache_key, actor } = value;
	if (!isReviewDecision(decision)) return null;
	if (typeof timestamp !== "string") return null;
	if (typeof cache_key !== "string") return null;
	const parsedActor = parseDecisionActor(actor);
	if (!parsedActor) return null;
	return { decision, timestamp, cache_key, actor: parsedActor };
}

export function writeDecision(args: WriteDecisionArgs): string | undefined {
	if (!ensureDir(args.cwd)) return undefined;
	const payload: DecisionPayload = {
		decision: args.decision,
		timestamp: new Date().toISOString(),
		cache_key: args.key,
		actor: args.actor,
	};
	const abs = decisionPath(args.cwd, args.key);
	try {
		writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: PENDING_FILE_MODE,
		});
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] cannot write ${abs}: ${formatErr(err)}\n`,
		);
		return undefined;
	}
	return abs;
}

/** Returns undefined when no decision has been recorded yet — that's the
 *  steady state and not an error. */
export function readDecision(cwd: string, key: string): DecisionPayload | undefined {
	const abs = decisionPath(cwd, key);
	if (!existsSync(abs)) return undefined;
	try {
		const raw = readFileSync(abs, "utf-8");
		const payload = parseDecisionPayload(JSON.parse(raw));
		if (!payload) {
			process.stderr.write(`[interlinked:scanner] malformed decision payload ${abs}\n`);
			return undefined;
		}
		return payload;
	} catch (err) {
		// A corrupt decision file should not pin the user — fall through to a
		// fresh review. Surface the parse error so the operator sees it.
		process.stderr.write(
			`[interlinked:scanner] cannot read decision ${abs}: ${formatErr(err)}\n`,
		);
		return undefined;
	}
}

/** Remove both the review and decision files for `key`. Used by the proxy
 *  after a decision has been applied so the next WebFetch with the same key
 *  doesn't silently reuse the old verdict. */
export function consumeDecision(cwd: string, key: string): void {
	for (const abs of [reviewPath(cwd, key), decisionPath(cwd, key)]) {
		try {
			if (existsSync(abs)) unlinkSync(abs);
		} catch (unlinkErr) {
			// stat/unlink races with the CLI writer — log once and move on; the
			// orphaned file will be picked up by the next pruneStale pass.
			void unlinkErr;
		}
	}
}

// ===========================================
// Internals
// ===========================================

/** Best-effort GC: delete review/decision files older than REVIEW_TTL_MS.
 *  Runs on every write so we don't need a separate timer. Same shape as
 *  `pruneStale` in redact-preview.ts. */
function pruneStale(cwd: string): void {
	const dir = pendingDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (readErr) {
		// Directory doesn't exist yet (first scan ever) — nothing to prune.
		void readErr;
		return;
	}
	const cutoff = Date.now() - REVIEW_TTL_MS;
	for (const name of entries) {
		if (!name.endsWith(".review.json") && !name.endsWith(".decision.json")) continue;
		const p = join(dir, name);
		try {
			if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
		} catch (statErr) {
			// stat/unlink races with concurrent readers — skip this entry silently.
			void statErr;
		}
	}
}
