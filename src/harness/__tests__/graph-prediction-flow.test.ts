import { nonNull } from "../../lib/non-null.js";
// ===========================================
// graph-prediction-flow.ts — unit tests for the extracted flow helpers
// ===========================================
// Companion to graph-prediction-pre-tool.test.ts (which exercises the
// driver end-to-end). Here we call the individual flow helpers directly —
// cache lookup, reconciliation, and the text builders — including the
// branch edges the end-to-end driver never happens to hit.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendPredictionRow, findPredictionRow } from "../graph-prediction-cache.js";
import {
	classifyCase,
	resetWorkspaceActiveCache,
	type CaseResult,
} from "../graph-prediction-classifier.js";
import {
	buildAckReason,
	buildAckSentinelInstruction,
	buildChallengeReason,
	buildReconciliationRow,
	buildRevealText,
	buildShardInlineText,
	buildShardReadRequiredReason,
	collectCachedPredictions,
	isReadOfShard,
	recordShardRead,
	reconcileEachTarget,
	slugFor,
	type ReconciledTarget,
} from "../graph-prediction-flow.js";
import type { ParsedGraphPrediction } from "../graph-prediction-parser.js";
import type { SeverityResult } from "../graph-prediction-reconcile.js";
import type { SupermodelGraph } from "../supermodel-graph.js";
import type { HarnessEvent } from "../types.js";

let dir: string;

function setMtime(path: string, ms: number): void {
	const seconds = ms / 1000;
	utimesSync(path, seconds, seconds);
}

function readEvent(filePath: string, key: "file_path" | "path" = "file_path", timestamp = "2026-05-10T12:05:00Z"): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Read",
		tool_input: { [key]: filePath },
		timestamp,
	};
}

/** Fully-populated fixture — every field of {@link SeverityResult} present
 *  so a test can override just what it cares about. */
const fakeSeverity: SeverityResult = {
	severity: "low",
	decision: "reveal_and_allow",
	triggers: [],
	high_impact_oracle: false,
	per_section_score: {},
	weighted_avg: 0,
	miss_set: {},
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-flow-"));
	resetWorkspaceActiveCache();
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
	writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetWorkspaceActiveCache();
});

// ── collectCachedPredictions ─────────────────────────────────────────────

describe("collectCachedPredictions", () => {
	it("skips a target with no shard/mtime info (Case D)", () => {
		writeFileSync(join(dir, "src", "noshard.ts"), "export {}");
		const target = classifyCase(join(dir, "src", "noshard.ts"), dir);
		expect(target.case).toBe("D");
		const map = collectCachedPredictions(dir, "sess-1", [target]);
		expect(map.size).toBe(0);
	});

	it("skips an E-fresh target with no cached row", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh0.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh0.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh0.ts"), t);
		setMtime(join(dir, "src", "fresh0.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "fresh0.ts"), dir);
		expect(target.case).toBe("E-fresh");
		const map = collectCachedPredictions(dir, "sess-1", [target]);
		expect(map.size).toBe(0);
	});

	it("includes a cached complete row with parse_status 'ok'", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh1.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh1.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh1.ts"), t);
		setMtime(join(dir, "src", "fresh1.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "fresh1.ts"), dir);
		expect(target.case).toBe("E-fresh");
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "complete",
		});
		const map = collectCachedPredictions(dir, "sess-1", [target]);
		expect(map.get(target.sourcePath)).toEqual({
			file: target.sourcePath,
			deps: { imports: [], imported_by: [] },
			calls: { callers: [], callees: [] },
			impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			parse_status: "ok",
		});
	});

	it("carries a parse_failed comparison_status forward as 'format_violation'", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh2.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh2.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh2.ts"), t);
		setMtime(join(dir, "src", "fresh2.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "fresh2.ts"), dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "parse_failed",
		});
		const map = collectCachedPredictions(dir, "sess-1", [target]);
		expect(map.get(target.sourcePath)?.parse_status).toBe("format_violation");
	});
});

// ── reconcileEachTarget ───────────────────────────────────────────────────

