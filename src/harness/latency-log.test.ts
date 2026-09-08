import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLatencyLog, ROTATION_BYTES_DEFAULT } from "./latency-log.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "latency-log-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_ENTRY = {
	hook_event: "PostToolUse" as string | null,
	tool_name: "Edit" as string | null,
	session_id: "s1" as string | null,
	agent_source: "claude" as string | null,
	decision: "allow",
	checks_ran: ["typescript", "biome_lint"],
	checks_timing_ms: 1234,
};

function logPath(): string {
	return join(tmp, "logs", "latency.jsonl");
}

describe("appendLatencyLog", () => {
	it("creates the logs directory if missing", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		expect(existsSync(join(tmp, "logs"))).toBe(true);
	});

	it("writes the log file at logs/latency.jsonl", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		expect(existsSync(logPath())).toBe(true);
	});

	it("writes exactly one JSON line per call", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
	});

	it("writes a v1-schema hook_decision record", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		const parsed = JSON.parse(readFileSync(logPath(), "utf-8").trim());
		expect(parsed.schema).toBe("v1");
		expect(parsed.kind).toBe("hook_decision");
	});

	it("preserves the entry's hook_event and tool_name", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		const parsed = JSON.parse(readFileSync(logPath(), "utf-8").trim());
		expect(parsed.hook_event).toBe("PostToolUse");
		expect(parsed.tool_name).toBe("Edit");
	});

	it("preserves the entry's decision and checks_timing_ms", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		const parsed = JSON.parse(readFileSync(logPath(), "utf-8").trim());
		expect(parsed.decision).toBe("allow");
		expect(parsed.checks_timing_ms).toBe(1234);
	});

	it("emits an ISO timestamp string", () => {
		appendLatencyLog(tmp, SAMPLE_ENTRY);
		const parsed = JSON.parse(readFileSync(logPath(), "utf-8").trim());
		expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("appends multiple events without overwriting", () => {
		appendLatencyLog(tmp, { ...SAMPLE_ENTRY, hook_event: "PreToolUse" });
		appendLatencyLog(tmp, { ...SAMPLE_ENTRY, hook_event: "PostToolUse" });
		const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("does not throw when fields are missing", () => {
		expect(() =>
			appendLatencyLog(tmp, {
				hook_event: "Notification",
				tool_name: null,
				session_id: null,
				agent_source: null,
				decision: "allow",
			}),
		).not.toThrow();
	});

	it("rotates when the log exceeds the rotation threshold", () => {
		mkdirSync(join(tmp, "logs"), { recursive: true });
		writeFileSync(logPath(), "x".repeat(100));
		appendLatencyLog(tmp, SAMPLE_ENTRY, { rotation_bytes: 50 });
		expect(existsSync(`${logPath()}.1`)).toBe(true);
	});

	it("after rotation the new log holds only the freshly-appended line", () => {
		mkdirSync(join(tmp, "logs"), { recursive: true });
		writeFileSync(logPath(), "x".repeat(100));
		appendLatencyLog(tmp, SAMPLE_ENTRY, { rotation_bytes: 50 });
		const lines = readFileSync(logPath(), "utf-8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
	});

	it("never throws on filesystem errors (unreachable parent path)", () => {
		expect(() => appendLatencyLog("/dev/null/nope", SAMPLE_ENTRY)).not.toThrow();
	});
});

describe("ROTATION_BYTES_DEFAULT", () => {
	it("is at least 1 MB", () => {
		expect(ROTATION_BYTES_DEFAULT).toBeGreaterThanOrEqual(1_000_000);
	});
});
