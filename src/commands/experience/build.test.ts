// Experience builder — projects timeline/collection/activity logs into
// trajectory-v1 (Letta interop) and trajectory-ix.v1 (annotated) records.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExperience } from "./build.js";
import type { BuiltExperience, IxAnnotations } from "./types.js";
import { nonNull } from "../../lib/non-null.js";

type BuiltRecord = BuiltExperience["records"][number];

function recordWithRole<R extends BuiltRecord["role"]>(record: BuiltRecord | undefined, role: R) {
    const matches = (value: BuiltRecord | undefined): value is Extract<BuiltRecord, { role: R }> => value?.role === role;
    if (!matches(record)) throw new Error(`Expected ${role} record`);
    return record;
}

function annotations(value: BuiltRecord | undefined): IxAnnotations | undefined {
    const record = nonNull(value);
    return "ix" in record ? record.ix : undefined;
}

function ixMetaRecord(value: BuiltRecord | undefined) {
    const record = recordWithRole(value, "meta");
    if (!("ix_meta" in record)) throw new Error("Expected annotated meta record");
    return record;
}

const SESSION = "sess-a";

let dir: string;

function writeJsonl(rel: string, rows: object[]): void {
	writeFileSync(join(dir, rel), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function timelineRow(over: Record<string, unknown>): object {
	return {
		schema: "timeline.v1",
		session: SESSION,
		uuid: `u-${String(over.ts)}`,
		seq: 0,
		provider: "claude-code",
		role: "assistant",
		...over,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "experience-build-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeBasicTimeline(): void {
	writeJsonl(".interlinked/timeline.jsonl", [
		timelineRow({
			ts: "2026-07-27T10:00:00.000Z",
			category: "user_prompt",
			role: "user",
			text: "Fix the bug.",
			cwd: "/repo",
			git_branch: "main",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:01.000Z",
			category: "agent_thinking",
			model: "model-x",
			text: "Read first, then edit.",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:02.000Z",
			category: "tool_use",
			model: "model-x",
			tool_name: "Bash",
			tool_use_id: "toolu_1",
			tool_input: { command: "npx vitest run src/a.test.ts" },
		}),
		timelineRow({
			ts: "2026-07-27T10:00:03.000Z",
			category: "tool_result",
			role: "user",
			tool_use_id: "toolu_1",
			text: "1 passed",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:04.000Z",
			category: "agent_message",
			model: "model-x",
			text: "Done — test passes.",
		}),
		// Another session's record: must be filtered out.
		timelineRow({
			ts: "2026-07-27T10:00:05.000Z",
			category: "agent_message",
			session: "sess-other",
			text: "not ours",
		}),
	]);
}

describe("buildExperience — letta format", () => {
	it("projects categories onto the trajectory-v1 spine, meta first, other sessions filtered", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const roles = built.records.map((r) => r.role);
		expect(roles).toEqual(["meta", "user", "reasoning", "assistant", "tool", "assistant"]);
	});

	it("derives the meta record from the earliest rows carrying each field", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });

		const meta = recordWithRole(built.records[0], "meta");
		expect(meta).toEqual({
			role: "meta",
			source: "claude-code",
			cwd: "/repo",
			git_branch: "main",
			model: "model-x",
		});
	});

	it("carries user content and timestamps through verbatim", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });

		const user = recordWithRole(built.records[1], "user");
		expect(user.content).toBe("Fix the bug.");
		expect(user.timestamp).toBe("2026-07-27T10:00:00.000Z");
	});

	it("maps tool_use to assistant tool_calls with JSON-encoded args", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });

		const call = recordWithRole(built.records[3], "assistant");
		expect(call.content).toBeNull();
		expect(call.tool_calls).toEqual([
			{
				id: "toolu_1",
				name: "Bash",
				args: JSON.stringify({ command: "npx vitest run src/a.test.ts" }),
			},
		]);
	});

	it("maps tool_result to a tool record linked by tool_call_id", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });

		const result = recordWithRole(built.records[4], "tool");
		expect(result.tool_call_id).toBe("toolu_1");
		expect(result.content).toBe("1 passed");
	});

	it("reports scan diagnostics for a complete read", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(5);
		expect(built.diagnostics.scan_truncated).toBe(false);
	});

	it("returns empty records with zero diagnostics when no logs exist", () => {
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.records).toEqual([]);
		expect(built.diagnostics.timeline_records).toBe(0);
	});

	it("truncates long tool results with an explicit marker, never silently", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_result",
				role: "user",
				tool_use_id: "toolu_big",
				text: "x".repeat(5000),
			}),
		]);
		const built = buildExperience({
			dir,
			sessionId: SESSION,
			format: "letta",
			truncateChars: 100,
		});

		const result = recordWithRole(built.records[1], "tool");
		expect(result.content.startsWith("x".repeat(100))).toBe(true);
		expect(result.content).toContain("[interlinked: truncated 5000 chars total]");
		expect(built.diagnostics.truncated_records).toBe(1);
	});
});