describe("reconcileEachTarget", () => {
	it("skips a target with no prediction in the map", () => {
		writeFileSync(join(dir, "src", "fresh3.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh3.graph.ts"), "// @generated");
		const target = classifyCase(join(dir, "src", "fresh3.ts"), dir);
		const out = reconcileEachTarget(dir, [target], new Map());
		expect(out).toEqual([]);
	});

	it("skips a target whose oracle cannot be resolved (non-fresh case, no graph fallback)", () => {
		// Case C: greenfield file (doesn't exist on disk yet).
		const target = classifyCase(join(dir, "src", "ghost.ts"), dir);
		expect(target.case).toBe("C");
		const predictions = new Map<string, ParsedGraphPrediction>();
		predictions.set(target.sourcePath, {
			file: target.sourcePath,
			deps: null,
			calls: null,
			impact: null,
			parse_status: "ok",
		});
		const out = reconcileEachTarget(dir, [target], predictions);
		expect(out).toEqual([]);
	});

	it("reconciles an E-fresh target with a cached prediction against the shard oracle", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "ok.ts"), "export {}");
		writeFileSync(
			join(dir, "src", "ok.graph.ts"),
			["// @generated supermodel-sidecar", "// [impact]", "// risk        LOW", "// direct      0", "// transitive  0"].join(
				"\n",
			),
		);
		setMtime(join(dir, "src", "ok.ts"), t);
		setMtime(join(dir, "src", "ok.graph.ts"), t);
		const target = classifyCase(join(dir, "src", "ok.ts"), dir);
		expect(target.case).toBe("E-fresh");
		const predictions = new Map<string, ParsedGraphPrediction>();
		predictions.set(target.sourcePath, {
			file: target.sourcePath,
			deps: { imports: [], imported_by: [] },
			calls: { callers: [], callees: [] },
			impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			parse_status: "ok",
		});
		const out = reconcileEachTarget(dir, [target], predictions);
		expect(out).toHaveLength(1);
		expect(out[0]?.classification).toBe(target);
		expect(out[0]?.oracle).not.toBeNull();
		expect(out[0]?.severity.severity).toBe("low");
	});
});

// ── buildReconciliationRow / summarizeOracle / summarizePrediction ───────

