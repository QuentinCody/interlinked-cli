// ===========================================
// Plan Capture — parse + persist agent-emitted plans
// ===========================================
//
// Captures three plan sources:
//
//   1. PreToolUse `TaskCreate` events — Claude Code's `tool_input.tasks` is
//      an array of `{ content, activeForm }` objects. Each task becomes one
//      PlanStep with `intent = task.content`. Tool/target hints are left
//      undefined (TaskCreate is a free-form todo list, not a tool plan).
//
//   2. PreToolUse `ExitPlanMode` events — `tool_input.plan` is a markdown
//      string the agent emitted on leaving plan-mode. Markdown bullets
//      (`-`, `*`, `1.`) become PlanStep.intents. Best-effort `tool_hint` /
//      `target_hint` extraction recognizes common patterns like
//      "Edit src/foo.ts" → `Edit` + `src/foo.ts`, "Run npm test" → `Bash`.
//      Anything unclear leaves both hints undefined; we never guess.
//
//   3. UserPromptSubmit whose body contains a `## Plan` markdown section —
//      behind the `plan_capture.parse_userprompt` config flag (default OFF
//      to avoid double-counting agent vs. user plans). Bullets under that
//      heading become steps.
//
// All three flow through the same JSONL append:
// `.interlinked/plans/<session_id>.jsonl`. Replanning produces a NEW line
// (never edits prior lines). The most recent capture is mirrored into
// `session.declared_plan` so downstream Stop-time drift checks (PB&J item
// #6) and the future Tier 2 cloud Plan/Policy Approver can read it
// without re-parsing.
//
// NO EVALUATION here. This module captures and persists. Comparison
// against `session.tool_sequence` is item #6's responsibility.

import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { sanitizeSessionId } from "./session-paths.js";
import type {
	CapturedPlan,
	PlanSource,
	PlanStep,
} from "./types/plan.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

/** Directory inside `.interlinked/` where per-session plan logs live. */
const PLANS_DIR = "plans";

/** Cap on parsed steps per plan — long markdown blocks the model produces
 *  are mostly prose; a 200-step plan is almost always a parser failure
 *  mode dragging in unrelated bullets. Keeps memory + JSONL bounded. */
const MAX_STEPS_PER_PLAN = 200;

/** Cap on per-step intent text. Long-form bullets that wrap many lines
 *  are still captured (we join wrapped lines), but trimmed here. */
const MAX_INTENT_CHARS = 4_000;

// ===========================================
// Public entry points
// ===========================================

/**
 * Inspect a PreToolUse event for a TaskCreate or ExitPlanMode payload and,
 * if found, parse + persist the plan. No-op for any other tool. Returns
 * the captured plan when one was produced, or `null` otherwise. Errors
 * are swallowed (logged via the optional `log` callback) — plan capture
 * is best-effort observability, never the safety path.
 */
export async function maybeCaptureFromPreToolUse(opts: {
	event: HarnessEvent;
	session: SessionTrajectory;
	cwd: string;
	enabled: boolean;
	log?: ((msg: string) => void) | undefined;
}): Promise<CapturedPlan | null> {
	const { event, session, cwd, enabled, log } = opts;
	if (!enabled) return null;
	const toolName = event.tool_name;
	if (toolName === "TaskCreate") {
		const plan = parseTaskCreate(event, session);
		if (!plan) return null;
		return persistAndMirror({ plan, session, cwd, log });
	}
	if (toolName === "ExitPlanMode") {
		const plan = parseExitPlanMode(event, session);
		if (!plan) return null;
		return persistAndMirror({ plan, session, cwd, log });
	}
	return null;
}

/**
 * Inspect a UserPromptSubmit event for a structured `## Plan` markdown
 * section. Only fires when both `enabled` AND `parseUserPrompt` are true
 * — the default config is `parse_userprompt = false` because a user's
 * "here's my plan" is rarely the same shape as the agent's own plan and
 * conflating them would muddy item #6's drift comparison.
 */