describe("buildExperience — ix format", () => {
	it("joins collection outcomes and guard verdicts by tool_use_id", () => {
		writeBasicTimeline();
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:03.000Z",
				session_id: SESSION,
				tool_use_id: "toolu_1",
				seq: 7,
				phase: "post",
				outcome: "error",
				tool_class: "shell_exec",
				provider_tool: "Bash",
				action: { command: "npx vitest run src/a.test.ts" },
				observation: { duration_ms: 1234, exit_code: 1 },
			},
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "2026-07-27T10:00:02.500Z",
				type: "guard_warn",
				tool: "Bash",
				tool_use_id: "toolu_1",
				guard_decision: "allow",
				guard_rule_id: "builtin-example",
				guard_reason: "careful",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });

		const call = ({ ix: annotations(built.records[3]) });
		expect(call.ix).toMatchObject({
			seq: 7,
			tool_class: "shell_exec",
			is_verification: true,
			episode: 0,
			guard: { decision: "warn", rule_id: "builtin-example", reason: "careful" },
		});

		const result = ({ ix: annotations(built.records[4]) });
		expect(result.ix).toMatchObject({ outcome: "error", duration_ms: 1234 });

		expect(built.diagnostics.collection_joined).toBe(1);
		expect(built.diagnostics.guard_joined).toBe(1);
	});

	it("stamps ix_meta counts and increments episodes per user prompt", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "user_prompt",
				role: "user",
				text: "First task",
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "agent_message",
				text: "ok",
			}),
			timelineRow({
				ts: "2026-07-27T10:00:02.000Z",
				category: "user_prompt",
				role: "user",
				text: "Second task",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });

		const meta = ixMetaRecord(built.records[0]);
		expect(meta.schema).toBe("trajectory-ix.v1");
		expect(meta.ix_meta.session_id).toBe(SESSION);
		expect(meta.ix_meta.records).toBe(3);
		expect(meta.ix_meta.episodes).toBe(2);
		expect(meta.ix_meta.guard_blocks).toBe(0);

		const second = ({ ix: annotations(built.records[3]) });
		expect(second.ix?.episode).toBe(1);
	});

	it("marks blocked calls from guard_block records", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_name: "Bash",
				tool_use_id: "toolu_blocked",
				tool_input: { command: "rm -rf /" },
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "2026-07-27T10:00:00.100Z",
				type: "guard_block",
				tool: "Bash",
				tool_use_id: "toolu_blocked",
				guard_decision: "block",
				guard_rule_id: "builtin-rm-rf",
				guard_reason: "BLOCKED: recursive deletion",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });

		const call = ({ ix: annotations(built.records[1]) });
		expect(call.ix?.guard).toEqual({
			decision: "block",
			rule_id: "builtin-rm-rf",
			reason: "BLOCKED: recursive deletion",
		});

		const meta = ixMetaRecord(built.records[0]);
		expect(meta.ix_meta.guard_blocks).toBe(1);
	});
});

