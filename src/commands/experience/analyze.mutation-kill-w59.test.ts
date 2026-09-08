import { describe, expect, it } from "vitest";
import { analyzeExperience } from "./analyze.js";
import type { ExperienceRecord, IxExperienceRecord } from "./types.js";

function assistantIx(
	overrides: Partial<IxExperienceRecord & { role: "assistant" }> = {},
): IxExperienceRecord {
	return {
		role: "assistant",
		content: "hi",
		tool_calls: [{ id: "t1", name: "Bash", args: "{}" }],
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("analyzeExperience — positive (must fire)", () => {
	it("P1: ix.episode defined sets episodes = episode + 1, undefined leaves episodes at 0", () => {
		const withEpisode = analyzeExperience([
			assistantIx({ ix: { episode: 3 } }),
		]);
		expect(withEpisode.episodes).toBe(4);

		const withoutIx = analyzeExperience([
			{
				role: "assistant",
				content: "hi",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		]);
		expect(withoutIx.episodes).toBe(0);
	});

	it("P2: episode + 1 (not - 1) and Math.max (not Math.min) across two records", () => {
		const result = analyzeExperience([
			assistantIx({ ix: { episode: 1 } }),
			assistantIx({ ix: { episode: 4 } }),
		]);
		// episode+1 for 4 is 5; Math.max keeps the running max at 5.
		// ArithmeticOperator mutant (episode-1) would give 3 for the second record.
		// MethodExpression mutant (Math.min) would keep it at 2 (from first record).
		expect(result.episodes).toBe(5);
	});

	it("P3: only role === 'assistant' with tool_calls counts as a call", () => {
		const userRecord: ExperienceRecord = {
			role: "user",
			content: "hello",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = analyzeExperience([userRecord]);
		expect(result.tools.calls).toBe(0);
	});

	it("N-companion for P3: assistant record with tool_calls DOES count", () => {
		const result = analyzeExperience([assistantIx()]);
		expect(result.tools.calls).toBe(1);
	});
});

describe("analyzeExperience — negative (must not fire / structural)", () => {
	it("N1: ix.tool_class optional chaining — record with no ix falls back to 'unknown'", () => {
		const noIx: ExperienceRecord = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "t1", name: "Bash", args: "{}" }],
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const result = analyzeExperience([noIx]);
		expect(result.tools.by_class).toEqual({ unknown: 1 });
	});

	it("N2: ix.is_verification optional chaining — no ix does not throw and does not count verification", () => {
		const noIx: ExperienceRecord = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "t1", name: "Bash", args: "{}" }],
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		expect(() => analyzeExperience([noIx])).not.toThrow();
		const result = analyzeExperience([noIx]);
		expect(result.tools.verification_runs).toBe(0);
	});

	it("N3: ix?.file !== undefined guards editsPerFile — no file present means no per-file entry", () => {
		const result = analyzeExperience([
			assistantIx({ ix: { tool_class: "file_edit" } }),
		]);
		expect(result.files.edited).toBe(0);
		expect(result.files.edit_events).toBe(1);
	});

	it("N3b: ix.file present is recorded per file (edited count reflects the file)", () => {
		const result = analyzeExperience([
			assistantIx({ ix: { tool_class: "file_edit", file: "a.ts" } }),
		]);
		expect(result.files.edited).toBe(1);
	});

	it("N4: ix?.file optional chaining — no ix on an edit-class-classified record must not throw", () => {
		const noIx: ExperienceRecord = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "t1", name: "Bash", args: "{}" }],
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		expect(() => analyzeExperience([noIx])).not.toThrow();
	});

	it("N5: ix?.guard optional chaining for blocks — no ix does not throw, no block counted", () => {
		const noIx: ExperienceRecord = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "t1", name: "Bash", args: "{}" }],
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		expect(() => analyzeExperience([noIx])).not.toThrow();
		const result = analyzeExperience([noIx]);
		expect(result.guard.blocks).toBe(0);
	});

	it('N6: "warn" string literal — guard.decision "warn" is counted as a warn, not empty string', () => {
		const result = analyzeExperience([
			assistantIx({
				ix: { guard: { decision: "warn", rule_id: "r1", reason: null } },
			}),
		]);
		expect(result.guard.warns).toBe(1);
	});

	it('N7: guard.decision === "warn" comparison actually gates warns increment', () => {
		const noGuard = analyzeExperience([assistantIx({ ix: {} })]);
		expect(noGuard.guard.warns).toBe(0);

		const blockGuard = analyzeExperience([
			assistantIx({
				ix: { guard: { decision: "block", rule_id: "r1", reason: null } },
			}),
		]);
		expect(blockGuard.guard.warns).toBe(0);
	});

	it("N8: ix?.guard optional chaining on the warn branch — an ix without guard records no warn", () => {
		const result = analyzeExperience([assistantIx({ ix: {} })]);
		expect(result.guard.warns).toBe(0);
	});

	it("N9: reworked counts files with count >= 2, not files with count >= 1", () => {
		const result = analyzeExperience([
			assistantIx({ ix: { tool_class: "file_edit", file: "a.ts" } }),
		]);
		// a single edit to a.ts: count === 1, must NOT be counted as reworked
		expect(result.files.edited).toBe(1);
		expect(result.files.reworked).toBe(0);

		const result2 = analyzeExperience([
			assistantIx({ ix: { tool_class: "file_edit", file: "a.ts" } }),
			assistantIx({ ix: { tool_class: "file_edit", file: "a.ts" } }),
		]);
		expect(result2.files.reworked).toBe(1);
	});

	it("N10: top_rules is actually sorted by count descending (MethodExpression mutant would leave insertion order)", () => {
		const result = analyzeExperience([
			assistantIx({
				ix: {
					guard: { decision: "block", rule_id: "low", reason: null },
				},
			}),
			assistantIx({
				ix: {
					guard: { decision: "block", rule_id: "high", reason: null },
				},
			}),
			assistantIx({
				ix: {
					guard: { decision: "block", rule_id: "high", reason: null },
				},
			}),
		]);
		// "low" inserted first with count 1, "high" inserted second reaching count 2.
		// Sorted descending by count: high(2) before low(1).
		expect(result.guard.top_rules).toEqual([
			["high", 2],
			["low", 1],
		]);
	});

	it("N11: sort comparator tie-break — equal counts sort by rule_id ascending", () => {
		const result = analyzeExperience([
			assistantIx({
				ix: { guard: { decision: "block", rule_id: "zebra", reason: null } },
			}),
			assistantIx({
				ix: { guard: { decision: "block", rule_id: "alpha", reason: null } },
			}),
		]);
		expect(result.guard.top_rules).toEqual([
			["alpha", 1],
			["zebra", 1],
		]);
	});

	it("N12: span_ms requires BOTH firstTs and lastTs non-null (LogicalOperator: && not ||)", () => {
		// A single record sets both firstTs and lastTs to the same timestamp,
		// so span is always computed once any record exists; test the null case
		// via zero records, where both stay null.
		const empty = analyzeExperience([]);
		expect(empty.span_ms).toBeNull();
	});

	it("N13: span_ms is computed only from real, defined timestamps (firstTs !== null branch)", () => {
		const result = analyzeExperience([
			{
				role: "user",
				content: "hi",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			{
				role: "user",
				content: "bye",
				timestamp: "2026-01-01T00:00:10.000Z",
			},
		]);
		expect(result.span_ms).toBe(10000);
	});

	it("N14: span_ms null-and-Number.isFinite guard rejects NaN spans (bad timestamps)", () => {
		const result = analyzeExperience([
			{
				role: "user",
				content: "hi",
				timestamp: "not-a-date",
			},
		]);
		// Date.parse("not-a-date") - Date.parse("not-a-date") = NaN - NaN = NaN,
		// so Number.isFinite(spanMs) must gate this to null.
		expect(result.span_ms).toBeNull();
	});

	it("N15: EDIT_CLASSES membership includes file_write and notebook_edit as edit events", () => {
		const fileWrite = analyzeExperience([
			assistantIx({ ix: { tool_class: "file_write" } }),
		]);
		expect(fileWrite.files.edit_events).toBe(1);

		const notebookEdit = analyzeExperience([
			assistantIx({ ix: { tool_class: "notebook_edit" } }),
		]);
		expect(notebookEdit.files.edit_events).toBe(1);

		const other = analyzeExperience([
			assistantIx({ ix: { tool_class: "shell_exec" } }),
		]);
		expect(other.files.edit_events).toBe(0);
	});
});
