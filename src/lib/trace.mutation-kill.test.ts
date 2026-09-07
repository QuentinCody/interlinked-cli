import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock local-activity — same contract as the companion __tests__/trace.test.ts mock.
vi.mock("./local-activity.js", () => ({
	readLocalActivity: vi.fn(),
	appendLocalActivity: vi.fn(),
}));

import type { LocalActivityEvent } from "./local-activity.js";
import { appendLocalActivity, readLocalActivity } from "./local-activity.js";
import { exportTrace, importTrace, type ImportTraceResult } from "./trace.js";

const mockReadLocal = vi.mocked(readLocalActivity);
const mockAppendLocal = vi.mocked(appendLocalActivity);

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("exportTrace — options handling", () => {
	// test-contract: public-api — exportTrace() with no arguments must not
	// throw; every opts?.field read has to stay optional-chained since opts
	// itself is undefined on this call.
	it("does not throw when called with no options object at all", () => {
		mockReadLocal.mockReturnValue([]);
		expect(() => exportTrace()).not.toThrow();
	});

	// test-contract: public-api — the object passed to readLocalActivity must
	// carry the resolved since/agent/limit/cwd values, not a dropped/blank shape.
	it("passes the exact read-activity filter shape through to readLocalActivity", () => {
		mockReadLocal.mockReturnValue([]);
		vi.spyOn(Date, "now").mockReturnValue(20_000);
		const output = exportTrace({ since: "1m", agent: "agent-9", cwd: "/proj" });
		expect(mockReadLocal).toHaveBeenCalledWith({
			since: 20_000 - 60_000,
			agent: "agent-9",
			limit: 10000,
			cwd: "/proj",
		});
		expect(JSON.parse(output).spans).toEqual([]);
	});

	// test-contract: public-api — JSONL output must separate spans with a real
	// newline; each line has to be independently JSON-parseable.
	it("joins JSONL spans with a real newline between them", () => {
		mockReadLocal.mockReturnValue([
			{ ts: "2029-01-01T00:00:00Z", agent: "a1", type: "e1", tool: null, summary: null, session: "s1", hook: null },
			{ ts: "2029-01-01T00:00:01Z", agent: "a1", type: "e2", tool: null, summary: null, session: "s1", hook: null },
		]);
		const result = exportTrace({ format: "jsonl" });
		const lines = result.split("\n");
		expect(lines).toHaveLength(3); // two spans + trailing empty segment after the final \n
		const line0 = lines[0] ?? "";
		const line1 = lines[1] ?? "";
		expect(() => JSON.parse(line0)).not.toThrow();
		expect(() => JSON.parse(line1)).not.toThrow();
		expect(JSON.parse(line0).name).toBe("e1");
		expect(JSON.parse(line1).name).toBe("e2");
	});
});

describe("exportTrace — per-span field derivation", () => {
	// test-contract: public-api — every derived span field (trace_id fallback,
	// span_id digits-only suffix, duration_ms/summary/hook/subagent_id
	// passthrough) must carry its real computed value, not a placeholder.
	it("derives every span field from a fully-populated event with its real value", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2031-07-04T08:09:10.123Z",
				agent: "agent-Q",
				type: "custom_event",
				tool: "ToolX",
				summary: "sum-Y",
				session: "sess-XYZ",
				hook: "HookZ",
				duration_ms: 777,
				tokens: { input: 1, output: 2 },
				parent_agent: "parent-1",
				subagent_id: "sub-99",
			},
		]);

		const doc = JSON.parse(exportTrace({ format: "json" }));

		expect(doc.spans[0]).toEqual({
			trace_id: "sess-XYZ",
			span_id: "span-0-20310704080910",
			name: "custom_event",
			timestamp: "2031-07-04T08:09:10.123Z",
			duration_ms: 777,
			attributes: {
				agent: "agent-Q",
				tool: "ToolX",
				summary: "sum-Y",
				hook: "HookZ",
				tokens: { input: 1, output: 2 },
				parent_agent: "parent-1",
				subagent_id: "sub-99",
			},
		});
	});

	// test-contract: public-api — when ts is absent, span_id/trace_id must fall
	// back to the index/"unknown" path instead of throwing (e.ts?.replace has
	// to stay optional-chained).
	it("falls back safely on span_id/trace_id when ts and session are both absent", () => {
		// SAFETY: ts is intentionally the wrong (absent) shape to exercise the
		// e.ts?.replace optional-chaining fallback path; LocalActivityEvent
		// normally requires ts, but the exported event array is untyped JSON
		// at the harness boundary and can legitimately omit it.
		mockReadLocal.mockReturnValue([
			{
				ts: undefined,
				agent: "a1",
				type: "t1",
				tool: null,
				summary: null,
				session: null,
				hook: null,
			} as unknown as LocalActivityEvent,
		]);
		expect(() => exportTrace({ format: "json" })).not.toThrow();
		const doc = JSON.parse(exportTrace({ format: "json" }));
		expect(doc.spans[0].trace_id).toBe("trace-unknown");
		expect(doc.spans[0].span_id).toBe("span-0-0");
	});
});