// --- Mutation-kill regression tests: exact-value assertions per survivor. ---

/** One tool_use row + optional collection.jsonl join; returns the call's ix block. */
function buildSingleToolUseIx(opts: {
	toolInput?: unknown;
	collection?: Record<string, unknown>;
}): IxAnnotations | undefined {
	writeJsonl(".interlinked/timeline.jsonl", [
		timelineRow({
			ts: "2026-07-27T10:00:00.000Z",
			category: "tool_use",
			tool_name: "Bash",
			tool_use_id: "toolu_x",
			tool_input: opts.toolInput,
		}),
	]);
	if (opts.collection) {
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.500Z",
				session_id: SESSION,
				tool_use_id: "toolu_x",
				phase: "post",
				...opts.collection,
			},
		]);
	}
	const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
	const call = ({ ix: annotations(built.records[1]) });
	return call.ix;
}

/** One tool_result row joined to a collection.jsonl record; returns the result's ix block. */
function buildSingleToolResultIx(collection: Record<string, unknown>): IxAnnotations | undefined {
	writeJsonl(".interlinked/timeline.jsonl", [
		timelineRow({
			ts: "2026-07-27T10:00:00.000Z",
			category: "tool_result",
			role: "user",
			tool_use_id: "toolu_x",
			text: "result text",
		}),
	]);
	writeJsonl(".interlinked/collection.jsonl", [
		{
			schema: "collection.v1",
			kind: "tool_event",
			ts: "2026-07-27T10:00:00.500Z",
			session_id: SESSION,
			tool_use_id: "toolu_x",
			phase: "post",
			...collection,
		},
	]);
	const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
	const result = ({ ix: annotations(built.records[1]) });
	return result.ix;
}

/** One tool_use row + arbitrary activity.jsonl rows; returns the call's ix block. */
function buildSingleToolUseIxWithGuard(
	guardRecs: Record<string, unknown>[],
): IxAnnotations | undefined {
	writeJsonl(".interlinked/timeline.jsonl", [
		timelineRow({
			ts: "2026-07-27T10:00:00.000Z",
			category: "tool_use",
			tool_name: "Bash",
			tool_use_id: "toolu_g",
			tool_input: {},
		}),
	]);
	writeJsonl(".interlinked/activity.jsonl", guardRecs);
	const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
	const call = ({ ix: annotations(built.records[1]) });
	return call.ix;
}

describe("buildExperience — truncateChars resolution and boundary", () => {
	it("disables truncation entirely when truncateChars is explicitly null", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_result",
				tool_use_id: "toolu_big",
				text: "x".repeat(5000),
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta", truncateChars: null });
		const result = recordWithRole(built.records[1], "tool");
		expect(result.content).toBe("x".repeat(5000));
		expect(built.diagnostics.truncated_records).toBe(0);
	});

	it("honors an explicit numeric truncateChars, not the built-in default", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_result",
				tool_use_id: "toolu_big",
				text: "x".repeat(5000),
			}),
		]);
		const built = buildExperience({
			dir,
			sessionId: SESSION,
			format: "letta",
			truncateChars: 100,
		});
		const result = recordWithRole(built.records[1], "tool");
		expect(result.content).toBe(`${"x".repeat(100)}\n[interlinked: truncated 5000 chars total]`);
	});

	it("does not truncate when text.length exactly equals truncateChars (boundary)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_result",
				tool_use_id: "toolu_eq",
				text: "y".repeat(50),
			}),
		]);
		const built = buildExperience({
			dir,
			sessionId: SESSION,
			format: "letta",
			truncateChars: 50,
		});
		const result = recordWithRole(built.records[1], "tool");
		expect(result.content).toBe("y".repeat(50));
		expect(built.diagnostics.truncated_records).toBe(0);
	});
});

