// ===========================================
// plan-capture — parser + persistence regression suite
// ===========================================
//
// Pins the two PreToolUse parsers (TaskCreate / ExitPlanMode), the
// structured UserPromptSubmit parser, the JSONL append helper, the
// session.declared_plan mirror, and the serialize/hydrate round-trip
// (with backward-compat for snapshots predating the field).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	appendCapturedPlan,
	extractHints,
	extractPlanSection,
	maybeCaptureFromPreToolUse,
	maybeCaptureFromUserPromptSubmit,
	parseExitPlanMode,
	parseMarkdownBullets,
	parseStructuredUserPrompt,
	parseTaskCreate,
	planLogPath,
} from "../plan-capture.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";

const TIMESTAMP = "2026-04-23T00:00:00.000Z";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-plan-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const tracker = new SessionTracker();
	const session = tracker.recordEvent({
		hook_event: "SessionStart",
		session_id: overrides.session_id ?? "sess-1",
		agent_source: "claude",
		agent_name: overrides.agent_name ?? "agent-claude",
		timestamp: TIMESTAMP,
	});
	if (overrides.tool_call_count !== undefined) {
		session.tool_call_count = overrides.tool_call_count;
	}
	return session;
}

function preEvent(partial: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		agent_name: "agent-claude",
		timestamp: TIMESTAMP,
		...partial,
	};
}

describe("parseTaskCreate", () => {
	it("parses a Claude Code TaskCreate.tasks array into PlanSteps", () => {
		const session = makeSession({ tool_call_count: 3 });
		const event = preEvent({
			tool_name: "TaskCreate",
			tool_input: {
				tasks: [
					{ content: "Read src/foo.ts", activeForm: "Reading src/foo.ts" },
					{ content: "Edit src/foo.ts to fix the bug", activeForm: "Editing" },
					{ content: "Run npm test", activeForm: "Running tests" },
				],
			},
		});
		const plan = parseTaskCreate(event, session);
		expect(plan).not.toBeNull();
		const p = plan as NonNullable<typeof plan>;
		expect(p.session_id).toBe("sess-1");
		expect(p.agent_name).toBe("agent-claude");
		expect(p.created_at_iso).toBe(TIMESTAMP);
		expect(p.created_at_step).toBe(3);
		expect(p.source).toBe("TaskCreate");
		expect(p.steps).toHaveLength(3);
		expect(p.steps[0]).toEqual({
			intent: "Read src/foo.ts",
			status: "pending",
		});
		// TaskCreate.steps must NOT auto-populate hints — the content is
		// agent prose, not a tool plan.
		expect(nonNull(p.steps[0]).tool_hint).toBeUndefined();
		expect(nonNull(p.steps[1]).target_hint).toBeUndefined();
	});

	it("returns null on an empty / malformed TaskCreate payload", () => {
		const session = makeSession();
		expect(parseTaskCreate(preEvent({ tool_name: "TaskCreate", tool_input: {} }), session)).toBeNull();
		expect(
			parseTaskCreate(
				preEvent({ tool_name: "TaskCreate", tool_input: { tasks: [] } }),
				session,
			),
		).toBeNull();
		// tasks contains non-objects → no parseable steps → null
		expect(
			parseTaskCreate(
				preEvent({
					tool_name: "TaskCreate",
					tool_input: { tasks: [null, "bare string", 7] as unknown[] },
				}),
				session,
			),
		).toBeNull();
	});

	it("skips entries with non-string or whitespace-only content, keeps valid ones", () => {
		const session = makeSession();
		const plan = parseTaskCreate(
			preEvent({
				tool_name: "TaskCreate",
				tool_input: {
					tasks: [
						{ content: 5, activeForm: "" }, // non-string content → dropped
						{ content: "   ", activeForm: "" }, // trims to empty → dropped
						{ content: "keep this one", activeForm: "" },
					],
				},
			}),
			session,
		);
		expect(plan).not.toBeNull();
		expect(plan?.steps.map((s) => s.intent)).toEqual(["keep this one"]);
	});

	it("caps parsed steps at MAX_STEPS_PER_PLAN", () => {
		const session = makeSession();
		const tasks = Array.from({ length: 205 }, (_, i) => ({
			content: `step ${i}`,
			activeForm: "",
		}));
		const plan = parseTaskCreate(
			preEvent({ tool_name: "TaskCreate", tool_input: { tasks } }),
			session,
		);
		expect(plan?.steps).toHaveLength(200);
		expect(nonNull(plan?.steps[199]).intent).toBe("step 199");
	});
});