describe("buildReconciliationRow", () => {
	const classificationFull: CaseResult = {
		case: "E-fresh",
		sourcePath: "/repo/a.ts",
		shardPath: "/repo/a.graph.ts",
		sourceMtime: "2026-01-01T00:00:00.000Z",
		shardMtime: "2026-01-01T00:00:05.000Z",
	};
	const predictionEmpty: ParsedGraphPrediction = {
		file: "/repo/a.ts",
		deps: null,
		calls: null,
		impact: null,
		parse_status: "ok",
	};

	it("summarizes a null oracle as all-unknown, zero counts", () => {
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationFull,
			prediction: predictionEmpty,
			severity: fakeSeverity,
			oracle: null,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.oracle_summary).toEqual({
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		});
		expect(row.source_mtime).toBe("2026-01-01T00:00:00.000Z");
		expect(row.shard_mtime).toBe("2026-01-01T00:00:05.000Z");
		expect(row.prediction_summary).toEqual({
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		});
	});

	it("falls back to empty-string mtimes when the classification has none", () => {
		const classificationNoMtime: CaseResult = {
			case: "A",
			sourcePath: "/repo/c.ts",
			shardPath: null,
			sourceMtime: null,
			shardMtime: null,
		};
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationNoMtime,
			prediction: predictionEmpty,
			severity: fakeSeverity,
			oracle: null,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.source_mtime).toBe("");
		expect(row.shard_mtime).toBe("");
	});

	it("summarizes a non-null oracle whose sections all failed to parse", () => {
		const oracle: SupermodelGraph = {
			shardPath: "/repo/a.graph.ts",
			sourcePath: "/repo/a.ts",
			impact: null,
			calls: null,
			deps: null,
		};
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationFull,
			prediction: predictionEmpty,
			severity: fakeSeverity,
			oracle,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.oracle_summary).toEqual({
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		});
	});

	it("summarizes a real oracle with impact/deps/calls populated", () => {
		const oracle: SupermodelGraph = {
			shardPath: "/repo/a.graph.ts",
			sourcePath: "/repo/a.ts",
			impact: { risk: "HIGH", domains: ["x", "y"], direct: 3, transitive: 4, affects: ["p.ts"] },
			calls: { callers: [{ fn: "f", caller: "g", file: "c.ts", line: 1 }], callees: [] },
			deps: { imports: [], importedBy: ["i1.ts", "i2.ts"] },
		};
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationFull,
			prediction: predictionEmpty,
			severity: fakeSeverity,
			oracle,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.oracle_summary).toEqual({
			risk: "HIGH",
			direct: 3,
			transitive: 4,
			domains_count: 2,
			importers_count: 2,
			callers_count: 1,
		});
	});

	it("counts array-typed prediction sections", () => {
		const prediction: ParsedGraphPrediction = {
			file: "/repo/a.ts",
			deps: { imports: ["x.ts"], imported_by: ["y.ts", "z.ts"] },
			calls: { callers: ["f ← g"], callees: [] },
			impact: { risk: "medium", domains: ["d1"], direct: 1, transitive: 2, affects: [] },
			parse_status: "ok",
		};
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationFull,
			prediction,
			severity: fakeSeverity,
			oracle: null,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.prediction_summary).toEqual({
			risk: "medium",
			direct: 1,
			transitive: 2,
			domains_count: 1,
			importers_count: 2,
			callers_count: 1,
		});
	});

	it("treats 'unknown'-sentinel prediction sections as zero counts", () => {
		const prediction: ParsedGraphPrediction = {
			file: "/repo/a.ts",
			deps: { imports: "unknown", imported_by: "unknown" },
			calls: { callers: "unknown", callees: "unknown" },
			impact: { risk: "unknown", domains: "unknown", direct: "unknown", transitive: "unknown", affects: "unknown" },
			parse_status: "ok",
		};
		const row = buildReconciliationRow({
			sessionId: "s1",
			classification: classificationFull,
			prediction,
			severity: fakeSeverity,
			oracle: null,
			reconciledAt: "2026-01-01T00:01:00.000Z",
		});
		expect(row.prediction_summary).toEqual({
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		});
	});
});

// ── slugFor ────────────────────────────────────────────────────────────────

describe("slugFor", () => {
	it("strips the extension and replaces unsafe characters", () => {
		expect(slugFor("src/components/My File!.tsx")).toBe("My_File_");
	});

	it("uses the whole string when there is no path separator", () => {
		expect(slugFor("bare.ts")).toBe("bare");
	});

	it("strips only the final extension from a dotted basename", () => {
		expect(slugFor("src/my.component.test.ts")).toBe("my_component_test");
	});

	it("falls back to 'target' when stripping leaves an empty string", () => {
		expect(slugFor(".ts")).toBe("target");
	});
});

// ── buildChallengeReason ──────────────────────────────────────────────────