describe("buildExperience — format gating (no ix leakage into letta)", () => {
	it("never attaches an ix block to any record when format is letta", () => {
		writeBasicTimeline();
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:03.000Z",
				session_id: SESSION,
				tool_use_id: "toolu_1",
				phase: "post",
				outcome: "ok",
			},
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "2026-07-27T10:00:02.500Z",
				type: "guard_warn",
				tool_use_id: "toolu_1",
				guard_rule_id: "r",
				guard_reason: "x",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		for (const record of built.records) {
			expect(record).not.toHaveProperty("ix");
		}
	});
});

describe("buildExperience — ix always attached under ix format (minimal case)", () => {
	it("attaches an ix block containing only episode when nothing joins", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_message",
				text: "no tool activity here",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const record = ({ ix: annotations(built.records[1]) });
		expect(record.ix).toStrictEqual({ episode: 0 });
	});
});

describe("loadTimeline — row filters", () => {
	it("excludes a row with a mismatched schema, even with a valid session/ts/category", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			{ ...timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "bad" }), schema: "other.v1" },
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "good" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(1);
		const only = recordWithRole(built.records[1], "assistant");
		expect(only.content).toBe("good");
	});

	it("excludes a row with a mismatched session, even with a valid schema/ts/category", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_message",
				session: "sess-other",
				text: "bad",
			}),
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "good" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(1);
	});

	it("excludes a row whose ts is not a string (invalid, category otherwise valid)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			{ ...timelineRow({ category: "agent_message", text: "bad" }), ts: 12345 },
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "good" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(1);
	});

	it("excludes a row whose category is not a string (invalid, ts otherwise valid)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			{ ...timelineRow({ ts: "2026-07-27T10:00:00.000Z", text: "bad" }), category: 7 },
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "good" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(1);
	});

	it("never pushes a null projection for an unmapped category", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "session_start", text: "n/a" }),
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "kept" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.records).not.toContain(null);
		expect(built.records.length).toBe(2);
	});
});

describe("loadTimeline — chronological ordering", () => {
	it("sorts scrambled-write-order rows into strict ascending ts order", () => {
		// Written in file order T2, T1, T3 — the correct sort must produce T1, T2, T3
		// regardless of scan/write order.
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:02.000Z", category: "agent_message", text: "T2" }),
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", text: "T1" }),
			timelineRow({ ts: "2026-07-27T10:00:03.000Z", category: "agent_message", text: "T3" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const order = built.records
			.slice(1)
			.map((r) => (recordWithRole(r, "assistant")).content);
		expect(order).toEqual(["T1", "T2", "T3"]);
	});

	it("keeps write order for tied timestamps (stable sort over the un-reversed scan)", () => {
		// Written in file order A, B, C, all sharing one ts — must come out A, B, C.
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "A" }),
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "B" }),
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "C" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const order = built.records
			.slice(1)
			.map((r) => (recordWithRole(r, "assistant")).content);
		expect(order).toEqual(["A", "B", "C"]);
	});
});

describe("spineFromTimeline — content mapping and toolCalls counter", () => {
	it("carries reasoning content through verbatim (agent_thinking)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_thinking",
				text: "step-by-step plan",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const row = recordWithRole(built.records[1], "reasoning");
		expect(row.content).toBe("step-by-step plan");
	});

	it("carries assistant message content through verbatim (agent_message)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_message",
				text: "final answer",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const row = recordWithRole(built.records[1], "assistant");
		expect(row.content).toBe("final answer");
	});

	it("counts exactly the number of tool_use rows in ix_meta.tool_calls", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "t1",
				tool_input: {},
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "tool_use",
				tool_use_id: "t2",
				tool_input: {},
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const meta = ixMetaRecord(built.records[0]);
		expect(meta.ix_meta.tool_calls).toBe(2);
	});
});

