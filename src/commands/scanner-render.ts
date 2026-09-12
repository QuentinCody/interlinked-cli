// interlinked-tdd: exempt
// ===========================================
// scanner presentation + review helpers — pure formatters and the
// pick/prompt logic for the WebFetch 3-way review loop. Extracted from
// scanner.ts as a leaf cluster: every function here is consumed by a
// scanner command but none of them call back into the toggle/status/audit
// I/O in the main module, so there is no import cycle.
// ===========================================

import { createInterface } from "node:readline/promises";
import type {
	PendingReviewSummary,
	ReviewDecision,
	ReviewPayload,
} from "../harness/content-scanner/review-files.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import type {
	AuditAction,
	AuditEntry,
	ScannerOptions,
	ScannerReviewOptions,
} from "./scanner.js";

/** typeof tag for an object — inlined here (rather than imported from
 *  scanner.ts) so this sibling has no runtime dependency back on the main
 *  module; importing a runtime value would form an import cycle. */

export interface ToggleContext {
	cwd: string;
	current: boolean;
	target: boolean;
	opts: ScannerOptions;
	localRulesPath: string;
	auditPath: string;
}

export function renderToggleResult(ctx: ToggleContext): string {
	const unchanged = ctx.current === ctx.target;
	const lines: string[] = [];
	if (ctx.target) {
		lines.push(c.green(`PII filter: ENABLED${unchanged ? " (already on)" : ""}`));
	} else {
		lines.push(c.yellow(`PII filter: DISABLED${unchanged ? " (already off)" : ""}`));
	}
	if (!unchanged) {
		lines.push(c.dim(`  wrote: ${ctx.localRulesPath}`));
		lines.push(c.dim(`  audit: ${ctx.auditPath}`));
	}
	if (ctx.opts.reason) lines.push(c.dim(`  reason: ${ctx.opts.reason}`));
	if (!unchanged) {
		lines.push(
			c.dim("  the harness will pick this up on its next config watch event (usually <1s)."),
		);
	}
	return lines.join("\n");
}

export interface StatusSnapshot {
	enabled: boolean;
	runtime_status: string | null;
	last_audit: AuditEntry[];
	local_rules_path: string;
	audit_path: string;
}

/** Prefix on every review-action audit entry. Reviews don't have an
 *  on/off transition, so the renderer branches on this rather than
 *  pretending `from`/`to` are meaningful. */
const REVIEW_ACTION_PREFIX = "review_";

/** Map a single audit entry to a one-cell summary suitable for the
 *  "Recent Activity" line. Toggle entries show `off → on`; review
 *  entries show `review: <decision>`; no-op toggles show `no-change`. */
function formatAuditDelta(entry: AuditEntry): string {
	if (entry.action.startsWith(REVIEW_ACTION_PREFIX)) {
		const verb = entry.action.slice(REVIEW_ACTION_PREFIX.length);
		return c.cyan(`review: ${verb}`);
	}
	if (entry.action === "no_change") return c.dim("no-change");
	return `${entry.from ? "on" : "off"} → ${entry.to ? "on" : "off"}`;
}

export function renderStatus(s: StatusSnapshot): string {
	const lines: string[] = [];
	lines.push(header("PII Filter"));
	lines.push(kvLine("Enabled", s.enabled ? c.green("yes") : c.yellow("no")));
	lines.push(
		kvLine(
			"Runtime",
			s.runtime_status ? c.dim(s.runtime_status) : c.dim("(harness not writing status)"),
		),
	);
	lines.push(kvLine("Config", c.dim(s.local_rules_path)));
	lines.push(kvLine("Audit", c.dim(s.audit_path)));
	if (s.last_audit.length === 0) return lines.join("\n");
	lines.push("");
	// Header changed from "Recent Toggle History" → "Recent Activity"
	// because the audit log now also carries review_allow/redact/block/skip
	// entries. Mixing them under a "Toggle" header was actively misleading.
	lines.push(header("Recent Activity"));
	for (const entry of s.last_audit) {
		const reason = entry.reason ? c.dim(` — ${entry.reason}`) : "";
		lines.push(
			`  ${c.dim(entry.ts)}  ${formatAuditDelta(entry)}  by ${entry.actor.user}${reason}`,
		);
	}
	return lines.join("\n");
}

