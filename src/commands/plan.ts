// ===========================================
// interlinked plan — show captured agent plans
// ===========================================
//
// Subcommands:
//   list                  Show the 20 most recent CapturedPlans across all
//                         sessions (newest first by created_at_iso).
//   show <session_id>     Pretty-print the most recent plan for one session.
//
// Plans are written by `src/harness/plan-capture.ts` to
// `.interlinked/plans/<session_id>.jsonl` (one CapturedPlan per line; the
// last line is the newest). Replanning produces a new line rather than
// editing prior ones — `show` returns the LAST valid line, `list` walks
// every file and sorts by created_at_iso desc.
//
// Pure read commands — no harness socket round-trip, no daemon needed.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { interlinkedPath } from "../lib/interlinked-path.js";
import type {
	CapturedPlan,
	PlanSource,
	PlanStep,
	PlanStepStatus,
} from "../harness/types/plan.js";
import type { JsonObject } from "../lib/json-types.js";

interface CommonOpts {
	cwd?: string;
	json?: boolean;
}

const PLANS_DIR_NAME = "plans";
const DEFAULT_LIST_LIMIT = 20;

const PLAN_SOURCES: ReadonlySet<PlanSource> = new Set([
	"TaskCreate",
	"ExitPlanMode",
	"structured_userprompt",
]);

const PLAN_STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set([
	"pending",
	"executed",
	"skipped",
]);

// ===========================================
// Public entry points
// ===========================================

export async function planListCommand(opts: CommonOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const plans = loadAllNewestPlans(cwd);
	plans.sort((a, b) => compareIsoDesc(a.created_at_iso, b.created_at_iso));
	const top = plans.slice(0, DEFAULT_LIST_LIMIT);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(top)}\n`);
		return;
	}
	if (top.length === 0) {
		process.stdout.write(
			"(no captured plans yet — TaskCreate / ExitPlanMode events will appear here once the harness sees them)\n",
		);
		return;
	}
	process.stdout.write(
		`${"WHEN".padEnd(22)}  ${"SESSION".padEnd(12)}  ${"AGENT".padEnd(18)}  ${"SOURCE".padEnd(22)}  STEPS\n`,
	);
	for (const plan of top) {
		const when = plan.created_at_iso.replace("T", " ").slice(0, 19);
		const session = plan.session_id.slice(0, 12);
		const agent = plan.agent_name.slice(0, 18);
		const source = plan.source;
		const steps = String(plan.steps.length);
		process.stdout.write(
			`${when.padEnd(22)}  ${session.padEnd(12)}  ${agent.padEnd(18)}  ${source.padEnd(22)}  ${steps}\n`,
		);
	}
	process.stdout.write("\n");
	process.stdout.write(
		`(${top.length} plan(s); run \`interlinked plan show <session_id>\` for details)\n`,
	);
}