describe("parseExitPlanMode", () => {
	it("parses markdown bullets in tool_input.plan", () => {
		const session = makeSession();
		const event = preEvent({
			tool_name: "ExitPlanMode",
			tool_input: {
				plan:
					"## Plan\n\n" +
					"- First, read src/foo.ts\n" +
					"- Then edit src/foo.ts to add the missing import\n" +
					"- Finally run npm test\n",
			},
		});
		const plan = parseExitPlanMode(event, session);
		expect(plan).not.toBeNull();
		const p = plan as NonNullable<typeof plan>;
		expect(p.source).toBe("ExitPlanMode");
		expect(p.steps).toHaveLength(3);
		expect(nonNull(p.steps[0]).intent).toContain("read src/foo.ts");
	});

	it("extracts tool_hint and target_hint from common imperatives", () => {
		const session = makeSession();
		const event = preEvent({
			tool_name: "ExitPlanMode",
			tool_input: {
				plan:
					"- Read src/foo.ts\n" +
					"- Edit src/bar.ts\n" +
					"- Write src/new.ts\n" +
					"- Run npm test\n",
			},
		});
		const plan = parseExitPlanMode(event, session) as NonNullable<
			ReturnType<typeof parseExitPlanMode>
		>;
		expect(nonNull(plan.steps[0]).tool_hint).toBe("Read");
		expect(nonNull(plan.steps[0]).target_hint).toBe("src/foo.ts");
		expect(nonNull(plan.steps[1]).tool_hint).toBe("Edit");
		expect(nonNull(plan.steps[1]).target_hint).toBe("src/bar.ts");
		expect(nonNull(plan.steps[2]).tool_hint).toBe("Write");
		expect(nonNull(plan.steps[2]).target_hint).toBe("src/new.ts");
		expect(nonNull(plan.steps[3]).tool_hint).toBe("Bash");
		// Bash steps deliberately don't capture target_hint (the rest of
		// the command is arbitrary shell, not a single file path).
		expect(nonNull(plan.steps[3]).target_hint).toBeUndefined();
	});

	it("returns null on missing / empty / non-string plan", () => {
		const session = makeSession();
		expect(parseExitPlanMode(preEvent({ tool_name: "ExitPlanMode", tool_input: {} }), session))
			.toBeNull();
		expect(
			parseExitPlanMode(
				preEvent({ tool_name: "ExitPlanMode", tool_input: { plan: "" } }),
				session,
			),
		).toBeNull();
		expect(
			parseExitPlanMode(
				preEvent({ tool_name: "ExitPlanMode", tool_input: { plan: "   \n  \n" } }),
				session,
			),
		).toBeNull();
	});

	it("returns null when the plan text has no markdown bullets at all", () => {
		const session = makeSession();
		expect(
			parseExitPlanMode(
				preEvent({
					tool_name: "ExitPlanMode",
					tool_input: { plan: "just prose, no bullets here\n" },
				}),
				session,
			),
		).toBeNull();
	});
});