// ===========================================
// scanner review — picking, prompting, and rendering the review body
// ===========================================

/** Sentinel for the "leave the review unresolved" choice. Not a real
 *  decision — it just records an audit entry without writing a
 *  `*.decision.json` file. */
export const SKIP_DECISION = "skip" as const;

type ReviewChoice = ReviewDecision | typeof SKIP_DECISION;

export const REVIEW_DECISION_TO_ACTION: Record<ReviewChoice, AuditAction> = {
	allow: "review_allow",
	redact: "review_redact",
	block: "review_block",
	skip: "review_skip",
};

const REVIEW_PROMPT = "[a]llow / [r]edact / [b]lock / [s]kip";

interface PickError {
	error: string;
}

export function isPickError(v: unknown): v is PickError {
	return isJsonObject(v) && typeof v.error === "string";
}

/** Pick a review by --key, otherwise return the first (newest) pending. */
export function pickReview(
	reviews: PendingReviewSummary[],
	key: string | undefined,
): PendingReviewSummary | PickError | null {
	if (reviews.length === 0) return null;
	if (key) {
		const match = reviews.find((r) => r.key === key);
		if (!match) return { error: `no pending review with key "${key}"` };
		return match;
	}
	return nonNull(reviews[0]); // The empty queue returned above.
}

/** Reject conflicting decision flags up front. Cleaner than implicit
 *  precedence (allow wins over block, etc.) — surprising precedence is
 *  the kind of thing you find out about by leaking PII. */
export function pickFlagDecision(
	opts: ScannerReviewOptions,
): ReviewDecision | undefined | PickError {
	const candidates = [opts.allow && "allow", opts.redact && "redact", opts.block && "block"] as const;
	const flags = candidates.filter((value) => typeof value === "string");
	if (flags.length === 0) return undefined;
	if (flags.length > 1) {
		return { error: `conflicting flags: ${flags.join(", ")} — pick one` };
	}
	return flags[0];
}

export async function promptForDecision(): Promise<ReviewDecision | "skip"> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const raw = (await rl.question(`${REVIEW_PROMPT}: `)).trim().toLowerCase();
		if (raw.startsWith("a")) return "allow";
		if (raw.startsWith("r")) return "redact";
		if (raw.startsWith("b")) return "block";
		return "skip";
	} finally {
		rl.close();
	}
}

export function renderReview(review: ReviewPayload): string {
	const lines: string[] = [];
	lines.push(header("Privacy Filter — Review"));
	lines.push(kvLine("URL", review.url));
	if (review.prompt) lines.push(kvLine("Prompt", review.prompt));
	lines.push(kvLine("Findings", String(review.findings.length)));
	lines.push(kvLine("Categories", c.yellow(formatCategories(review))));
	lines.push("");
	lines.push(header("Body (PII highlighted)"));
	lines.push(highlightFindings(review));
	lines.push("");
	lines.push(c.dim("This body is rendered locally and was NOT sent to the model."));
	return lines.join("\n");
}

function formatCategories(review: ReviewPayload): string {
	const counts = new Map<string, number>();
	for (const f of review.findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, n]) => `${label}(${n})`)
		.join(", ");
}

/** Splice the original body so each finding's text is wrapped in red ANSI
 *  + the `<LABEL>` suffix. Splices from the end so earlier indices stay
 *  valid during iteration. */
function highlightFindings(review: ReviewPayload): string {
	const sorted = [...review.findings].sort((a, b) => b.start - a.start);
	let result = review.body;
	for (const span of sorted) {
		const original = result.slice(span.start, span.end);
		const tag = c.dim(` <${span.label.toUpperCase()}>`);
		result = result.slice(0, span.start) + c.red(original) + tag + result.slice(span.end);
	}
	return result;
}
