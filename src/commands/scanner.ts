// ===========================================
// interlinked scanner — toggle + audit + review the content scanner
// ===========================================
//
// The privacy filter (OPF content scanner) runs inside the harness and blocks
// PII/secrets from being written to disk, egressed, or ingested by tainting
// Read/Grep results. This command lets the user flip it on/off without
// restarting the harness — the harness hot-reloads `guard-rules.local.json`
// and stops invoking the scanner on the next tool call.
//
// `scanner review` is the second half of the WebFetch 3-way review loop:
// when the harness's WebFetch proxy detects PII in a fetched body, it
// stashes a `*.review.json` file under `.interlinked/scanner/pending/`.
// `scanner review` shows the user that file and writes the chosen
// `<key>.decision.json`, which the harness consumes on the next call to
// the same URL.
//
// Every toggle and review choice is recorded in
// `.interlinked/content-scanner.audit.jsonl` so a reviewer can answer
// "when was the filter off, and why?" — and the same for "who allowed
// what?". The audit log is append-only and survives harness restarts.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
	listPendingReviews,
	type ReviewDecision,
	writeDecision,
} from "../harness/content-scanner/review-files.js";
import { getConfigDir } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError, type OutputMode } from "../lib/output.js";
import type { StatusSnapshot, ToggleContext } from "./scanner-render.js";
import {
	isPickError,
	pickFlagDecision,
	REVIEW_DECISION_TO_ACTION,
	renderStatus,
	renderToggleResult,
	SKIP_DECISION,
} from "./scanner-render.js";
import {
	resolveReviewDecision,
	resolveTargetReview,
	type TargetReview,
} from "./scanner-review-steps.js";

const LOCAL_RULES_FILE = "guard-rules.local.json";
const AUDIT_LOG_FILE = "content-scanner.audit.jsonl";
const STATUS_FILE = "content-scanner.status";
/** typeof tag for an object — pulled out of the conditional so the
 *  linter's magic-literal rule passes. */
const TYPEOF_OBJECT = "object" as const;
/** Sentinel value for the toggle action — also a magic literal in the
 *  conditional that picks between flip and explicit set. */
const TOGGLE_ACTION = "toggle" as const;
const NO_CHANGE_ACTION = "no_change" as const;

export interface ScannerOptions {
	reason?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

export interface ScannerReviewOptions extends ScannerOptions {
	allow?: boolean;
	redact?: boolean;
	block?: boolean;
	key?: string;
}

export type AuditAction =
	| "enable"
	| "disable"
	| "toggle"
	| "no_change"
	| "review_allow"
	| "review_redact"
	| "review_block"
	| "review_skip";

export interface AuditEntry {
	ts: string;
	action: AuditAction;
	/** State transition for toggle actions (`from`/`to`). Omitted for
	 *  review actions, which have no on/off semantic. */
	from?: boolean | undefined;
	to?: boolean | undefined;
	actor: {
		user: string;
		host: string;
		tty: string | null;
		via: "cli";
	};
	reason: string | null;
}

interface BuildAuditEntryArgs {
	action: AuditAction;
	from?: boolean;
	to?: boolean;
	reason: string | null;
}

function getLocalRulesPath(cwd: string): string {
	return join(getConfigDir(cwd), LOCAL_RULES_FILE);
}

function getAuditLogPath(cwd: string): string {
	return join(getConfigDir(cwd), AUDIT_LOG_FILE);
}

function getStatusPath(cwd: string): string {
	return join(getConfigDir(cwd), STATUS_FILE);
}

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === TYPEOF_OBJECT && v !== null && !Array.isArray(v);
}

/** Read `.interlinked/guard-rules.local.json`, merge-write a new enabled flag.
 *  Returns the previous value so the caller can decide if this was a no-op. */
function writeEnabledFlag(cwd: string, enabled: boolean): { previous: boolean } {
	const path = getLocalRulesPath(cwd);
	let parsed: JsonObject = {};
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf-8");
			const obj: unknown = JSON.parse(raw);
			if (isPlainObject(obj)) {
				parsed = obj;
			}
		} catch (_err) {
			process.stderr.write(
				`[interlinked:scanner] Warning: ${path} was unparseable; overwriting.\n`,
			);
		}
	}

	const scannerBlock = isPlainObject(parsed.content_scanner) ? parsed.content_scanner : {};
	const previous = scannerBlock.enabled === true;
	scannerBlock.enabled = enabled;
	parsed.content_scanner = scannerBlock;

	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
	return { previous };
}

function resolveTty(): string | null {
	if (process.stdout.isTTY) {
		return process.env.SSH_TTY || process.env.TTY || null;
	}
	return null;
}