describe("loadCollectionJoin — filters and dedupe", () => {
	it("does not join a record whose kind is not tool_event or phase is not post", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_x",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "other_kind",
				ts: "2026-07-27T10:00:00.500Z",
				session_id: SESSION,
				tool_use_id: "toolu_x",
				phase: "post",
				seq: 1,
			},
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.600Z",
				session_id: SESSION,
				tool_use_id: "toolu_x",
				phase: "pre",
				seq: 2,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.collection_joined).toBe(0);
	});

	it("does not join a record from a different session", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_x",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.500Z",
				session_id: "sess-other",
				tool_use_id: "toolu_x",
				phase: "post",
				seq: 1,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.collection_joined).toBe(0);
	});

	it("does not join a record whose tool_use_id is not among the session's ids", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { tool_use_id: "unrelated_id", seq: 1 },
		});
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("keeps the newest-delivered join on a duplicate tool_use_id (dedupe favors last-written)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_x",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.100Z",
				session_id: SESSION,
				tool_use_id: "toolu_x",
				phase: "post",
				seq: 100,
			},
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.900Z",
				session_id: SESSION,
				tool_use_id: "toolu_x",
				phase: "post",
				seq: 200,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const call = ({ ix: annotations(built.records[1]) });
		expect(call.ix?.seq).toBe(200);
	});

	it("never populates the joins map at all for an id outside the session's ids set", () => {
		// Distinct from the ix-shape assertion above: this pins the join-set
		// SIZE (diagnostics.collection_joined), which stays observable even if
		// the id-filter clause is short-circuited away and the record is
		// wrongly joined under its own (unrelated) key.
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_x",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.500Z",
				session_id: SESSION,
				tool_use_id: "unrelated_id",
				phase: "post",
				seq: 1,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.collection_joined).toBe(0);
	});

	it("processes every distinct-id collection record, not just the first delivered", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_a",
				tool_input: {},
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "tool_use",
				tool_use_id: "toolu_b",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.100Z",
				session_id: SESSION,
				tool_use_id: "toolu_a",
				phase: "post",
				seq: 1,
			},
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:01.100Z",
				session_id: SESSION,
				tool_use_id: "toolu_b",
				phase: "post",
				seq: 2,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.collection_joined).toBe(2);
	});
});

describe("collectionJoinFrom — per-field type guards", () => {
	it("does not map non-numeric seq or non-string tool_class", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { seq: "7", tool_class: 5 },
		});
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("maps a valid ok outcome onto the result record", () => {
		const ix = buildSingleToolResultIx({ outcome: "ok" });
		expect(ix).toStrictEqual({ episode: 0, outcome: "ok" });
	});

	it("does not map an outcome value outside ok/error", () => {
		const ix = buildSingleToolResultIx({ outcome: "pending" });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("maps a valid numeric duration_ms on the result record", () => {
		const ix = buildSingleToolResultIx({ observation: { duration_ms: 1500 } });
		expect(ix).toStrictEqual({ episode: 0, duration_ms: 1500 });
	});

	it("does not map a non-numeric duration_ms", () => {
		const ix = buildSingleToolResultIx({ observation: { duration_ms: "slow" } });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("does not crash and joins nothing extra when observation is absent", () => {
		const ix = buildSingleToolResultIx({ seq: 9 });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("does not crash and joins nothing extra when action is absent", () => {
		const ix = buildSingleToolUseIx({ toolInput: {}, collection: { seq: 3 } });
		expect(ix).toStrictEqual({ episode: 0, seq: 3 });
	});

	it("maps a valid string action.path onto ix.file", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { action: { path: "/repo/src/a.ts" } },
		});
		expect(ix).toStrictEqual({ episode: 0, file: "/repo/src/a.ts" });
	});

	it("does not map a non-string action.path (bypass-coercion trap)", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { action: { path: ["not-a-string"] } },
		});
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("maps a valid string action.command through to is_verification", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { action: { command: "npx vitest run x" } },
		});
		expect(ix).toStrictEqual({ episode: 0, is_verification: true });
	});

	it("does not use a non-string action.command (bypass-coercion trap)", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { action: { command: ["npm test"] } },
		});
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("N1: does not treat an array-shaped action as an object (isJsonObject excludes arrays)", () => {
		const ix = buildSingleToolUseIx({
			toolInput: {},
			collection: { action: ["path", "command"] },
		});
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("N2: does not treat an array-shaped observation as an object (isJsonObject excludes arrays)", () => {
		const ix = buildSingleToolResultIx({ observation: [1234] });
		expect(ix).toStrictEqual({ episode: 0 });
	});
});