describe("parseMarkdownBullets / extractPlanSection", () => {
	it("handles `-`, `*`, and `1.` bullet markers", () => {
		const steps = parseMarkdownBullets(
			"- alpha\n* beta\n1. gamma\n+ delta\n",
		);
		expect(steps.map((s) => s.intent)).toEqual(["alpha", "beta", "gamma", "delta"]);
	});

	it("treats continuation lines as part of the previous bullet", () => {
		const steps = parseMarkdownBullets("- first line\n  continued text\n  more text\n- second\n");
		expect(nonNull(steps[0]).intent).toContain("first line");
		expect(nonNull(steps[0]).intent).toContain("continued text");
		expect(nonNull(steps[0]).intent).toContain("more text");
		expect(nonNull(steps[1]).intent).toBe("second");
	});

	it("extractPlanSection pulls the body under a `## Plan` heading", () => {
		const body =
			"intro text\n\n## Plan\n- step a\n- step b\n\n## Other\n- ignored\n";
		const section = extractPlanSection(body);
		expect(section).not.toBeNull();
		expect(section).toContain("step a");
		expect(section).toContain("step b");
		expect(section).not.toContain("ignored");
	});

	it("extractPlanSection returns null when no `## Plan` heading", () => {
		expect(extractPlanSection("just text\n- bullet\n")).toBeNull();
	});

	it("extractPlanSection ignores a heading before the `## Plan` section closes it", () => {
		const body = "## Intro\nnot a plan\n\n## Plan\n- step a\n";
		const section = extractPlanSection(body);
		expect(section).not.toBeNull();
		expect(section).toContain("step a");
		expect(section).not.toContain("not a plan");
	});

	it("drops a bullet whose text is empty after trimming", () => {
		const steps = parseMarkdownBullets("- \n- real step\n");
		expect(steps.map((s) => s.intent)).toEqual(["real step"]);
	});

	it("ignores prose lines before the first bullet (no dangling continuation)", () => {
		const steps = parseMarkdownBullets("just some prose\n- first bullet\n");
		expect(steps.map((s) => s.intent)).toEqual(["first bullet"]);
	});

	it("caps captured steps at MAX_STEPS_PER_PLAN", () => {
		const bullets = Array.from({ length: 205 }, (_, i) => `- step ${i}`).join("\n");
		const steps = parseMarkdownBullets(bullets);
		expect(steps).toHaveLength(200);
		expect(nonNull(steps[0]).intent).toBe("step 0");
		expect(nonNull(steps[199]).intent).toBe("step 199");
	});

	it("extractHints maps known imperatives, leaves undefined otherwise", () => {
		expect(extractHints("Run npm test")).toEqual({ tool_hint: "Bash" });
		expect(extractHints("Edit src/foo.ts")).toEqual({
			tool_hint: "Edit",
			target_hint: "src/foo.ts",
		});
		expect(extractHints("Investigate the failing path")).toEqual({});
	});
});

describe("parseStructuredUserPrompt", () => {
	it("parses a structured `## Plan` block from the prompt body", () => {
		const session = makeSession();
		const body = "Hi! Here's what I want:\n\n## Plan\n- check the bug\n- fix the bug\n";
		const event: HarnessEvent = {
			hook_event: "UserPromptSubmit",
			session_id: "sess-1",
			agent_source: "claude",
			agent_name: "agent-claude",
			timestamp: TIMESTAMP,
			prompt: body,
		};
		const plan = parseStructuredUserPrompt(body, event, session);
		expect(plan).not.toBeNull();
		expect(plan?.source).toBe("structured_userprompt");
		expect(plan?.steps).toHaveLength(2);
	});

	it("returns null when the `## Plan` section has no bullets", () => {
		const session = makeSession();
		const body = "## Plan\njust prose under the heading, no bullets\n";
		const event: HarnessEvent = {
			hook_event: "UserPromptSubmit",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: TIMESTAMP,
			prompt: body,
		};
		expect(parseStructuredUserPrompt(body, event, session)).toBeNull();
	});

	it("returns null when the prompt has no `## Plan` section", () => {
		const session = makeSession();
		const body = "Just a free-form ask, no plan structure.";
		const event: HarnessEvent = {
			hook_event: "UserPromptSubmit",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: TIMESTAMP,
			prompt: body,
		};
		expect(parseStructuredUserPrompt(body, event, session)).toBeNull();
	});
});