describe("buildChallengeReason", () => {
	const missingOne: CaseResult[] = [
		{ case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: "/repo/a.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
	];

	it("omits the informational section when every target is E-fresh", () => {
		const text = buildChallengeReason(missingOne, missingOne, "sess-1", "/repo");
		expect(text).not.toContain("Other files in this edit are observation-only");
	});

	it("lists non-E-fresh files in a separate informational section", () => {
		const other: CaseResult = { case: "D", sourcePath: "/repo/b.ts", shardPath: null, sourceMtime: null, shardMtime: null };
		const text = buildChallengeReason(missingOne, [...missingOne, other], "sess-1", "/repo");
		expect(text).toContain("Other files in this edit are observation-only (no challenge):");
		expect(text).toContain("/repo/b.ts (Case D)");
	});

	it("emits the complete prediction template and protocol guidance", () => {
		const text = buildChallengeReason(missingOne, missingOne, "sess-1", "/repo");
		expect(text).toBe([
			"[interlinked:graph-pred] graph_prediction required before this edit can proceed.",
			"",
			"Authoritative oracle (Supermodel `.graph.*` shard, fresh) for:",
			"  /repo/a.ts",
			"    → submit prediction by writing to: .interlinked/predictions/incoming/sess-1/a.yaml",
			"",
			"Use the Write tool. Bare YAML; no fences needed. Format:",
			"  graph_prediction:",
			"    file: <absolute or repo-relative path to the edit target>",
			"    deps:",
			"      imports: [<paths>] | unknown",
			"      imported_by: [<paths>] | unknown",
			"    calls:",
			"      callers: [<\"fn ← caller\">] | unknown",
			"      callees: [<\"fn → callee\">] | unknown",
			"    impact:",
			"      risk: low | medium | high | unknown",
			"      domains: [<strings>] | unknown",
			"      direct: <int> | unknown",
			"      transitive: <int> | unknown",
			"      affects: [<paths>] | unknown",
			"",
			"After the Write succeeds, retry the original edit. See",
			"`docs/design/graph-prediction-protocol.md §6` for full format spec.",
		].join("\n"));
	});
});

// ── buildAckReason / buildAckSentinelInstruction ──────────────────────────

describe("buildAckReason", () => {
	it("lists each flagged file with its comma-joined triggers", () => {
		const flagged: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: "/repo/a.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
				severity: { ...fakeSeverity, triggers: ["risk_underestimated_low_to_high", "imported_by_recall_low"] },
				oracle: null,
			},
		];
		expect(buildAckReason(flagged)).toBe(
			"[interlinked:graph-pred] Acknowledge before proceeding.\n  /repo/a.ts: risk_underestimated_low_to_high, imported_by_recall_low",
		);
	});
});

describe("buildAckSentinelInstruction", () => {
	it("emits the ack-write path and each trigger for a flagged file", () => {
		const flagged: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/src/a.ts", shardPath: "/repo/src/a.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
				severity: { ...fakeSeverity, triggers: ["risk_underestimated_low_to_high"] },
				oracle: null,
			},
		];
		const text = buildAckSentinelInstruction(flagged, "sess-9");
		expect(text).toContain("/repo/src/a.ts");
		expect(text).toContain(".interlinked/predictions/ack/sess-9/a.yaml");
		expect(text).toContain("        - risk_underestimated_low_to_high");
	});

	it("preserves the complete ack template and strips only the final extension", () => {
		const flagged: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/src/a.snapshot.ts", shardPath: "/repo/src/a.snapshot.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
				severity: { ...fakeSeverity, triggers: ["risk_underestimated_low_to_high", "imported_by_recall_low"] },
				oracle: null,
			},
		];
		expect(buildAckSentinelInstruction(flagged, "sess-9")).toBe([
			"",
			"To acknowledge, Write the bare YAML below to the named sentinel path (one Write per flagged file):",
			"",
			"  → .interlinked/predictions/ack/sess-9/a.snapshot.yaml",
			"    graph_prediction_ack:",
			"      file: /repo/src/a.snapshot.ts",
			"      acknowledged_triggers:",
			"        - risk_underestimated_low_to_high",
			"        - imported_by_recall_low",
			"",
			"After all acks land, retry the original Edit. See `docs/design/graph-prediction-protocol.md §7.6`.",
		].join("\n").replace(/^/, "\n"));
	});
});

// ── buildRevealText ────────────────────────────────────────────────────────