export async function maybeCaptureFromUserPromptSubmit(opts: {
	event: HarnessEvent;
	session: SessionTrajectory;
	cwd: string;
	enabled: boolean;
	parseUserPrompt: boolean;
	log?: ((msg: string) => void) | undefined;
}): Promise<CapturedPlan | null> {
	const { event, session, cwd, enabled, parseUserPrompt, log } = opts;
	if (!enabled || !parseUserPrompt) return null;
	const promptText = extractUserPromptBody(event);
	if (!promptText) return null;
	const plan = parseStructuredUserPrompt(promptText, event, session);
	if (!plan) return null;
	return persistAndMirror({ plan, session, cwd, log });
}

// ===========================================
// Parsers
// ===========================================

/**
 * Claude Code's TaskCreate `tool_input.tasks` is an array of objects with
 * `content` and `activeForm` fields. Treats `content` as the canonical
 * intent and leaves both hints undefined (TaskCreate is a free-form
 * todo list — the agent rarely embeds a tool name in the content text).
 *
 * Returns null when the input is malformed or empty (no tasks, no
 * content fields, all entries non-objects).
 */
export function parseTaskCreate(
	event: HarnessEvent,
	session: SessionTrajectory,
): CapturedPlan | null {
	const tasks = event.tool_input?.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) return null;
	const steps: PlanStep[] = [];
	for (const raw of tasks) {
		if (steps.length >= MAX_STEPS_PER_PLAN) break;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const rec = raw as JsonObject;
		const content = typeof rec.content === "string" ? rec.content : null;
		if (!content) continue;
		const intent = content.trim().slice(0, MAX_INTENT_CHARS);
		if (!intent) continue;
		steps.push({ intent, status: "pending" });
	}
	if (steps.length === 0) return null;
	return buildPlan({
		session,
		event,
		source: "TaskCreate",
		steps,
	});
}

/**
 * Parse an ExitPlanMode `tool_input.plan` markdown string. Markdown
 * bullets (`-`, `*`, `1.`) become PlanStep intents; best-effort hint
 * extraction recognizes common imperatives at the start of a step. The
 * `## Plan` heading (if present) is not required — the whole body is
 * scanned for bullets.
 */
export function parseExitPlanMode(
	event: HarnessEvent,
	session: SessionTrajectory,
): CapturedPlan | null {
	const planText = event.tool_input?.plan;
	if (typeof planText !== "string" || planText.trim() === "") return null;
	const steps = parseMarkdownBullets(planText);
	if (steps.length === 0) return null;
	return buildPlan({
		session,
		event,
		source: "ExitPlanMode",
		steps,
	});
}

/**
 * Parse the body of a UserPromptSubmit event when it contains a `## Plan`
 * heading. Bullets BETWEEN that heading and the next `## ...` heading (or
 * end of body) are taken as steps. Returns null when no `## Plan`
 * heading is present or no bullets follow it.
 */
export function parseStructuredUserPrompt(
	body: string,
	event: HarnessEvent,
	session: SessionTrajectory,
): CapturedPlan | null {
	const section = extractPlanSection(body);
	if (!section) return null;
	const steps = parseMarkdownBullets(section);
	if (steps.length === 0) return null;
	return buildPlan({
		session,
		event,
		source: "structured_userprompt",
		steps,
	});
}

// ===========================================
// Markdown bullet parser
// ===========================================

/** Match `- `, `* `, `+ `, or `1.` / `12.` at start of a line (allowing
 *  leading whitespace). The captured group is the rest of the bullet
 *  text. We deliberately don't try to handle nested bullets — flatten
 *  everything to a single step list. */
const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;

/** Recognize a heading line (`#`, `##`, `###`, …) so we can stop a
 *  `## Plan` section at the next heading. */
const HEADING_RE = /^\s*#{1,6}\s+/;