function appendAudit(cwd: string, entry: AuditEntry): void {
	const path = getAuditLogPath(cwd);
	try {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		process.stderr.write(
			`[interlinked:scanner] Warning: failed to write audit log (${err instanceof Error ? err.message : String(err)})\n`,
		);
	}
}

function buildAuditEntry(args: BuildAuditEntryArgs): AuditEntry {
	const info = userInfo();
	return {
		ts: new Date().toISOString(),
		action: args.action,
		from: args.from,
		to: args.to,
		actor: {
			user: info.username,
			host: hostname(),
			tty: resolveTty(),
			via: "cli",
		},
		reason: args.reason,
	};
}

function readCurrentEnabled(cwd: string): boolean {
	const path = getLocalRulesPath(cwd);
	if (!existsSync(path)) return false;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
		const block = raw.content_scanner as JsonObject | undefined;
		return block?.enabled === true;
	} catch (_) {
		return false;
	}
}

/** Resolve the audit action from a before/after pair. Separate helper because
 *  a nested ternary `a === b ? "no_change" : b ? "enable" : "disable"` reads
 *  worse than three named branches. */
function deriveAction(current: boolean, target: boolean): AuditAction {
	if (current === target) return NO_CHANGE_ACTION;
	return target ? "enable" : "disable";
}

async function applyToggle(
	cwd: string,
	desired: boolean | typeof TOGGLE_ACTION,
	opts: ScannerOptions,
): Promise<void> {
	const current = readCurrentEnabled(cwd);
	const target = desired === TOGGLE_ACTION ? !current : desired;
	const action = deriveAction(current, target);
	writeEnabledFlag(cwd, target);
	appendAudit(
		cwd,
		buildAuditEntry({ action, from: current, to: target, reason: opts.reason ?? null }),
	);

	const ctx: ToggleContext = {
		cwd,
		current,
		target,
		opts,
		localRulesPath: getLocalRulesPath(cwd),
		auditPath: getAuditLogPath(cwd),
	};
	const mode = getOutputMode(opts);
	const payload = {
		enabled: target,
		changed: current !== target,
		previous: current,
		audit_path: ctx.auditPath,
		reason: opts.reason ?? null,
		note: "Harness hot-reloads guard-rules.local.json — no restart needed for OFF. Toggling ON after a cold start requires 'interlinked harness restart' the first time only.",
	};

	output(mode, payload, {
		json: () => payload,
		short: () =>
			`${target ? "enabled" : "disabled"}${current === target ? " (no change)" : ""}`,
		normal: () => renderToggleResult(ctx),
	});
}

function runCommand<O extends ScannerOptions>(
	action: (opts: O) => Promise<void>,
	opts: O,
): Promise<void> {
	return action(opts).catch((err: unknown) => {
		outputError(getOutputMode(opts), err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}

export async function scannerOnCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), true, o), opts);
}

export async function scannerOffCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), false, o), opts);
}

export async function scannerToggleCommand(opts: ScannerOptions): Promise<void> {
	await runCommand((o) => applyToggle(process.cwd(), TOGGLE_ACTION, o), opts);
}

function readStatusFile(cwd: string): string | null {
	const path = getStatusPath(cwd);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8").trim();
	} catch (_) {
		return null;
	}
}

const AUDIT_ACTIONS = new Set<AuditAction>([
	"enable",
	"disable",
	"toggle",
	"no_change",
	"review_allow",
	"review_redact",
	"review_block",
	"review_skip",
]);

function isAuditAction(v: unknown): v is AuditAction {
	return typeof v === "string" && AUDIT_ACTIONS.has(v as AuditAction);
}

function parseAuditActor(value: unknown): AuditEntry["actor"] | null {
	if (!isPlainObject(value)) return null;
	const { user, host, tty, via } = value;
	if (typeof user !== "string") return null;
	if (typeof host !== "string") return null;
	if (tty !== null && typeof tty !== "string") return null;
	if (via !== "cli") return null;
	return { user, host, tty, via };
}

/** Boundary parser for one line of `content-scanner.audit.jsonl`. Returns
 *  null (never throws) so a single malformed row can be skipped without
 *  losing the rest of the tail — same "non-critical, skip it" contract the
 *  caller already had for JSON syntax errors. */
function parseAuditEntry(value: unknown): AuditEntry | null {
	if (!isPlainObject(value)) return null;
	const { ts, action, from, to, actor, reason } = value;
	if (typeof ts !== "string") return null;
	if (!isAuditAction(action)) return null;
	if (from !== undefined && typeof from !== "boolean") return null;
	if (to !== undefined && typeof to !== "boolean") return null;
	if (reason !== null && typeof reason !== "string") return null;
	const parsedActor = parseAuditActor(actor);
	if (!parsedActor) return null;
	return { ts, action, from, to, actor: parsedActor, reason };
}

