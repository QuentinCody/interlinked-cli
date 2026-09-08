import { nonNull } from "../../lib/non-null.js";
// ===========================================
// Mutation-kill suite — wave 34 survivors for graph-prediction-pre-tool.ts
// ===========================================
// Targets specific StringLiteral / ConditionalExpression / ObjectLiteral /
// BlockStatement / Regex / OptionalChaining / EqualityOperator survivors
// reported in .interlinked/mutation-manifest.json for this file. Each case
// is tagged with the mutantId(s) it targets directly above the `it()`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendPredictionRow } from "../graph-prediction-cache.js";
import { resetWorkspaceActiveCache } from "../graph-prediction-classifier.js";
import { driveGraphPrediction } from "../graph-prediction-pre-tool.js";
import type { HarnessEvent } from "../types.js";

let dir: string;

function setMtime(path: string, ms: number): void {
	const seconds = ms / 1000;
	utimesSync(path, seconds, seconds);
}

function eventForWrite(filePath: string, content = ""): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
		timestamp: "2026-05-10T00:00:00Z",
		cwd: dir,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-pretool-w34-"));
	resetWorkspaceActiveCache();
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
	writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetWorkspaceActiveCache();
});

describe("driveGraphPrediction — sentinel-write defensive branches (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: ac167413ce27debe (typeof file_path check forced to "true")
	it("does not throw when tool_input.file_path is a non-string type", () => {
		const r = driveGraphPrediction({
			event: {
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: 42, content: "" },
				timestamp: "2026-05-10T00:00:00Z",
				cwd: dir,
			},
			cwd: dir,
			mode: "enforced",
		});
		expect(r).toBeNull();
	});

	// test-contract: invariant — mutation-kill wave-34: aeb9a7b690bb832e (optional chaining on tool_input removed)
	it("does not throw when tool_input itself is absent from the event", () => {
		const r = driveGraphPrediction({
			event: {
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Write",
				timestamp: "2026-05-10T00:00:00Z",
				cwd: dir,
			},
			cwd: dir,
			mode: "enforced",
		});
		expect(r).toBeNull();
	});
});

describe("driveGraphPrediction — non-write tool short-circuit (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: 27af8f95e0c6f76b (!isFileWrite(...) forced to "false")
	it("returns null for a Read of a plain non-shard file (not a write tool)", () => {
		writeFileSync(join(dir, "src", "readonly.ts"), "export {}");
		const r = driveGraphPrediction({
			event: {
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Read",
				tool_input: { file_path: join(dir, "src", "readonly.ts") },
				timestamp: "2026-05-10T00:00:00Z",
				cwd: dir,
			},
			cwd: dir,
			mode: "shadow",
		});
		expect(r).toBeNull();
	});
});

describe("driveGraphPrediction — observation row telemetry (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: c90203579aa86398, 02391782f231c251, f3b7870c7db23402, 00a61ef6e36a6037
	it("emits a full observation row to graph-observations.jsonl", () => {
		writeFileSync(join(dir, "src", "obs-target.ts"), "export {}");
		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "obs-target.ts")),
			cwd: dir,
			mode: "shadow",
		});
		expect(r?.decision).toBe("allow");
		const obsPath = join(dir, ".interlinked", "graph-observations.jsonl");
		expect(existsSync(obsPath)).toBe(true);
		const lines = readFileSync(obsPath, "utf8").trim().split("\n");
		const row = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(row.session_id).toBe("sess-1");
		expect(row.file_path).toBe(join(dir, "src", "obs-target.ts"));
		expect(row.case).toBe("D");
		expect(row.tool_input_hash).toBe("");
	});
});