describe("buildRevealText", () => {
	it("includes a triggers line when triggers are present", () => {
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: "/repo/a.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
				severity: {
					...fakeSeverity,
					severity: "medium",
					triggers: ["risk_underestimated_low_to_high"],
					per_section_score: { "deps.imports": 1, "impact.risk": 0.7 },
					weighted_avg: 0.85,
				},
				oracle: null,
			},
		];
		const text = buildRevealText(reconciled);
		expect(text).toContain("triggers: risk_underestimated");
		expect(text).toContain("weighted_avg (telemetry): 0.85");
		expect(text).toContain("severity: medium");
	});

	it("omits the triggers line when there are none", () => {
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: null, sourceMtime: null, shardMtime: null },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		expect(buildRevealText(reconciled)).not.toContain("triggers:");
	});

	it("renders every scored section, trigger separator, and line break", () => {
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: null, sourceMtime: null, shardMtime: null },
				severity: {
					...fakeSeverity,
					triggers: ["risk_underestimated_low_to_high", "imported_by_recall_low"],
					per_section_score: { "deps.imports": 1, "impact.risk": 0.7 },
					weighted_avg: 0.85,
					severity: "medium",
				},
				oracle: null,
			},
		];
		expect(buildRevealText(reconciled)).toBe([
			"[interlinked:graph-pred] Comparison for /repo/a.ts:",
			"  deps.imports: 1.00",
			"  impact.risk: 0.70",
			"  triggers: risk_underestimated_low_to_high, imported_by_recall_low",
			"  weighted_avg (telemetry): 0.85",
			"  severity: medium",
		].join("\n"));
	});
});

// ── isReadOfShard ────────────────────────────────────────────────────────

describe("isReadOfShard", () => {
	it("true for a Read tool call on a .graph.ts path via file_path", () => {
		expect(isReadOfShard(readEvent("/repo/a.graph.ts"))).toBe(true);
	});

	it("true for a 'view' tool call on a shard using 'path' instead of file_path", () => {
		const event = { ...readEvent("/repo/a.graph", "path"), tool_name: "view" };
		expect(isReadOfShard(event)).toBe(true);
	});

	it.each(["ReadFile", "read_file"])("true for the %s tool name", (tool_name) => {
		const event = { ...readEvent("/repo/a.graph.ts"), tool_name };
		expect(isReadOfShard(event)).toBe(true);
	});

	it("false for a non-shard file path", () => {
		expect(isReadOfShard(readEvent("/repo/a.ts"))).toBe(false);
	});

	it("false for a non-read tool", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			timestamp: "t",
		};
		expect(isReadOfShard(event)).toBe(false);
	});

	it("false when tool_input has neither file_path nor path", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: {},
			timestamp: "t",
		};
		expect(isReadOfShard(event)).toBe(false);
	});

	it("does not treat a shard-looking suffix as a shard path", () => {
		expect(isReadOfShard(readEvent("/repo/a.graph.ts.backup"))).toBe(false);
	});

	it("handles an event with no tool_input", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Read",
			timestamp: "t",
		};
		expect(isReadOfShard(event)).toBe(false);
	});
});

// ── recordShardRead ────────────────────────────────────────────────────────