describe("annotateCall — command source precedence and pattern gating", () => {
	it("prefers the joined command over row.tool_input, not the other way round", () => {
		const ix = buildSingleToolUseIx({
			toolInput: { command: "ls -la" },
			collection: { action: { command: "npx vitest run x" } },
		});
		expect(ix).toStrictEqual({ episode: 0, is_verification: true });
	});

	it("falls back to commandFromInput when no collection join exists", () => {
		const ix = buildSingleToolUseIx({ toolInput: { command: "npx vitest run y" } });
		expect(ix).toStrictEqual({ episode: 0, is_verification: true });
	});

	it("does not set is_verification for a non-verification command", () => {
		const ix = buildSingleToolUseIx({ toolInput: { command: "ls -la" } });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("does not attach a guard block when none joins", () => {
		const ix = buildSingleToolUseIx({ toolInput: {} });
		expect(ix).not.toHaveProperty("guard");
	});

	it("does not set file, seq, or is_verification on the tool_result record (only outcome/duration_ms)", () => {
		writeBasicTimeline();
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:03.000Z",
				session_id: SESSION,
				tool_use_id: "toolu_1",
				seq: 7,
				phase: "post",
				outcome: "error",
				tool_class: "shell_exec",
				action: { command: "npx vitest run src/a.test.ts", path: "src/a.test.ts" },
				observation: { duration_ms: 1234 },
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const result = ({ ix: annotations(built.records[4]) });
		expect(result.ix).not.toHaveProperty("seq");
		expect(result.ix).not.toHaveProperty("file");
		expect(result.ix).not.toHaveProperty("is_verification");
		expect(result.ix).not.toHaveProperty("guard");
		const call = ({ ix: annotations(built.records[3]) });
		expect(call.ix).not.toHaveProperty("outcome");
		expect(call.ix).not.toHaveProperty("duration_ms");
	});
});

describe("ixAnnotationsFor — agent_id and missing tool_use_id", () => {
	it("attaches agent_id when the row carries one", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_message",
				agent_id: "sub-agent-1",
				text: "hi",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const row = ({ ix: annotations(built.records[1]) });
		expect(row.ix).toStrictEqual({ episode: 0, agent_id: "sub-agent-1" });
	});

	it("does not attach agent_id when the row has none", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "hi" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const row = ({ ix: annotations(built.records[1]) });
		expect(row.ix).not.toHaveProperty("agent_id");
	});

	it("does not run call/result annotation for a tool_use row lacking a tool_use_id", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_input: { command: "npx vitest run x" },
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const row = ({ ix: annotations(built.records[1]) });
		expect(row.ix).toStrictEqual({ episode: 0 });
	});
});