function readLastAudit(cwd: string, n: number): AuditEntry[] {
	const path = getAuditLogPath(cwd);
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		const tail = lines.slice(-n);
		const entries: AuditEntry[] = [];
		for (const line of tail) {
			try {
				const value: unknown = JSON.parse(line);
				const entry = parseAuditEntry(value);
				if (entry) entries.push(entry);
			} catch (_) {
				// intentional: a single malformed audit row is non-critical; skip it
			}
		}
		return entries;
	} catch (_) {
		return [];
	}
}

export async function scannerStatusCommand(opts: ScannerOptions): Promise<void> {
	const cwd = process.cwd();
	const snapshot: StatusSnapshot = {
		enabled: readCurrentEnabled(cwd),
		runtime_status: readStatusFile(cwd),
		last_audit: readLastAudit(cwd, 5),
		local_rules_path: getLocalRulesPath(cwd),
		audit_path: getAuditLogPath(cwd),
	};

	const mode = getOutputMode(opts);
	output(mode, snapshot, {
		json: () => snapshot,
		short: () =>
			`${snapshot.enabled ? "on" : "off"} / ${snapshot.runtime_status ?? "unknown"}`,
		normal: () => renderStatus(snapshot),
	});
}

// ===========================================
// scanner review — second half of the WebFetch 3-way review loop
// ===========================================

interface ReviewResultPayload {
	pending: number;
	cache_key: string | null;
	decision: ReviewDecision | "skip" | null;
	url: string | null;
	finding_count: number;
	action: AuditAction | "none";
}

export async function scannerReviewCommand(opts: ScannerReviewOptions): Promise<void> {
	await runCommand(async (o: ScannerReviewOptions) => {
		const cwd = process.cwd();
		const mode = getOutputMode(o);
		const reviews = listPendingReviews(cwd);

		if (reviews.length === 0) {
			const payload: ReviewResultPayload = {
				pending: 0,
				cache_key: null,
				decision: null,
				url: null,
				finding_count: 0,
				action: "none",
			};
			output(mode, payload, {
				json: () => payload,
				short: () => "no pending reviews",
				normal: () => c.dim("No pending reviews."),
			});
			return;
		}

		const flagPick = pickFlagDecision(o);
		if (isPickError(flagPick)) {
			outputError(mode, flagPick.error);
			process.exitCode = 1;
			return;
		}

		const target = resolveTargetReview({ cwd, mode, reviews, key: o.key });
		if (target === null) return;

		const decision = await resolveReviewDecision(mode, flagPick, target);
		if (decision === null) return;

		recordReviewDecision({
			cwd,
			mode,
			pending: reviews.length,
			target,
			decision,
			reason: o.reason ?? null,
		});
	}, opts);
}

interface ReviewRecordContext {
	cwd: string;
	mode: OutputMode;
	/** How many reviews were pending when this one was picked. */
	pending: number;
	target: TargetReview;
	decision: ReviewDecision | "skip";
	reason: string | null;
}

/** Third stage of `scanner review`: write the decision file (unless the user
 *  skipped), append the audit entry, and report the outcome. */
function recordReviewDecision(ctx: ReviewRecordContext): void {
	const { cwd, mode, decision, reason } = ctx;
	const { key, review } = ctx.target;
	const action = REVIEW_DECISION_TO_ACTION[decision];
	const payload: ReviewResultPayload = {
		pending: ctx.pending,
		cache_key: key,
		decision,
		url: review.url,
		finding_count: review.findings.length,
		action,
	};

	// Skip leaves the review file in place. We still record the audit
	// entry so "I looked at this and deferred" is queryable later.
	if (decision === SKIP_DECISION) {
		appendAudit(cwd, buildAuditEntry({ action, reason }));
		output(mode, payload, {
			json: () => payload,
			short: () => SKIP_DECISION,
			normal: () => c.dim("Skipped — review left in place."),
		});
		return;
	}

	const info = userInfo();
	writeDecision({
		cwd,
		key,
		decision,
		actor: { user: info.username, host: hostname(), tty: resolveTty() },
	});
	appendAudit(cwd, buildAuditEntry({ action, reason }));

	output(mode, payload, {
		json: () => payload,
		short: () => decision,
		normal: () =>
			c.green(`Recorded: ${decision} for ${review.url} (${review.findings.length} finding(s))`) +
			`\n${c.dim("Re-invoke the WebFetch in your agent session to apply.")}`,
	});
}