describe("recordShardRead", () => {
	it("returns null when tool_input has neither file_path nor path", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: {},
			timestamp: "t",
		};
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("returns null when the path does not match the shard filename pattern", () => {
		const event = readEvent(join(dir, "src", "anchor.ts"));
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("returns null when the paired source resolves to a non-E-fresh case", () => {
		// ghost.graph.ts pairs with ghost.ts, which does not exist -> Case C.
		const event = readEvent(join(dir, "src", "ghost.graph.ts"));
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("does not record a read for an E-stale shard, even when a cached row exists", () => {
		const source = join(dir, "src", "stale.ts");
		const shard = join(dir, "src", "stale.graph.ts");
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(source, "export {}");
		writeFileSync(shard, "// @generated");
		setMtime(source, t);
		setMtime(shard, t - 120_000);
		const target = classifyCase(source, dir);
		expect(target.case).toBe("E-stale");
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "pending",
		});
		expect(recordShardRead(readEvent(shard), dir)).toBeNull();
	});

	it("rejects a path with extra characters after the shard suffix", () => {
		const source = join(dir, "src", "suffix.ts");
		const shard = join(dir, "src", "suffix.graph.ts");
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(source, "export {}");
		writeFileSync(shard, "// @generated");
		setMtime(source, t);
		setMtime(shard, t + 30_000);
		const target = classifyCase(source, dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "pending",
		});
		expect(recordShardRead(readEvent(`${shard}.backup`), dir)).toBeNull();
	});

	it("resolves a relative shard path against cwd and records the read", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "rel.ts"), "export {}");
		writeFileSync(join(dir, "src", "rel.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "rel.ts"), t);
		setMtime(join(dir, "src", "rel.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "rel.ts"), dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "pending",
		});
		const event = readEvent(join("src", "rel.graph.ts"));
		const result = recordShardRead(event, dir);
		expect(result?.decision).toBe("allow");
		expect(result?.additional_context).toContain("Shard read recorded");
	});

	it("reads the shard location from tool_input.path when file_path is absent", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "viakey.ts"), "export {}");
		writeFileSync(join(dir, "src", "viakey.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "viakey.ts"), t);
		setMtime(join(dir, "src", "viakey.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "viakey.ts"), dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "pending",
		});
		const event = readEvent(nonNull(target.shardPath), "path");
		const result = recordShardRead(event, dir);
		expect(result?.decision).toBe("allow");
	});

	it("returns null when no cached prediction row exists yet for the shard", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "nocache.ts"), "export {}");
		writeFileSync(join(dir, "src", "nocache.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "nocache.ts"), t);
		setMtime(join(dir, "src", "nocache.graph.ts"), t + 30_000);
		const event = readEvent(join(dir, "src", "nocache.graph.ts"));
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("returns null when the shard was already recorded as read (last-write-wins)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "already.ts"), "export {}");
		writeFileSync(join(dir, "src", "already.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "already.ts"), t);
		setMtime(join(dir, "src", "already.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "already.ts"), dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "pending",
			shard_read_at: "2026-05-10T12:02:00Z",
		});
		const event = readEvent(nonNull(target.shardPath));
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("falls back to the current time when event.timestamp is empty", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "notime.ts"), "export {}");
		writeFileSync(join(dir, "src", "notime.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "notime.ts"), t);
		setMtime(join(dir, "src", "notime.graph.ts"), t + 30_000);
		const target = classifyCase(join(dir, "src", "notime.ts"), dir);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
			},
			comparison_status: "pending",
		});
		const event = readEvent(nonNull(target.shardPath), "file_path", "");
		const result = recordShardRead(event, dir);
		expect(result?.decision).toBe("allow");
		const row = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
		});
		expect(row?.shard_read_at).toEqual(expect.any(String));
		expect(row?.shard_read_at).not.toBe("");
	});

	it("derives the source path for an extension-less shard filename (m[2] undefined)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "Makefile"), "all:\n\techo hi\n");
		writeFileSync(join(dir, "src", "Makefile.graph"), "// @generated");
		setMtime(join(dir, "src", "Makefile"), t);
		setMtime(join(dir, "src", "Makefile.graph"), t + 30_000);
		// No cached row: exercises the m[2]-undefined path through to a clean
		// "no prior row" null without throwing.
		const event = readEvent(join(dir, "src", "Makefile.graph"));
		expect(recordShardRead(event, dir)).toBeNull();
	});

	it("records an extension-less shard when its cached row exists", () => {
		const source = join(dir, "src", "PlainName");
		const shard = join(dir, "src", "PlainName.graph");
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(source, "export {}");
		writeFileSync(shard, "// @generated");
		setMtime(source, t);
		setMtime(shard, t + 30_000);
		const target = classifyCase(source, dir);
		expect(target.case).toBe("E-fresh");
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: target.sourcePath,
			source_mtime: nonNull(target.sourceMtime),
			shard_mtime: nonNull(target.shardMtime),
			shard_path: nonNull(target.shardPath),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: { deps: null, calls: null, impact: null },
			comparison_status: "pending",
		});
		expect(recordShardRead(readEvent(shard), dir)?.decision).toBe("allow");
	});

	it("handles an event with no tool_input", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Read",
			timestamp: "t",
		};
		expect(recordShardRead(event, dir)).toBeNull();
	});
});

// ── buildShardReadRequiredReason ──────────────────────────────────────────