describe("appendCapturedPlan persistence", () => {
	it("writes plan-log JSONL to .interlinked/plans/<session_id>.jsonl", async () => {
		const session = makeSession({ tool_call_count: 5 });
		const event = preEvent({
			tool_name: "TaskCreate",
			tool_input: { tasks: [{ content: "step one", activeForm: "one" }] },
		});
		const plan = parseTaskCreate(event, session);
		expect(plan).not.toBeNull();
		const wrote = await appendCapturedPlan({ plan: plan!, cwd: tmp });
		expect(wrote).toBe(true);
		const path = planLogPath(tmp, "sess-1");
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(nonNull(lines[0]));
		expect(parsed.session_id).toBe("sess-1");
		expect(parsed.steps[0].intent).toBe("step one");
	});

	it("replanning appends a NEW line (never edits prior) and mirrors newest into session.declared_plan", async () => {
		const session = makeSession();
		const first = await maybeCaptureFromPreToolUse({
			event: preEvent({
				tool_name: "TaskCreate",
				tool_input: { tasks: [{ content: "first plan", activeForm: "" }] },
			}),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(first).not.toBeNull();
		expect(nonNull(session.declared_plan?.steps[0]).intent).toBe("first plan");
		const second = await maybeCaptureFromPreToolUse({
			event: preEvent({
				tool_name: "TaskCreate",
				tool_input: {
					tasks: [
						{ content: "first plan", activeForm: "" },
						{ content: "added second step", activeForm: "" },
					],
				},
			}),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(second).not.toBeNull();
		expect(session.declared_plan?.steps).toHaveLength(2);
		const lines = readFileSync(planLogPath(tmp, "sess-1"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(nonNull(lines[0])).steps).toHaveLength(1);
		expect(JSON.parse(nonNull(lines[1])).steps).toHaveLength(2);
	});

	it("appendCapturedPlan returns false and logs when the target path can't be created", async () => {
		const { writeFileSync } = await import("node:fs");
		const blockerFile = join(tmp, "blocker");
		writeFileSync(blockerFile, "not a directory");
		const plan = parseTaskCreate(
			preEvent({
				tool_name: "TaskCreate",
				tool_input: { tasks: [{ content: "step one", activeForm: "" }] },
			}),
			makeSession(),
		);
		expect(plan).not.toBeNull();
		const logged: string[] = [];
		const wrote = await appendCapturedPlan({
			plan: plan!,
			cwd: blockerFile, // a file, not a dir — mkdirSync(dirname(path)) fails ENOTDIR
			log: (msg) => logged.push(msg),
		});
		expect(wrote).toBe(false);
		expect(logged).toHaveLength(1);
		expect(nonNull(logged[0])).toContain("failed to append");
	});

	it("appendCapturedPlan swallows the failure silently when no log callback is given", async () => {
		const { writeFileSync } = await import("node:fs");
		const blockerFile2 = join(tmp, "blocker2");
		writeFileSync(blockerFile2, "not a directory");
		const plan = parseTaskCreate(
			preEvent({
				tool_name: "TaskCreate",
				tool_input: { tasks: [{ content: "step one", activeForm: "" }] },
			}),
			makeSession(),
		);
		expect(plan).not.toBeNull();
		const wrote = await appendCapturedPlan({ plan: plan!, cwd: blockerFile2 });
		expect(wrote).toBe(false);
	});

	it("planLogPath falls back to 'unknown' when the session id sanitizes to empty", () => {
		expect(planLogPath(tmp, "")).toBe(join(tmp, ".interlinked", "plans", "unknown.jsonl"));
	});

	it("config-disabled UserPromptSubmit does NOT capture", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				prompt: "## Plan\n- do thing\n",
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: false,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
		expect(existsSync(planLogPath(tmp, "sess-1"))).toBe(false);
	});

	it("config-enabled UserPromptSubmit DOES capture when prompt has `## Plan`", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				prompt: "## Plan\n- do thing\n- do other thing\n",
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).not.toBeNull();
		expect(captured?.steps).toHaveLength(2);
		expect(captured?.source).toBe("structured_userprompt");
		expect(session.declared_plan?.steps).toHaveLength(2);
	});

	it("falls back to tool_input.user_prompt when event.prompt is absent", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				tool_input: { user_prompt: "## Plan\n- from user_prompt field\n" },
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).not.toBeNull();
		expect(nonNull(captured?.steps[0]).intent).toBe("from user_prompt field");
	});

	it("falls back to tool_input.prompt when event.prompt and user_prompt are absent", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				tool_input: { prompt: "## Plan\n- from tool_input.prompt field\n" },
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).not.toBeNull();
		expect(nonNull(captured?.steps[0]).intent).toBe("from tool_input.prompt field");
	});

	it("returns null when no prompt body can be found anywhere on the event", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).toBeNull();
	});

	it("maybeCaptureFromPreToolUse short-circuits when enabled=false", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromPreToolUse({
			event: preEvent({
				tool_name: "TaskCreate",
				tool_input: { tasks: [{ content: "x", activeForm: "" }] },
			}),
			session,
			cwd: tmp,
			enabled: false,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
	});

	it("maybeCaptureFromPreToolUse returns null for a malformed TaskCreate payload", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromPreToolUse({
			event: preEvent({ tool_name: "TaskCreate", tool_input: { tasks: [] } }),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
	});

	it("maybeCaptureFromUserPromptSubmit returns null when the prompt body has no `## Plan`", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				prompt: "no plan section in here at all",
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
	});

	it("maybeCaptureFromPreToolUse captures an ExitPlanMode plan and mirrors it", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromPreToolUse({
			event: preEvent({
				tool_name: "ExitPlanMode",
				tool_input: { plan: "- read src/foo.ts\n- edit src/foo.ts\n" },
			}),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(captured).not.toBeNull();
		expect(captured?.source).toBe("ExitPlanMode");
		expect(session.declared_plan?.source).toBe("ExitPlanMode");
	});

	it("maybeCaptureFromPreToolUse returns null for a malformed ExitPlanMode payload", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromPreToolUse({
			event: preEvent({ tool_name: "ExitPlanMode", tool_input: {} }),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
	});

	it("maybeCaptureFromPreToolUse no-ops for tools other than TaskCreate / ExitPlanMode", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromPreToolUse({
			event: preEvent({ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } }),
			session,
			cwd: tmp,
			enabled: true,
		});
		expect(captured).toBeNull();
		expect(session.declared_plan).toBeUndefined();
	});
});