/**
 * Tokenize a markdown blob into PlanStep entries. Lines that are not
 * bullets are ignored. Continuation lines (indented under a bullet
 * without a marker) are joined onto the previous step's intent with a
 * single space — common for wrapped paragraphs in the model's plans.
 */
export function parseMarkdownBullets(text: string): PlanStep[] {
	const lines = text.split(/\r?\n/);
	const steps: PlanStep[] = [];
	let currentIntent: string | null = null;

	const flush = (): void => {
		if (currentIntent === null) return;
		const intent = currentIntent.trim().slice(0, MAX_INTENT_CHARS);
		currentIntent = null;
		if (!intent) return;
		if (steps.length >= MAX_STEPS_PER_PLAN) return;
		const { tool_hint, target_hint } = extractHints(intent);
		const step: PlanStep = { intent, status: "pending" };
		if (tool_hint !== undefined) step.tool_hint = tool_hint;
		if (target_hint !== undefined) step.target_hint = target_hint;
		steps.push(step);
	};

	for (const line of lines) {
		const bulletMatch = BULLET_RE.exec(line);
		if (bulletMatch) {
			flush();
			currentIntent = bulletMatch[1] ?? "";
			continue;
		}
		// Stop a continuation when we hit a heading or a blank line
		const isHeading = HEADING_RE.test(line);
		const isBlank = line.trim() === "";
		if (isHeading || isBlank) {
			flush();
			continue;
		}
		// Continuation: append to current intent if any
		if (currentIntent !== null) {
			currentIntent = `${currentIntent} ${line.trim()}`.trim();
		}
	}
	flush();
	return steps;
}

/**
 * Pull out the body that follows a `## Plan` (case-insensitive) heading,
 * up to (but not including) the next heading at any level. Returns null
 * when no plan heading exists.
 */
export function extractPlanSection(body: string): string | null {
	const lines = body.split(/\r?\n/);
	let inPlan = false;
	const buf: string[] = [];
	for (const line of lines) {
		if (HEADING_RE.test(line)) {
			const headingText = line.replace(HEADING_RE, "").trim().toLowerCase();
			if (!inPlan && headingText === "plan") {
				inPlan = true;
				continue;
			}
			// Any subsequent heading closes the section
			if (inPlan) return buf.join("\n");
		}
		if (inPlan) buf.push(line);
	}
	return inPlan ? buf.join("\n") : null;
}

// ===========================================
// Hint extraction (best-effort)
// ===========================================

/** Imperatives that map cleanly to tool names. Order matters — longer
 *  / more specific prefixes first. Mappings are deliberately
 *  conservative: when in doubt, return undefined. */
const TOOL_HINT_PATTERNS: Array<{
	re: RegExp;
	tool: string;
	pathGroup?: number;
}> = [
	// Bash-shaped commands ("Run npm test", "Execute the test suite")
	{ re: /^(?:run|execute|invoke)\s+(.+)/i, tool: "Bash" },
	// Read-shaped imperatives ("Read src/foo.ts", "Open the file foo.ts")
	{ re: /^read\s+(?:the\s+file\s+)?([^\s]+\.[A-Za-z0-9]+)/i, tool: "Read", pathGroup: 1 },
	{ re: /^(?:open|inspect)\s+(?:the\s+file\s+)?([^\s]+\.[A-Za-z0-9]+)/i, tool: "Read", pathGroup: 1 },
	// Edit-shaped imperatives ("Edit src/foo.ts", "Modify foo.ts")
	{ re: /^(?:edit|modify|update|patch)\s+([^\s]+\.[A-Za-z0-9]+)/i, tool: "Edit", pathGroup: 1 },
	// Write-shaped imperatives ("Write src/foo.ts", "Create a new file foo.ts")
	{ re: /^(?:write|create)\s+(?:a new\s+file\s+|the\s+file\s+|new\s+file\s+)?([^\s]+\.[A-Za-z0-9]+)/i, tool: "Write", pathGroup: 1 },
	// Grep-shaped imperatives ("Search for foo in src/", "Grep for ...")
	{ re: /^(?:grep|search)\s+(?:for\s+)?/i, tool: "Grep" },
	// Glob-shaped imperatives ("List files matching ...")
	{ re: /^(?:list|find)\s+files/i, tool: "Glob" },
];

