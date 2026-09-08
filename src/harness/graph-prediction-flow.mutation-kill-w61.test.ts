import { makeMinimalEvent as completeEventFixture } from "./__tests__/fixtures/evaluator.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./graph-prediction-classifier.js", () => ({
	classifyCase: vi.fn(),
}));

import { classifyCase } from "./graph-prediction-classifier.js";
import { appendPredictionRow } from "./graph-prediction-cache.js";
import {
	buildShardInlineText,
	collectCachedPredictions,
	isReadOfShard,
	recordShardRead,
	slugFor,
	type ReconciledTarget,
} from "./graph-prediction-flow.js";
import type { CaseResult } from "./graph-prediction-classifier.js";
import type { HarnessEvent } from "./types.js";

const classifyCaseMock = vi.mocked(classifyCase);

function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
	return {
		case: "E-fresh",
		sourcePath: "src/foo.ts",
		shardPath: "src/foo.graph.json",
		sourceMtime: "S1",
		shardMtime: "M1",
		...overrides,
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return ({ ...completeEventFixture(), ...{
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		...overrides,
	} });
}

let tmpCwd: string;

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), "gpf-w61-"));
	classifyCaseMock.mockReset();
});

afterEach(() => {
	rmSync(tmpCwd, { recursive: true, force: true });
});

// ── collectCachedPredictions (dc1713c6e8bc0451) ──────────────────────────────

describe("collectCachedPredictions — missing-field guard", () => {
	it("skips a target whose shardPath is missing even though sourceMtime and shardMtime match a cached row", () => {
		const sessionId = "sess-cached";
		appendPredictionRow(tmpCwd, {
			session_id: sessionId,
			file_path: "src/foo.ts",
			source_mtime: "S1",
			shard_mtime: "M1",
			shard_path: "src/foo.graph.json",
			emitted_at: "2026-01-01T00:00:00.000Z",
			tool_input_hash: "hash1",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "complete",
		});
		const targets: CaseResult[] = [
			makeCaseResult({ shardPath: null, sourceMtime: "S1", shardMtime: "M1" }),
		];
		const result = collectCachedPredictions(tmpCwd, sessionId, targets);
		// Under the real guard, missing shardPath alone must skip the target —
		// the map must stay empty even though a matching row exists on disk.
		// Every LogicalOperator/ConditionalExpression mutation on this guard
		// bypasses the skip and finds the row, producing a non-empty map.
		expect(result.size).toBe(0);
	});

	it("caches a target whose fields are all present", () => {
		const sessionId = "sess-cached-2";
		appendPredictionRow(tmpCwd, {
			session_id: sessionId,
			file_path: "src/bar.ts",
			source_mtime: "S2",
			shard_mtime: "M2",
			shard_path: "src/bar.graph.json",
			emitted_at: "2026-01-01T00:00:00.000Z",
			tool_input_hash: "hash2",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "complete",
		});
		const targets: CaseResult[] = [
			makeCaseResult({ sourcePath: "src/bar.ts", shardPath: "src/bar.graph.json", sourceMtime: "S2", shardMtime: "M2" }),
		];
		const result = collectCachedPredictions(tmpCwd, sessionId, targets);
		expect(result.size).toBe(1);
		expect(result.get("src/bar.ts")?.file).toBe("src/bar.ts");
	});
});

// ── slugFor (6f5f2ea4a26845da) ───────────────────────────────────────────────

describe("slugFor — extension stripping", () => {
	it("strips the trailing extension using an empty-string replacement", () => {
		expect(slugFor("a/b/file.name.ts")).toBe("file_name");
	});
});

// ── isReadOfShard (842060acd7217301) ─────────────────────────────────────────

describe("isReadOfShard — tool-name gate", () => {
	it("returns false for a non-Read tool even when the path matches the shard pattern", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "src/foo.graph.json" },
		});
		expect(isReadOfShard(event)).toBe(false);
	});

	it("returns true for a Read tool whose file_path matches the shard pattern", () => {
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.graph.json" },
		});
		expect(isReadOfShard(event)).toBe(true);
	});

	it("returns false for a Read tool whose path does not match the shard pattern", () => {
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		expect(isReadOfShard(event)).toBe(false);
	});
});

// ── recordShardRead (e96ff3400b4f2f01) ───────────────────────────────────────