describe("SessionTracker round-trip with declared_plan", () => {
	it("serialize → hydrate preserves declared_plan exactly", () => {
		const tracker = new SessionTracker();
		const session = tracker.recordEvent({
			hook_event: "SessionStart",
			session_id: "sess-rt",
			agent_source: "claude",
			agent_name: "agent",
			timestamp: TIMESTAMP,
		});
		session.declared_plan = {
			session_id: "sess-rt",
			agent_name: "agent",
			created_at_iso: TIMESTAMP,
			created_at_step: 7,
			source: "ExitPlanMode",
			steps: [
				{ intent: "first", tool_hint: "Edit", target_hint: "src/foo.ts", status: "pending" },
				{ intent: "second", status: "executed" },
			],
		};

		const snapshot = tracker.serialize("sess-rt");
		expect(snapshot).not.toBeNull();

		const tracker2 = new SessionTracker();
		const restored = tracker2.hydrate(snapshot!);
		expect(restored).not.toBeNull();
		expect(restored?.declared_plan).toBeDefined();
		expect(restored?.declared_plan?.session_id).toBe("sess-rt");
		expect(restored?.declared_plan?.source).toBe("ExitPlanMode");
		expect(restored?.declared_plan?.steps).toHaveLength(2);
		expect(restored?.declared_plan?.steps[0]).toEqual({
			intent: "first",
			tool_hint: "Edit",
			target_hint: "src/foo.ts",
			status: "pending",
		});
		expect(restored?.declared_plan?.steps[1]).toEqual({
			intent: "second",
			status: "executed",
		});
	});

	it("hydrate a snapshot WITHOUT declared_plan (older shape) defaults to undefined", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent({
			hook_event: "SessionStart",
			session_id: "sess-old",
			agent_source: "claude",
			agent_name: "agent",
			timestamp: TIMESTAMP,
		});
		const snapshot = tracker.serialize("sess-old");
		expect(snapshot).not.toBeNull();
		// Older shape: declared_plan was never written
		const old = { ...(snapshot as Record<string, unknown>) };
		delete old.declared_plan;

		const tracker2 = new SessionTracker();
		const restored = tracker2.hydrate(old);
		expect(restored).not.toBeNull();
		// No declared_plan present + no crash
		expect(restored?.declared_plan).toBeUndefined();
		// Other fields preserved
		expect(restored?.session_id).toBe("sess-old");
	});

	it("hydrate is resilient to malformed declared_plan shapes (returns undefined, no crash)", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent({
			hook_event: "SessionStart",
			session_id: "sess-bad",
			agent_source: "claude",
			agent_name: "agent",
			timestamp: TIMESTAMP,
		});
		const snapshot = tracker.serialize("sess-bad") as Record<string, unknown>;
		snapshot.declared_plan = { not_a_plan: 7 } as unknown;
		const tracker2 = new SessionTracker();
		const restored = tracker2.hydrate(snapshot);
		expect(restored).not.toBeNull();
		expect(restored?.declared_plan).toBeUndefined();
	});
});