describe("loadGuardJoin — filters, dedupe, and null-fallback fields", () => {
	it("does not join a non-guard activity record", () => {
		const ix = buildSingleToolUseIxWithGuard([
			{ schema_version: 5, ts: "t", type: "session_start", tool_use_id: "toolu_g" },
		]);
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("does not join a guard record for a different tool_use_id", () => {
		const ix = buildSingleToolUseIxWithGuard([
			{
				schema_version: 5,
				ts: "t",
				type: "guard_warn",
				tool_use_id: "some_other_id",
				guard_rule_id: "r",
				guard_reason: "x",
			},
		]);
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("keeps the newest-delivered guard record on a duplicate tool_use_id (dedupe)", () => {
		const ix = buildSingleToolUseIxWithGuard([
			{
				schema_version: 5,
				ts: "t1",
				type: "guard_warn",
				tool_use_id: "toolu_g",
				guard_rule_id: "first-older",
				guard_reason: "older",
			},
			{
				schema_version: 5,
				ts: "t2",
				type: "guard_block",
				tool_use_id: "toolu_g",
				guard_rule_id: "second-newer",
				guard_reason: "newer",
			},
		]);
		expect(ix?.guard).toEqual({ decision: "block", rule_id: "second-newer", reason: "newer" });
	});

	it("never populates the guards map at all for an id outside the session's ids set", () => {
		// Guard analog of the collection-join isolation test above: pins
		// diagnostics.guard_joined so a short-circuited id-filter clause is
		// observable even though the ix-shape assertion elsewhere would not
		// catch a guard wrongly joined under an unrelated key.
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_x",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "t1",
				type: "guard_warn",
				tool_use_id: "unrelated_id",
				guard_rule_id: "r",
				guard_reason: "x",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.guard_joined).toBe(0);
	});

	it("processes every distinct-id guard record, not just the first delivered", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_g1",
				tool_input: {},
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "tool_use",
				tool_use_id: "toolu_g2",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "t1",
				type: "guard_block",
				tool_use_id: "toolu_g1",
				guard_rule_id: "r1",
				guard_reason: "x1",
			},
			{
				schema_version: 5,
				ts: "t2",
				type: "guard_warn",
				tool_use_id: "toolu_g2",
				guard_rule_id: "r2",
				guard_reason: "x2",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.guard_joined).toBe(2);
	});

	it("maps guard_rule_id/guard_reason to null (not undefined) when absent", () => {
		const ix = buildSingleToolUseIxWithGuard([
			{ schema_version: 5, ts: "t", type: "guard_block", tool_use_id: "toolu_g" },
		]);
		expect(ix?.guard).toEqual({ decision: "block", rule_id: null, reason: null });
	});

	it("does not double-count guard_blocks for a guard_warn", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_w",
				tool_input: {},
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "tool_use",
				tool_use_id: "toolu_b",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "t1",
				type: "guard_warn",
				tool_use_id: "toolu_w",
				guard_rule_id: "r1",
				guard_reason: "x1",
			},
			{
				schema_version: 5,
				ts: "t2",
				type: "guard_block",
				tool_use_id: "toolu_b",
				guard_rule_id: "r2",
				guard_reason: "x2",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const meta = ixMetaRecord(built.records[0]);
		expect(meta.ix_meta.guard_blocks).toBe(1);
	});
});

describe("commandFromInput — type guards on tool_input", () => {
	it("returns no command (no crash) when tool_input is null", () => {
		const ix = buildSingleToolUseIx({ toolInput: null });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("returns no command (no crash) when tool_input is omitted", () => {
		const ix = buildSingleToolUseIx({ toolInput: undefined });
		expect(ix).toStrictEqual({ episode: 0 });
	});

	it("does not extract a non-string command field (bypass-coercion trap)", () => {
		const ix = buildSingleToolUseIx({ toolInput: { command: ["npm test"] } });
		expect(ix).toStrictEqual({ episode: 0 });
	});
});

describe("buildMeta / firstDefined", () => {
	it("picks a non-default provider value, does not collapse to the fallback literal", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "agent_message",
				provider: "codex-cli",
				text: "hi",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const meta = recordWithRole(built.records[0], "meta");
		expect(meta.source).toBe("codex-cli");
	});

	it("defaults source to claude-code when no row carries a provider", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			{ ...timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", text: "hi" }), provider: undefined },
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const meta = recordWithRole(built.records[0], "meta");
		expect(meta.source).toBe("claude-code");
	});

	it("skips an empty-string field and picks the next row's value (firstDefined)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "agent_message", cwd: "", text: "a" }),
			timelineRow({ ts: "2026-07-27T10:00:01.000Z", category: "agent_message", cwd: "/repo2", text: "b" }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const meta = recordWithRole(built.records[0], "meta");
		expect(meta.cwd).toBe("/repo2");
	});

	it("counts only guard_block decisions toward guard_blocks, not guard_warn", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_use_id: "toolu_warn",
				tool_input: {},
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "t1",
				type: "guard_warn",
				tool_use_id: "toolu_warn",
				guard_rule_id: "r1",
				guard_reason: "x1",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		const meta = ixMetaRecord(built.records[0]);
		expect(meta.ix_meta.guard_blocks).toBe(0);
	});
});

