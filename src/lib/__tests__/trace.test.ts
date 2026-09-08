import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock local-activity
vi.mock("../local-activity.js", () => ({
	readLocalActivity: vi.fn(),
	appendLocalActivity: vi.fn(),
}));

import { appendLocalActivity, readLocalActivity } from "../local-activity.js";
import { exportTrace, importTrace } from "../trace.js";

const mockReadLocal = vi.mocked(readLocalActivity);
const mockAppendLocal = vi.mocked(appendLocalActivity);

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("exportTrace", () => {
	it("exports events as JSON document", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Edit",
				summary: "src/index.ts",
				session: "s1",
				hook: "PostToolUse",
				duration_ms: 42,
			},
			{
				ts: "2025-01-01T10:01:00Z",
				agent: "agent-1",
				type: "session_end",
				tool: null,
				summary: null,
				session: "s1",
				hook: "SessionEnd",
			},
		]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);

		expect(doc.format).toBe("interlinked-trace");
		expect(doc.version).toBe(1);
		expect(doc.spans).toHaveLength(2);
		expect(doc.spans[0].name).toBe("tool_use");
		expect(doc.spans[0].trace_id).toBe("s1");
		expect(doc.spans[0].attributes.agent).toBe("agent-1");
		expect(doc.spans[0].attributes.tool).toBe("Edit");
		expect(doc.spans[0].attributes.summary).toBe("src/index.ts");
		expect(doc.spans[0].attributes.hook).toBe("PostToolUse");
		expect(doc.spans[0].duration_ms).toBe(42);
	});

	it("uses safe defaults when options are omitted and forwards the complete read filter", () => {
		mockReadLocal.mockReturnValue([]);

		exportTrace();

		expect(mockReadLocal).toHaveBeenCalledWith({
			since: undefined,
			agent: undefined,
			limit: 10000,
			cwd: undefined,
		});
	});

	it("converts a since duration into a timestamp cutoff", () => {
		mockReadLocal.mockReturnValue([]);
		vi.spyOn(Date, "now").mockReturnValue(10_000);

		exportTrace({ since: "5m", agent: "worker", cwd: "/tmp/activity" });

		expect(mockReadLocal).toHaveBeenCalledWith({
			since: 10_000 - 5 * 60_000,
			agent: "worker",
			limit: 10000,
			cwd: "/tmp/activity",
		});
	});

	it("exports as JSONL", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Read",
				summary: "file.ts",
				session: "s1",
				hook: "PostToolUse",
			},
		]);

		const result = exportTrace({ format: "jsonl" });
		expect(result.endsWith("\n")).toBe(true);
		const lines = result.trim().split("\n");
		expect(lines).toHaveLength(1);

		const span = JSON.parse(lines[0]);
		expect(span.name).toBe("tool_use");
	});

	it("handles empty activity", () => {
		mockReadLocal.mockReturnValue([]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);
		expect(doc.spans).toHaveLength(0);
	});

	it("passes through v2 fields (tokens, parent_agent)", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "subagent_stop",
				tool: "worker-1",
				summary: null,
				session: "s1",
				hook: "SubagentStop",
				tokens: { input: 1000, output: 500 },
				parent_agent: "lead",
				subagent_id: "sub-1",
			},
		]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);
		expect(doc.spans[0].attributes.tokens).toEqual({ input: 1000, output: 500 });
		expect(doc.spans[0].attributes.parent_agent).toBe("lead");
		expect(doc.spans[0].attributes.subagent_id).toBe("sub-1");
	});

	it("uses trace and span fallbacks for missing session or timestamp values", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-02T03:04:05.678Z",
				agent: "agent-1",
				type: "tool_use",
				tool: null,
				summary: null,
				session: null,
				hook: null,
			},
			{
				ts: "",
				agent: "agent-1",
				type: "session_end",
				tool: null,
				summary: null,
				session: null,
				hook: null,
			},
		]);

		const doc = JSON.parse(exportTrace({ format: "json" }));

		expect(doc.spans).toMatchObject([
			{
				trace_id: "trace-2025-01-02",
				span_id: "span-0-20250102030405",
			},
			{
				trace_id: "trace-unknown",
				span_id: "span-1-1",
			},
		]);
	});
});