export async function planShowCommand(
	sessionId: string | undefined,
	opts: CommonOpts,
): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const trimmed = sessionId?.trim();
	if (!trimmed) {
		process.stderr.write("error: <session_id> is required\n");
		process.stderr.write("Usage: interlinked plan show <session_id>\n");
		process.exitCode = 2;
		return;
	}
	const path = interlinkedPath(cwd, PLANS_DIR_NAME, `${trimmed}.jsonl`);
	if (!existsSync(path)) {
		const message = `No plan captured for session: ${trimmed}`;
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: false, error: message, session_id: trimmed })}\n`,
			);
		} else {
			process.stderr.write(`${message}\n`);
			process.stderr.write(
				"(run `interlinked plan list` to see known session ids)\n",
			);
		}
		process.exitCode = 1;
		return;
	}
	const plan = readNewestPlanFromFile(path);
	if (!plan) {
		const message = `Plan log for session ${trimmed} contained no valid entries.`;
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: false, error: message, session_id: trimmed })}\n`,
			);
		} else {
			process.stderr.write(`${message}\n`);
		}
		process.exitCode = 1;
		return;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(plan)}\n`);
		return;
	}
	process.stdout.write(`Plan for session: ${plan.session_id}\n`);
	process.stdout.write(`  Agent:      ${plan.agent_name}\n`);
	process.stdout.write(`  Captured:   ${plan.created_at_iso}\n`);
	process.stdout.write(`  At step:    ${plan.created_at_step}\n`);
	process.stdout.write(`  Source:     ${plan.source}\n`);
	process.stdout.write(`  Step count: ${plan.steps.length}\n`);
	process.stdout.write("\n");
	plan.steps.forEach((step, i) => {
		const indicator = statusIndicator(step.status);
		const num = String(i + 1).padStart(2);
		process.stdout.write(`  ${num}. ${indicator} ${step.intent}\n`);
		const meta: string[] = [];
		if (step.tool_hint) meta.push(`tool=${step.tool_hint}`);
		if (step.target_hint) meta.push(`target=${step.target_hint}`);
		if (meta.length > 0) {
			process.stdout.write(`      ${meta.join("  ")}\n`);
		}
	});
}

// ===========================================
// File loading
// ===========================================

/** Walk `.interlinked/plans/`, read each `<session>.jsonl`, and return
 *  the NEWEST CapturedPlan from each file. Files with no parseable
 *  entries are silently skipped. */
function loadAllNewestPlans(cwd: string): CapturedPlan[] {
	const dir = interlinkedPath(cwd, PLANS_DIR_NAME);
	if (!existsSync(dir)) return [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: CapturedPlan[] = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		try {
			const info = statSync(path);
			if (!info.isFile()) continue;
		} catch {
			continue;
		}
		const plan = readNewestPlanFromFile(path);
		if (plan) out.push(plan);
	}
	return out;
}

function readNewestPlanFromFile(path: string): CapturedPlan | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const lines = raw.split("\n");
	// Walk from the end backwards — first parseable line is the newest.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.trim()) continue;
		const plan = parsePlanLine(line);
		if (plan) return plan;
	}
	return null;
}

/** Defensive parser. Returns null when the line is malformed or fails
 *  shape validation — JSONL may be torn if a process died mid-write,
 *  and we never crash on bad input. */
function parsePlanLine(line: string): CapturedPlan | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const rec = parsed as JsonObject;
	const session_id = readString(rec.session_id);
	const agent_name = readString(rec.agent_name);
	const created_at_iso = readString(rec.created_at_iso);
	if (!session_id || !agent_name || !created_at_iso) return null;
	const sourceRaw = typeof rec.source === "string" ? rec.source : "";
	if (!PLAN_SOURCES.has(sourceRaw as PlanSource)) return null;
	return {
		session_id,
		agent_name,
		created_at_iso,
		created_at_step: readCreatedAtStep(rec.created_at_step),
		source: sourceRaw as PlanSource,
		steps: parsePlanSteps(rec.steps),
	};
}

/** Parses the `steps` array, dropping any entry that fails shape validation. */
function parsePlanSteps(stepsField: unknown): PlanStep[] {
	const stepsRaw = Array.isArray(stepsField) ? stepsField : [];
	const steps: PlanStep[] = [];
	for (const item of stepsRaw) {
		const step = parsePlanStep(item);
		if (step) steps.push(step);
	}
	return steps;
}

/** Parses one step record. Returns null when it is not an object or has no intent. */
function parsePlanStep(item: unknown): PlanStep | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const r = item as JsonObject;
	const intent = readString(r.intent);
	if (!intent) return null;
	const step: PlanStep = { intent, status: readPlanStepStatus(r.status) };
	const toolHint = readString(r.tool_hint);
	if (toolHint) step.tool_hint = toolHint;
	const targetHint = readString(r.target_hint);
	if (targetHint) step.target_hint = targetHint;
	return step;
}

/** Normalizes an unknown status field to a known status, defaulting to "pending". */
function readPlanStepStatus(v: unknown): PlanStepStatus {
	const statusRaw = typeof v === "string" ? v : "pending";
	return PLAN_STEP_STATUSES.has(statusRaw as PlanStepStatus)
		? (statusRaw as PlanStepStatus)
		: "pending";
}

/** Reads the numeric step counter, defaulting to 0 for missing or non-finite values. */
function readCreatedAtStep(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ===========================================
// Formatting helpers
// ===========================================

function statusIndicator(status: PlanStepStatus): string {
	switch (status) {
		case "executed":
			return "[x]";
		case "skipped":
			return "[-]";
		default:
			return "[ ]";
	}
}

function compareIsoDesc(a: string, b: string): number {
	const at = new Date(a).getTime();
	const bt = new Date(b).getTime();
	if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
	if (!Number.isFinite(at)) return 1;
	if (!Number.isFinite(bt)) return -1;
	return bt - at;
}

function readString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}