describe("VERIFICATION_PATTERN — verifier command classification", () => {
	const verifierCommands = [
		"npx vitest run src/a.test.ts",
		"jest --runInBand",
		"pytest -k foo",
		"tsc --noEmit",
		"tsgo --noEmit",
		"biome check .",
		"oxlint .",
		"eslint .",
		"ruff check .",
		"mypy src",
		"go test ./...",
		"go vet ./...",
		"cargo test",
		"cargo check",
		"cargo clippy",
		"npm test",
		"npm run test:unit",
		"npm run typecheck",
		"npm run build",
		"npm run lint",
		// Whitespace-quantifier and character-class boundary cases: each pins one
		// literal token of VERIFICATION_PATTERN against a `\s+` → `\s` or a
		// `[\w:-]*` class-shape regression that a looser regex would still pass.
		"go  test ./...", // double space: needs \s+, not \s, after "go"
		"cargo  test", // double space after "cargo"
		"npm  test", // double space after "npm"
		"npm run  test:unit", // double space after "run"
		"npm run test", // bare "test" with nothing after — needs the `*` (zero-or-more)
		"npm run testify", // "test" followed by word chars past the intended suffix
	];
	for (const command of verifierCommands) {
		it(`classifies "${command}" as a verification command`, () => {
			const ix = buildSingleToolUseIx({ toolInput: { command } });
			expect(ix).toStrictEqual({ episode: 0, is_verification: true });
		});
	}

	const nonVerifierCommands = [
		"cargo build",
		"npm install foo",
		"ls -la",
		"echo hello",
		"rm -rf tmp",
	];
	for (const command of nonVerifierCommands) {
		it(`does not classify "${command}" as a verification command`, () => {
			const ix = buildSingleToolUseIx({ toolInput: { command } });
			expect(ix).toStrictEqual({ episode: 0 });
		});
	}
});

describe("buildExperience — id-set population uses a falsy guard, not merely 'defined'", () => {
	it("does NOT add an empty-string tool_use_id to the join id-set (so an empty-id collection record never joins)", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "tool_use", tool_use_id: "", tool_input: {} }),
		]);
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:00.500Z",
				session_id: SESSION,
				tool_use_id: "",
				phase: "post",
				seq: 1,
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		expect(built.diagnostics.collection_joined).toBe(0);
	});
});

describe("spineFromTimeline — tool_calls id/name fall back to empty string, not a placeholder", () => {
	it("defaults tool_calls[0].id and .name to exact empty strings when the row lacks them", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({ ts: "2026-07-27T10:00:00.000Z", category: "tool_use", tool_input: {} }),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const call = recordWithRole(built.records[1], "assistant");
		expect(call.tool_calls).toEqual([{ id: "", name: "", args: "{}" }]);
	});
});

describe("loadTimeline — DEFAULT_BUDGET is generous enough for a real multi-chunk scan", () => {
	it("reads every row of a file spanning more than one internal scan chunk, untruncated", () => {
		const rowCount = 2500;
		const rows: object[] = [];
		for (let i = 0; i < rowCount; i++) {
			const ts = `2026-07-27T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
			rows.push(
				timelineRow({
					ts,
					category: "tool_result",
					tool_use_id: `toolu_${i}`,
					text: "p".repeat(500),
				}),
			);
		}
		writeJsonl(".interlinked/timeline.jsonl", rows);
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.scan_truncated).toBe(false);
		expect(built.diagnostics.timeline_records).toBe(rowCount);
	});
});