describe("importTrace", () => {
	it("imports JSON document format", () => {
		mockReadLocal.mockReturnValue([]);

		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "s1",
					span_id: "span-0",
					name: "tool_use",
					timestamp: "2025-01-01T10:00:00Z",
					attributes: { agent: "agent-1", tool: "Edit", summary: "file.ts" },
				},
			],
		};

		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(mockAppendLocal).toHaveBeenCalledOnce();
		expect(mockReadLocal).toHaveBeenLastCalledWith({ limit: 50000, cwd: undefined });
	});

	it("imports JSONL format", () => {
		mockReadLocal.mockReturnValue([]);

		const jsonl = [
			JSON.stringify({
				trace_id: "s1",
				span_id: "span-0",
				name: "tool_use",
				timestamp: "2025-01-01T10:00:00Z",
				attributes: { agent: "a1" },
			}),
			JSON.stringify({
				trace_id: "s1",
				span_id: "span-1",
				name: "session_end",
				timestamp: "2025-01-01T10:01:00Z",
				attributes: { agent: "a1" },
			}),
		].join("\n");

		const result = importTrace(jsonl);
		expect(result.imported).toBe(2);
	});

	it("deduplicates existing events", () => {
		mockReadLocal.mockReturnValue([
			{ ts: "2025-01-01T10:00:00Z", agent: "agent-1", type: "tool_use" },
		]);

		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "s1",
					span_id: "span-0",
					name: "tool_use",
					timestamp: "2025-01-01T10:00:00Z",
					attributes: { agent: "agent-1" },
				},
				{
					trace_id: "s1",
					span_id: "span-1",
					name: "session_end",
					timestamp: "2025-01-01T10:01:00Z",
					attributes: { agent: "agent-1" },
				},
			],
		};

		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1); // Only session_end is new
		expect(result.skipped).toBe(1); // tool_use already exists
	});

	it("handles empty input", () => {
		const result = importTrace("");
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(mockReadLocal).not.toHaveBeenCalled();
	});

	it("does not accept a non-trace object merely because it contains a spans array", () => {
		mockReadLocal.mockReturnValue([]);
		const data = JSON.stringify({
			format: "other-format",
			spans: [{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: {} }],
		});

		expect(importTrace(data)).toEqual({ imported: 0, skipped: 0 });
		expect(mockReadLocal).not.toHaveBeenCalled();
		expect(mockAppendLocal).not.toHaveBeenCalled();
	});

	it("filters invalid JSONL spans instead of passing null into the import loop", () => {
		mockReadLocal.mockReturnValue([]);
		const jsonl = [
			JSON.stringify({ timestamp: "2025-01-01T10:00:00Z", attributes: {} }),
			JSON.stringify({ name: "tool_use", timestamp: "2025-01-01T10:00:01Z", attributes: {} }),
		].join("\n");

		expect(importTrace(jsonl)).toEqual({ imported: 1, skipped: 0 });
	});

	it("round-trips export → import", () => {
		const events = [
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Read",
				summary: "file.ts",
				session: "s1",
				hook: "PostToolUse",
			},
		];
		mockReadLocal.mockReturnValueOnce(events); // for export
		mockReadLocal.mockReturnValueOnce([]); // for import dedup check

		const exported = exportTrace({ format: "json" });
		const result = importTrace(exported);

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
	});

	// parseImportedSpan — direct boundary-parser coverage (via importTrace,
	// its only entry point).
	it("P1: accepts a span missing span_id/duration_ms — importTrace never reads them", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: { agent: "a1" } }],
		};
		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
	});

	it("preserves valid trace metadata and normalizes wrong-typed metadata", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "s1",
					name: "tool_use",
					timestamp: "2025-01-01T10:00:00Z",
					attributes: { agent: "a1", tool: "Edit", summary: "file.ts" },
				},
				{
					trace_id: 123,
					name: "tool_use",
					timestamp: "2025-01-01T10:00:01Z",
					attributes: { agent: "a1", tool: 42, summary: false },
				},
			],
		};

		expect(importTrace(JSON.stringify(doc))).toEqual({ imported: 2, skipped: 0 });
		expect(mockAppendLocal.mock.calls[0]?.[0]).toMatchObject({
			tool: "Edit",
			summary: "file.ts",
			session: "s1",
		});
		expect(mockAppendLocal.mock.calls[1]?.[0]).toMatchObject({
			tool: null,
			summary: null,
			session: null,
		});
	});

	it("keeps valid spans when a JSON envelope contains a null span", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				null,
				{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: {} },
			],
		};

		expect(importTrace(JSON.stringify(doc))).toEqual({ imported: 1, skipped: 0 });
	});

	it("N1: drops a span missing timestamp, keeping the rest of the batch", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{ name: "no-timestamp", attributes: {} },
				{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: {} },
			],
		};
		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
	});

	it("N2: drops a span missing name, keeping the rest of the batch", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{ timestamp: "2025-01-01T10:00:00Z", attributes: {} },
				{ name: "tool_use", timestamp: "2025-01-01T10:00:01Z", attributes: {} },
			],
		};
		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
	});

	it("N3: a span missing attributes entirely no longer crashes the whole import (was an uncaught TypeError)", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z" }],
		};
		expect(() => importTrace(JSON.stringify(doc))).not.toThrow();
		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
	});

	it("N4: a wrongly-typed attributes.agent (a number) falls back to \"unknown\" instead of flowing through untyped", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: { agent: 12345 } }],
		};
		const jsonl: string[] = [];
		mockAppendLocal.mockImplementation((e) => jsonl.push(JSON.stringify(e)));
		importTrace(JSON.stringify(doc));
		expect(jsonl[0]).toContain('"agent":"unknown"');
	});

	it("N5: an empty-string attributes.agent also falls back to \"unknown\" (matches the pre-fix `||` fallback, not just absent)", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [{ name: "tool_use", timestamp: "2025-01-01T10:00:00Z", attributes: { agent: "" } }],
		};
		const jsonl: string[] = [];
		mockAppendLocal.mockImplementation((e) => jsonl.push(JSON.stringify(e)));
		importTrace(JSON.stringify(doc));
		expect(jsonl[0]).toContain('"agent":"unknown"');
	});

	it("N6: rejects a JSON document that parses but isn't an object (a bare number) — no crash, imports nothing", () => {
		mockReadLocal.mockReturnValue([]);
		const result = importTrace("42");
		expect(result).toEqual({ imported: 0, skipped: 0 });
	});
});