describe("extractDocumentSpans (via importTrace)", () => {
	// test-contract: boundary — a wrong-format envelope must be rejected even
	// though it happens to carry a valid-looking spans array; only the exact
	// "interlinked-trace" format plus Array.isArray(spans) combination may pass.
	it("rejects an envelope whose format does not match, despite a valid spans array", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "not-a-trace",
			version: 1,
			spans: [{ name: "marker-span", timestamp: "2020-01-01T00:00:00Z", attributes: {} }],
		};
		expect(importTrace(JSON.stringify(doc))).toEqual({ imported: 0, skipped: 0 });
		expect(mockReadLocal).not.toHaveBeenCalled();
	});
});

describe("importTrace — dedup-read gating and filter shape", () => {
	// test-contract: public-api — zero parsed spans must short-circuit before
	// any storage read; a downstream .map() on an unconfigured mock would throw
	// if the early return were skipped.
	it("skips the storage read entirely when input parses to zero spans", () => {
		const result = importTrace("[]");
		expect(result).toEqual({ imported: 0, skipped: 0 });
		expect(mockReadLocal).not.toHaveBeenCalled();
		expect(mockAppendLocal).not.toHaveBeenCalled();
	});

	// test-contract: public-api — the dedup read must carry the real cwd, not a
	// dropped/blank filter object.
	it("passes the exact dedup-read filter (limit + cwd) to readLocalActivity", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "x",
			spans: [{ name: "n", timestamp: "2029-01-01T00:00:00Z", attributes: {} }],
		};
		const result = importTrace(JSON.stringify(doc), "/proj/dir");
		expect(mockReadLocal).toHaveBeenCalledWith({ limit: 50000, cwd: "/proj/dir" });
		expect(result).toEqual({ imported: 1, skipped: 0 });
	});
});

describe("importTrace — per-span field derivation (tool/summary/session)", () => {
	// test-contract: public-api — tool/summary/session must resolve per-span
	// exactly: a valid string passes through, a wrong-typed value is dropped to
	// null (never leaks the raw non-string value), and an empty-but-correctly-
	// typed string also resolves to null (matches the pre-fix `||` fallback).
	it("resolves tool/summary/session with type-correct, exact per-span values", () => {
		mockReadLocal.mockReturnValue([]);
		const captured: LocalActivityEvent[] = [];
		mockAppendLocal.mockImplementation((e) => {
			captured.push(e);
		});

		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2029-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "trace-A",
					name: "event-A",
					timestamp: "2029-01-01T00:00:00Z",
					attributes: { tool: "RealTool", summary: "RealSummary" },
				},
				{
					trace_id: 12345,
					name: "event-B",
					timestamp: "2029-01-02T00:00:00Z",
					attributes: { tool: 42, summary: 99 },
				},
				{
					name: "event-C",
					timestamp: "2029-01-03T00:00:00Z",
					attributes: { tool: "", summary: "" },
				},
			],
		};

		const result = importTrace(JSON.stringify(doc));
		expect(result).toEqual({ imported: 3, skipped: 0 });
		expect(captured).toEqual([
			{
				ts: "2029-01-01T00:00:00Z",
				agent: "unknown",
				type: "event-A",
				tool: "RealTool",
				summary: "RealSummary",
				session: "trace-A",
			},
			{
				ts: "2029-01-02T00:00:00Z",
				agent: "unknown",
				type: "event-B",
				tool: null,
				summary: null,
				session: null,
			},
			{
				ts: "2029-01-03T00:00:00Z",
				agent: "unknown",
				type: "event-C",
				tool: null,
				summary: null,
				session: null,
			},
		]);
	});
});

describe("parseImportedSpan / parseImportedSpans robustness (via importTrace)", () => {
	// test-contract: bug — a null entry inside a JSON envelope's spans array
	// must be dropped without discarding its valid siblings (guards the
	// non-object-input guard against being bypassed).
	it("filters a null span out of a JSON envelope without discarding valid siblings", () => {
		mockReadLocal.mockReturnValue([]);
		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2029-01-01T00:00:00Z",
			spans: [null, { name: "keep-me", timestamp: "2029-01-01T00:00:00Z", attributes: {} }],
		};
		expect(importTrace(JSON.stringify(doc))).toEqual({ imported: 1, skipped: 0 });
	});

	// test-contract: bug — the JSONL fallback loop must never push a null parse
	// result into the spans array; a null entry there would crash the import
	// loop's `span.attributes.tool` read.
	it("never lets a malformed JSONL line reach the import loop as a null span", () => {
		mockReadLocal.mockReturnValue([]);
		const jsonl = [
			JSON.stringify({ timestamp: "2029-01-01T00:00:00Z", attributes: {} }), // missing name
			JSON.stringify({ name: "valid-line", timestamp: "2029-01-01T00:00:01Z", attributes: {} }),
		].join("\n");
		let result: ImportTraceResult | undefined;
		expect(() => {
			result = importTrace(jsonl);
		}).not.toThrow();
		expect(result).toEqual({ imported: 1, skipped: 0 });
	});

	// test-contract: invariant — a blank line in JSONL input must not change the
	// imported count (documents the pre-filter's observable contract).
	it("ignores blank lines in JSONL input without affecting the imported count", () => {
		mockReadLocal.mockReturnValue([]);
		const jsonl = [
			JSON.stringify({ name: "line-1", timestamp: "2029-01-01T00:00:00Z", attributes: {} }),
			"",
			JSON.stringify({ name: "line-2", timestamp: "2029-01-01T00:00:01Z", attributes: {} }),
			"",
		].join("\n");
		expect(importTrace(jsonl)).toEqual({ imported: 2, skipped: 0 });
	});
});