describe("driveGraphPrediction — observation payload on each return path (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: abd3c57870adf616 (missing-prediction challenge observation object gutted)
	it("carries file_path + case on the missing-prediction challenge observation", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh2.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh2.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh2.ts"), t);
		setMtime(join(dir, "src", "fresh2.graph.ts"), t + 30_000);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "fresh2.ts")),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.observation).toEqual({ file_path: join(dir, "src", "fresh2.ts"), case: "E-fresh" });
	});

	// test-contract: invariant — mutation-kill wave-34: 797171851f8e8cf0 (format-violation observation object gutted);
	// test-contract: invariant — mutation-kill wave-34: b5f43dd931e2778b (slug regex loses its end-of-string anchor)
	it("carries file_path + case on the format-violation re-block, and slugs only the trailing extension", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fv.min.ts"), "export {}");
		writeFileSync(join(dir, "src", "fv.min.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fv.min.ts"), t);
		setMtime(join(dir, "src", "fv.min.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "fv.min.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "fv.min.graph.ts"),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: null,
			},
			comparison_status: "parse_failed",
		});

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "fv.min.ts")),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.observation).toEqual({ file_path: join(dir, "src", "fv.min.ts"), case: "E-fresh" });
		// The slug must keep the embedded ".min" and drop only the final ".ts".
		expect(r?.reason).toMatch(/incoming\/sess-1\/fv\.min\.yaml/);
	});

	// test-contract: invariant — mutation-kill wave-34: 3aacc742d99e6356 (ack-required observation object gutted);
	// test-contract: invariant — mutation-kill wave-34: 0fc0b0e33984cbef (mode===MODE_ENFORCED forced to "false", skipping the ack path)
	it("carries file_path + case on the ack-required block and routes through the ack sentinel path", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "hi2.ts"), "export {}");
		writeFileSync(
			join(dir, "src", "hi2.graph.ts"),
			[
				"// @generated supermodel-sidecar",
				"// [impact]",
				"// risk        HIGH",
				"// domains     X",
				"// direct      1",
				"// transitive  1",
			].join("\n"),
		);
		setMtime(join(dir, "src", "hi2.ts"), t);
		setMtime(join(dir, "src", "hi2.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "hi2.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "hi2.graph.ts"),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: { risk: "low", domains: [], direct: 1, transitive: 1, affects: [] },
			},
			comparison_status: "pending",
		});

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "hi2.ts")),
			cwd: dir,
			mode: "enforced",
		});
		expect(r?.decision).toBe("block");
		expect(r?.observation).toEqual({ file_path: join(dir, "src", "hi2.ts"), case: "E-fresh" });
		// Must be the ack-required path specifically, not the shard-read gate.
		expect(r?.reason).toMatch(/predictions\/ack\//);
	});

	// test-contract: invariant — mutation-kill wave-34: da40be05a8732447 (needs-read observation object gutted)
	it("carries file_path + case on the enforced-mode needs-read block observation", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "oa2.ts"), "export {}");
		writeFileSync(
			join(dir, "src", "oa2.graph.ts"),
			["// @generated supermodel-sidecar", "// [impact]", "// risk        LOW"].join("\n"),
		);
		setMtime(join(dir, "src", "oa2.ts"), t);
		setMtime(join(dir, "src", "oa2.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "oa2.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "oa2.graph.ts"),
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

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "oa2.ts")),
			cwd: dir,
			mode: "enforced",
		});
		expect(r?.decision).toBe("block");
		expect(r?.observation).toEqual({ file_path: join(dir, "src", "oa2.ts"), case: "E-fresh" });
	});

	// test-contract: invariant — mutation-kill wave-34: e8f9680ae02c690a (final reveal-and-allow observation object gutted)
	it("carries file_path + case on the final reveal-and-allow observation", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "final.ts"), "export {}");
		writeFileSync(join(dir, "src", "final.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "final.ts"), t);
		setMtime(join(dir, "src", "final.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "final.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "final.graph.ts"),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: null,
			},
			comparison_status: "pending",
		});

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "final.ts")),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");
		expect(r?.observation).toEqual({ file_path: join(dir, "src", "final.ts"), case: "E-fresh" });
	});
});

describe("driveGraphPrediction — reconciled_at timestamp fallback (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: 829e3813b02ef969, 635cd3b3a621e988, dfc8a001f79da949
	it("falls back to a real ISO timestamp for reconciled_at when the event timestamp is empty", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "rt.ts"), "export {}");
		writeFileSync(join(dir, "src", "rt.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "rt.ts"), t);
		setMtime(join(dir, "src", "rt.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "rt.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "rt.graph.ts"),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: null,
			},
			comparison_status: "pending",
		});

		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: join(dir, "src", "rt.ts"), content: "" },
			timestamp: "",
			cwd: dir,
		};
		const r = driveGraphPrediction({ event, cwd: dir, mode: "soft_gate" });
		expect(r?.decision).toBe("allow");

		const reconPath = join(dir, ".interlinked", "graph-reconciliations.jsonl");
		const lines = readFileSync(reconPath, "utf8").trim().split("\n");
		const row = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(typeof row.reconciled_at).toBe("string");
		expect(row.reconciled_at.length).toBeGreaterThan(0);
		expect(row.reconciled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("driveGraphPrediction — toolInputContent propagation into classifyCase (w34)", () => {
	// test-contract: invariant — mutation-kill wave-34: a5b87c533175a1d4, 15d931c18d36bae6, 1e6c220947ac78c3, d01d9d0d7eeedc24, 5a59fa65361f2028
	it("classifies a not-yet-created file as Case B when the write content contains an import", () => {
		const target = join(dir, "src", "new-import.ts");
		const r = driveGraphPrediction({
			event: eventForWrite(target, "import { x } from './other';\n"),
			cwd: dir,
			mode: "shadow",
		});
		expect(r?.decision).toBe("allow");
		expect(r?.observation).toEqual({ file_path: target, case: "B" });
	});
});