describe("recordShardRead — guards", () => {
	it("returns null and never classifies when neither file_path nor path is provided", () => {
		const event = makeEvent({
			tool_name: "Read",
			tool_input: {},
		});
		const result = recordShardRead(event, tmpCwd);
		expect(result).toBeNull();
		expect(classifyCaseMock).not.toHaveBeenCalled();
	});

	it("returns null and never classifies when the resolved shard path cannot cross a newline to reach the .graph suffix", () => {
		// `.` in the paired-source regex cannot match a newline. With the
		// original `^`-anchored regex, an absolute path containing a
		// newline before the `.graph` suffix produces NO match at all, so
		// `classifyCase` is never reached. Dropping the `^` anchor lets the
		// unanchored match start after the newline and succeed instead.
		const fp = "/tmp-shard\nrest.graph.json";
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: fp },
		});
		const result = recordShardRead(event, tmpCwd);
		expect(result).toBeNull();
		expect(classifyCaseMock).not.toHaveBeenCalled();
	});

	it("returns null without looking up a cached row when classification's shardPath alone is missing", () => {
		classifyCaseMock.mockReturnValue(
			makeCaseResult({ case: "E-fresh", shardPath: null, sourceMtime: "S1", shardMtime: "M1" }),
		);
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: "/proj/src/foo.graph.json" },
		});
		const result = recordShardRead(event, tmpCwd);
		expect(result).toBeNull();
	});

	it("records the shard read and returns allow when a matching cached row with no prior read exists", () => {
		const sessionId = "sess-record";
		classifyCaseMock.mockReturnValue(
			makeCaseResult({
				case: "E-fresh",
				sourcePath: "src/foo.ts",
				shardPath: "src/foo.graph.json",
				sourceMtime: "S1",
				shardMtime: "M1",
			}),
		);
		appendPredictionRow(tmpCwd, {
			session_id: sessionId,
			file_path: "src/foo.ts",
			source_mtime: "S1",
			shard_mtime: "M1",
			shard_path: "src/foo.graph.json",
			emitted_at: "2026-01-01T00:00:00.000Z",
			tool_input_hash: "hash1",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "complete",
			shard_read_at: null,
		});
		const event = makeEvent({
			session_id: sessionId,
			tool_name: "Read",
			tool_input: { file_path: "/proj/src/foo.graph.json" },
			timestamp: "2026-01-02T00:00:00.000Z",
		});
		const result = recordShardRead(event, tmpCwd);
		expect(result?.decision).toBe("allow");
		expect(result?.additional_context).toContain("src/foo.ts");
	});
});

// ── buildShardInlineText (b94f059306df3346) ──────────────────────────────────

describe("buildShardInlineText", () => {
	function makeReconciled(shardPath: string | null, sourcePath = "src/foo.ts"): ReconciledTarget {
		return {
			classification: makeCaseResult({ shardPath, sourcePath }),
			severity: {
				severity: "low",
				decision: "reveal_and_allow",
				triggers: [],
				high_impact_oracle: false,
				per_section_score: {},
				weighted_avg: 0,
				miss_set: {},
			},
			oracle: null,
		};
	}

	it("includes the descriptive heading line with source path and shard path", () => {
		const dir = mkdtempSync(join(tmpdir(), "gpf-shard-"));
		const shardFile = join(dir, "foo.graph.json");
		writeFileSync(shardFile, "hello");
		const text = buildShardInlineText([makeReconciled(shardFile, "src/foo.ts")]);
		expect(text).toContain(`Oracle shard for src/foo.ts (${shardFile}):`);
		rmSync(dir, { recursive: true, force: true });
	});

	it("emits a leading blank line before the heading for each entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "gpf-shard-blank-"));
		const shardFile = join(dir, "foo.graph.json");
		writeFileSync(shardFile, "hello");
		const text = buildShardInlineText([makeReconciled(shardFile, "src/foo.ts")]);
		expect(text.split("\n")[0]).toBe("");
		rmSync(dir, { recursive: true, force: true });
	});

	it("trims only trailing whitespace from the shard body, not leading", () => {
		const dir = mkdtempSync(join(tmpdir(), "gpf-shard-trim-"));
		const shardFile = join(dir, "foo.graph.json");
		writeFileSync(shardFile, "line1\nline2\n   ");
		const text = buildShardInlineText([makeReconciled(shardFile, "src/foo.ts")]);
		const linesArr = text.split("\n");
		expect(linesArr[linesArr.length - 1]).toBe("line2");
	});

	it("joins output lines with real newline characters", () => {
		const dir = mkdtempSync(join(tmpdir(), "gpf-shard-join-"));
		const shardFile = join(dir, "foo.graph.json");
		writeFileSync(shardFile, "nobreaks");
		const text = buildShardInlineText([makeReconciled(shardFile, "src/foo.ts")]);
		expect(text.includes("\n")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});