describe("buildShardReadRequiredReason", () => {
	it("lists a Read line for each entry that has a shardPath", () => {
		const needsRead: CaseResult[] = [
			{ case: "E-fresh", sourcePath: "/repo/a.ts", shardPath: "/repo/a.graph.ts", sourceMtime: "t1", shardMtime: "t2" },
		];
		expect(buildShardReadRequiredReason(needsRead)).toContain("Read /repo/a.graph.ts");
	});

	it("skips entries with no shardPath", () => {
		const needsRead: CaseResult[] = [{ case: "D", sourcePath: "/repo/b.ts", shardPath: null, sourceMtime: null, shardMtime: null }];
		const text = buildShardReadRequiredReason(needsRead);
		expect(text).not.toContain("/repo/b.ts");
		expect(text.split("\n")).toHaveLength(4); // header lines only, no per-target line appended
	});

	it("keeps the full enforced-mode instructions verbatim", () => {
		expect(buildShardReadRequiredReason([])).toBe([
			"[interlinked:graph-pred] Read the oracle shard before this Edit can proceed.",
			"Enforced mode requires the agent to actually consume the .graph.* file so its mental model updates from the source of truth, not just the diff summary.",
			"",
			"Call the Read tool on each shard listed below, then retry the Edit:",
		].join("\n"));
	});
});

// ── buildShardInlineText ──────────────────────────────────────────────────

describe("buildShardInlineText", () => {
	it("skips a reconciled target with no shardPath", () => {
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "D", sourcePath: "/repo/b.ts", shardPath: null, sourceMtime: null, shardMtime: null },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		expect(buildShardInlineText(reconciled)).toBe("");
	});

	it("skips a target whose shard file no longer exists on disk", () => {
		const reconciled: ReconciledTarget[] = [
			{
				classification: {
					case: "E-fresh",
					sourcePath: join(dir, "src", "gone.ts"),
					shardPath: join(dir, "src", "gone.graph.ts"),
					sourceMtime: "t1",
					shardMtime: "t2",
				},
				severity: fakeSeverity,
				oracle: null,
			},
		];
		expect(buildShardInlineText(reconciled)).toBe("");
	});

	it("inlines the full shard body when under the byte cap", () => {
		const shardPath = join(dir, "src", "small.graph.ts");
		writeFileSync(shardPath, "// small shard\n");
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: join(dir, "src", "small.ts"), shardPath, sourceMtime: "t1", shardMtime: "t2" },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		const text = buildShardInlineText(reconciled);
		expect(text).toContain("// small shard");
		expect(text).not.toContain("truncated at");
	});

	it("truncates a shard body over the byte cap", () => {
		const shardPath = join(dir, "src", "big.graph.ts");
		writeFileSync(shardPath, "x".repeat(5000));
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: join(dir, "src", "big.ts"), shardPath, sourceMtime: "t1", shardMtime: "t2" },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		const text = buildShardInlineText(reconciled);
		expect(text).toContain("truncated at 4096 bytes; read the file directly for full contents");
	});

	it("does not truncate a shard exactly at the byte cap", () => {
		const shardPath = join(dir, "src", "boundary.graph.ts");
		writeFileSync(shardPath, "x".repeat(4096));
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: join(dir, "src", "boundary.ts"), shardPath, sourceMtime: "t1", shardMtime: "t2" },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		const text = buildShardInlineText(reconciled);
		expect(text).toContain("x".repeat(4096));
		expect(text).not.toContain("truncated at");
	});

	it("slices an oversized shard and trims only trailing whitespace", () => {
		const shardPath = join(dir, "src", "whitespace.graph.ts");
		writeFileSync(shardPath, `${"x".repeat(4096)}TAIL\n\n`);
		const reconciled: ReconciledTarget[] = [
			{
				classification: { case: "E-fresh", sourcePath: join(dir, "src", "whitespace.ts"), shardPath, sourceMtime: "t1", shardMtime: "t2" },
				severity: fakeSeverity,
				oracle: null,
			},
		];
		const text = buildShardInlineText(reconciled);
		expect(text).toContain("x".repeat(4096));
		expect(text).not.toContain("TAIL");
		expect(text).toContain("... (truncated at 4096 bytes; read the file directly for full contents)");
		expect(text).not.toMatch(/contents\)\s+$/);
	});
});
