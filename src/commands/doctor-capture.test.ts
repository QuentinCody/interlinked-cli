import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { thinkingCaptureCheck } from "./doctor-capture.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(records: Array<Record<string, unknown>>): string {
	const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
	dirs.push(d);
	mkdirSync(join(d, ".interlinked"), { recursive: true });
	writeFileSync(
		join(d, ".interlinked", "activity.jsonl"),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return d;
}

function start(i: number, thinking?: string): Record<string, unknown> {
	const r: Record<string, unknown> = {
		schema_version: 5,
		ts: `2026-06-22T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
		type: "tool_use_start",
		tool: "Bash",
		summary: "ls",
		session: "s1",
		hook: "PreToolUse",
	};
	if (thinking !== undefined) r.thinking = thinking;
	return r;
}

describe("thinkingCaptureCheck", () => {
	it("passes when recent tool calls carry reasoning traces", () => {
		const d = setup([start(1, "reasoning a"), start(2), start(3, "reasoning b")]);
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/2\/3/);
	});

	it("warns when 0 of >=5 recent tool calls carry reasoning (capture regressed)", () => {
		const d = setup(Array.from({ length: 8 }, (_, i) => start(i + 1)));
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("warn");
		expect(r.message).toMatch(/regress|reasoning/i);
	});

	it("does not warn on a tiny sample with no thinking (too little signal)", () => {
		const d = setup([start(1), start(2)]); // below the >=5 floor
		expect(thinkingCaptureCheck(d).status).toBe("pass");
	});

	it("passes (skips) when there are no tool calls recorded yet", () => {
		const d = setup([]);
		expect(thinkingCaptureCheck(d).status).toBe("pass");
	});

	it("passes (skips) when there is no activity log at all", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d); // no .interlinked/activity.jsonl created
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/no activity log/);
	});

	it("windows to recent records, so stale thinking can't mask a new outage", () => {
		// 1 old record WITH thinking, then 25 recent WITHOUT → window excludes the old one.
		const recs = [start(0, "old reasoning"), ...Array.from({ length: 25 }, (_, i) => start(i + 1))];
		const d = setup(recs);
		expect(thinkingCaptureCheck(d).status).toBe("warn");
	});

	it("ignores empty/whitespace-only thinking strings", () => {
		const d = setup(Array.from({ length: 6 }, (_, i) => start(i + 1, "   ")));
		const outcome = thinkingCaptureCheck(d);
		expect(outcome.status).toBe("warn");
		expect(outcome.message).toBe(
			"0 of the last 6 tool calls carry reasoning traces -- the hook->daemon capture path may have regressed. If extended thinking is off for your model, ignore.",
		);
	});

	it("skips malformed JSONL lines and still assesses the valid records", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d);
		mkdirSync(join(d, ".interlinked"), { recursive: true });
		const lines = [
			JSON.stringify(start(1, "reasoning a")),
			"{ this is not valid json",
			JSON.stringify(start(2, "reasoning b")),
		];
		writeFileSync(join(d, ".interlinked", "activity.jsonl"), `${lines.join("\n")}\n`);
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/2\/2/);
	});

	it("fails open to a warn when the activity log is unreadable", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d);
		// .interlinked/activity.jsonl is a directory → read throws → fail-open warn.
		mkdirSync(join(d, ".interlinked", "activity.jsonl"), { recursive: true });
		const result = thinkingCaptureCheck(d);
		expect(result.status).toBe("warn");
		expect(result.message).toBe("could not read activity log to assess capture health");
	});

	// -- parseToolUseStartSample (via thinkingCaptureCheck) — malformed lines --

	it("P1: counts a well-formed tool_use_start line with a thinking string", () => {
		const d = setup([start(1, "reasoning a"), start(2, "reasoning b")]);
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/2\/2/);
	});

	it("N1: skips a line that parses to a JSON array instead of an object", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d);
		mkdirSync(join(d, ".interlinked"), { recursive: true });
		const lines = [JSON.stringify(["not", "an", "object"]), JSON.stringify(start(1, "reasoning a"))];
		writeFileSync(join(d, ".interlinked", "activity.jsonl"), `${lines.join("\n")}\n`);
		const r = thinkingCaptureCheck(d);
		// Only the second (valid) line is counted; the array line contributes nothing.
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/1\/1/);
	});

	it("N2: skips a line that parses to a bare JSON null", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d);
		mkdirSync(join(d, ".interlinked"), { recursive: true });
		const lines = ["null", JSON.stringify(start(1, "reasoning a"))];
		writeFileSync(join(d, ".interlinked", "activity.jsonl"), `${lines.join("\n")}\n`);
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/1\/1/);
	});

	it("N3: skips a tool_use_start record whose type field is the wrong type", () => {
		const d = mkdtempSync(join(tmpdir(), "doctor-capture-"));
		dirs.push(d);
		mkdirSync(join(d, ".interlinked"), { recursive: true });
		const lines = [
			JSON.stringify({ ...start(1, "reasoning a"), type: 42 }),
			JSON.stringify(start(2, "reasoning b")),
		];
		writeFileSync(join(d, ".interlinked", "activity.jsonl"), `${lines.join("\n")}\n`);
		const r = thinkingCaptureCheck(d);
		expect(r.status).toBe("pass");
		expect(r.message).toMatch(/1\/1/);
	});
});