/**
 * Best-effort tool_hint / target_hint extraction from a single step's
 * intent text. Returns undefined for both when nothing matches —
 * downstream comparison code treats undefined hints as "any tool fine"
 * to avoid false drift findings.
 */
export function extractHints(intent: string): {
	tool_hint?: string;
	target_hint?: string;
} {
	const trimmed = intent.trim();
	for (const { re, tool, pathGroup } of TOOL_HINT_PATTERNS) {
		const match = re.exec(trimmed);
		if (!match) continue;
		const result: { tool_hint?: string; target_hint?: string } = { tool_hint: tool };
		if (pathGroup !== undefined) {
			const target = match[pathGroup];
			if (target) result.target_hint = target;
		}
		return result;
	}
	return {};
}

// ===========================================
// Persistence
// ===========================================

/**
 * Build the `.interlinked/plans/<sanitized session_id>.jsonl` path. The
 * `plans/` subdirectory is created lazily on first append.
 */
export function planLogPath(cwd: string, sessionId: string): string {
	const safeId = sanitizeSessionId(sessionId) || "unknown";
	return join(cwd, ".interlinked", PLANS_DIR, `${safeId}.jsonl`);
}

/**
 * Append a CapturedPlan as one JSONL line. Async fs/promises; the
 * `plans/` directory is created with mkdirSync (cheap, idempotent) so
 * the append doesn't race a missing-parent ENOENT on the first call.
 * Errors are reported via the `log` callback but never re-thrown —
 * plan capture must not block the harness reply path.
 */
export async function appendCapturedPlan(opts: {
	plan: CapturedPlan;
	cwd: string;
	log?: ((msg: string) => void) | undefined;
}): Promise<boolean> {
	const { plan, cwd, log } = opts;
	const path = planLogPath(cwd, plan.session_id);
	try {
		mkdirSync(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(plan)}\n`, "utf-8");
		return true;
	} catch (err) {
		log?.(
			`Plan capture: failed to append (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

// ===========================================
// Internal helpers
// ===========================================

interface BuildPlanInput {
	session: SessionTrajectory;
	event: HarnessEvent;
	source: PlanSource;
	steps: PlanStep[];
}

function buildPlan(input: BuildPlanInput): CapturedPlan {
	const { session, event, source, steps } = input;
	return {
		session_id: session.session_id,
		agent_name: event.agent_name || session.agent_name,
		created_at_iso: event.timestamp,
		created_at_step: session.tool_call_count,
		source,
		steps,
	};
}

async function persistAndMirror(opts: {
	plan: CapturedPlan;
	session: SessionTrajectory;
	cwd: string;
	log?: ((msg: string) => void) | undefined;
}): Promise<CapturedPlan> {
	const { plan, session, cwd, log } = opts;
	session.declared_plan = plan;
	await appendCapturedPlan({ plan, cwd, log });
	return plan;
}

/** Pull the prompt body off a UserPromptSubmit event. The canonical field
 *  is `event.prompt`, but the spec mentions `tool_input.user_prompt` as
 *  an alternate shape some runners use; check both. */
function extractUserPromptBody(event: HarnessEvent): string {
	if (typeof event.prompt === "string" && event.prompt.length > 0) {
		return event.prompt;
	}
	const ti = event.tool_input;
	if (ti && typeof ti.user_prompt === "string") return ti.user_prompt;
	if (ti && typeof ti.prompt === "string") return ti.prompt;
	return "";
}
