// ===========================================
// Pre-tool driver — case classification + E-fresh challenge/reconcile
// ===========================================
// Three modes:
//   shadow   — never blocks; logs case observations only (used for
//              dogfooding the cache-fill path without disrupting users)
//   soft_gate — blocks once on first encounter of an E-fresh file with
//              no cached prediction, asking for one. Reveals diff and
//              allows on retry, regardless of severity.
//   enforced — soft_gate + ack-required for high-severity / full-
//              abstention-against-high-impact misses.
//
// Non-E-fresh files (A/B/C/D/E-stale) are observation-only in every mode.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendPredictionRow } from "../graph-prediction-cache.js";
import { resetWorkspaceActiveCache } from "../graph-prediction-classifier.js";
import {
	driveGraphPrediction,
	type GraphPredictionMode,
} from "../graph-prediction-pre-tool.js";
import type { HarnessEvent } from "../types.js";

let dir: string;
const deferredCleanup: string[] = [];

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
	dir = mkdtempSync(join(tmpdir(), "graph-pred-pretool-"));
	resetWorkspaceActiveCache();
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
	writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const extra of deferredCleanup.splice(0)) {
		rmSync(extra, { recursive: true, force: true });
	}
	resetWorkspaceActiveCache();
});

describe("driveGraphPrediction — non-applicable events", () => {
	it("returns null for non-file-write tools (Bash, Read)", () => {
		const r = driveGraphPrediction({
			event: { ...eventForWrite("x"), tool_name: "Bash", tool_input: { command: "ls" } },
			cwd: dir,
			mode: "enforced",
		});
		expect(r).toBeNull();
	});

	it("returns null when workspace is not Supermodel-active", () => {
		const inactive = mkdtempSync(join(tmpdir(), "graph-pred-inactive-"));
		deferredCleanup.push(inactive);
		const r = driveGraphPrediction({
			event: {
				...eventForWrite(join(inactive, "x.ts")),
				cwd: inactive,
			},
			cwd: inactive,
			mode: "enforced",
		});
		expect(r).toBeNull();
	});
});

describe("driveGraphPrediction — malformed / edge inputs", () => {
	it("returns null when a file-write event carries no resolvable file path", () => {
		const r = driveGraphPrediction({
			event: {
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { content: "no path fields here" },
				timestamp: "2026-05-10T00:00:00Z",
				cwd: dir,
			},
			cwd: dir,
			mode: "enforced",
		});
		expect(r).toBeNull();
	});

	it("returns null reading a shard with no pending prediction row for this session", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "noreq.ts"), "export {}");
		writeFileSync(join(dir, "src", "noreq.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "noreq.ts"), t);
		setMtime(join(dir, "src", "noreq.graph.ts"), t);

		const readEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: { file_path: join(dir, "src", "noreq.graph.ts") },
			timestamp: "2026-05-10T00:00:01Z",
			cwd: dir,
		};
		// No prediction was ever submitted for noreq.ts, so recordShardRead has
		// no prior row to stamp and falls through to null (pass-through read).
		const r = driveGraphPrediction({ event: readEvent, cwd: dir, mode: "enforced" });
		expect(r).toBeNull();
	});
});

describe("driveGraphPrediction — shadow mode", () => {
	const mode: GraphPredictionMode = "shadow";

	it("logs B/D/E-stale to observations JSONL but never blocks", () => {
		writeFileSync(join(dir, "src", "no-shard.ts"), "export {}");
		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "no-shard.ts")),
			cwd: dir,
			mode,
		});
		expect(r).not.toBeNull();
		expect(r?.decision).toBe("allow");
		expect(r?.observation?.case).toBe("D");
	});

	it("logs E-fresh as observation in shadow mode (no challenge fires)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh.ts"), t);
		setMtime(join(dir, "src", "fresh.graph.ts"), t + 30_000);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "fresh.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("allow");
		expect(r?.observation?.case).toBe("E-fresh");
	});
});

describe("driveGraphPrediction — soft_gate mode", () => {
	const mode: GraphPredictionMode = "soft_gate";

	it("returns null (no signal) for non-E-fresh files even in soft_gate", () => {
		writeFileSync(join(dir, "src", "no-shard.ts"), "export {}");
		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "no-shard.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("allow");
		expect(r?.observation?.case).toBe("D");
	});

	it("blocks an E-fresh edit when no cached prediction exists (Fire 1)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh.ts"), t);
		setMtime(join(dir, "src", "fresh.graph.ts"), t + 30_000);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "fresh.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/graph_prediction/);
		expect(r?.reason).toMatch(/fresh\.ts/);
	});

	it("allows on Fire 2 when a cached prediction exists (low/medium severity)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "f2.ts"), "export {}");
		writeFileSync(join(dir, "src", "f2.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "f2.ts"), t);
		setMtime(join(dir, "src", "f2.graph.ts"), t);

		// Pre-seed the cache with an `ok` prediction
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "f2.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "f2.graph.ts"),
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
			event: eventForWrite(join(dir, "src", "f2.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("allow");
		expect(r?.additional_context).toBeDefined();
	});

	it("re-blocks on a cached format-violation prediction, asking for a narrower top-K", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fv.ts"), "export {}");
		writeFileSync(join(dir, "src", "fv.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fv.ts"), t);
		setMtime(join(dir, "src", "fv.graph.ts"), t);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "fv.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "fv.graph.ts"),
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
			event: eventForWrite(join(dir, "src", "fv.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toBe(
			[
				`[interlinked:graph-pred] Cached prediction for ${join(dir, "src", "fv.ts")} violated the format contract (per-section entry cap is 50).`,
				"Narrow your prediction to the entries that matter most, or use `unknown` for any list you can't bound.",
				"Re-submit by writing to .interlinked/predictions/incoming/sess-1/fv.yaml",
			].join("\n"),
		);
	});
});

describe("driveGraphPrediction — multi-file batch", () => {
	const mode: GraphPredictionMode = "soft_gate";

	function multiEditEvent(files: string[]): HarnessEvent {
		// Codex-style apply_patch with multiple Update File: entries
		const body = files
			.map((f) => `*** Update File: ${f}\n@@\n- old\n+ new\n`)
			.join("");
		return {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "apply_patch",
			tool_input: { command: `*** Begin Patch\n${body}*** End Patch` },
			timestamp: "2026-05-10T00:00:00Z",
			cwd: dir,
		};
	}

	it("blocks once with all E-fresh files batched into a single challenge", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		for (const name of ["a", "b"]) {
			writeFileSync(join(dir, "src", `${name}.ts`), "export {}");
			writeFileSync(join(dir, "src", `${name}.graph.ts`), "// @generated");
			setMtime(join(dir, "src", `${name}.ts`), t);
			setMtime(join(dir, "src", `${name}.graph.ts`), t);
		}

		const r = driveGraphPrediction({
			event: multiEditEvent([
				join(dir, "src", "a.ts"),
				join(dir, "src", "b.ts"),
			]),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/a\.ts/);
		expect(r?.reason).toMatch(/b\.ts/);
	});

	it("allows when no E-fresh files are in the batch", () => {
		writeFileSync(join(dir, "src", "noshard1.ts"), "export {}");
		writeFileSync(join(dir, "src", "noshard2.ts"), "export {}");
		const r = driveGraphPrediction({
			event: multiEditEvent([
				join(dir, "src", "noshard1.ts"),
				join(dir, "src", "noshard2.ts"),
			]),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("allow");
	});
});

describe("driveGraphPrediction — enforced mode (ack required)", () => {
	const mode: GraphPredictionMode = "enforced";

	function highSeverityCachedPrediction(t: number): void {
		writeFileSync(join(dir, "src", "hi.ts"), "export {}");
		writeFileSync(join(dir, "src", "hi.graph.ts"), [
			"// @generated supermodel-sidecar",
			"// [impact]",
			"// risk        HIGH",
			"// domains     X",
			"// direct      1",
			"// transitive  1",
		].join("\n"));
		setMtime(join(dir, "src", "hi.ts"), t);
		setMtime(join(dir, "src", "hi.graph.ts"), t);

		// Prediction underestimates risk: predicted low, oracle HIGH
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "hi.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "hi.graph.ts"),
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
	}

	it("blocks again on Fire 2 with ack request when severity is high", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		highSeverityCachedPrediction(t);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "hi.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Acknowledge|ack/i);
	});

	it("soft_gate mode reveals + allows even on high-severity (no ack required)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		highSeverityCachedPrediction(t);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "hi.ts")),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");
		expect(r?.additional_context).toMatch(/Comparison|HIGH|severity/i);
	});

	it("accepting an ack via the ack sentinel path clears ack_required, then re-blocks on the shard-read gate", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		highSeverityCachedPrediction(t);

		// Fire 2: ack required.
		const blocked = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "hi.ts")),
			cwd: dir,
			mode,
		});
		expect(blocked?.decision).toBe("block");

		// Submit the ack via the ack sentinel path.
		const ackYaml = [
			"graph_prediction_ack:",
			`  file: ${join(dir, "src", "hi.ts")}`,
			"  acknowledged_triggers:",
			"    - risk_underestimated",
		].join("\n");
		const ackEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: {
				file_path: join(dir, ".interlinked", "predictions", "ack", "sess-1", "hi.yaml"),
				content: ackYaml,
			},
			timestamp: "2026-05-10T00:00:02Z",
			cwd: dir,
		};
		const ackResult = driveGraphPrediction({ event: ackEvent, cwd: dir, mode });
		expect(ackResult?.decision).toBe("allow");
		expect(ackResult?.additional_context).toMatch(/Acknowledgement for/);

		// Retry: ack_required is satisfied now, so the flow falls through to the
		// enforced-mode shard-read gate instead of re-asking for an ack.
		const retried = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "hi.ts")),
			cwd: dir,
			mode,
		});
		expect(retried?.decision).toBe("block");
		expect(retried?.reason).toMatch(/Read the oracle shard/);
	});
});

describe("driveGraphPrediction — Option B: inline shard bytes in soft_gate", () => {
	const mode: GraphPredictionMode = "soft_gate";

	function lowSeverityPrediction(t: number, shardBody: string): void {
		writeFileSync(join(dir, "src", "ob.ts"), "export {}");
		writeFileSync(join(dir, "src", "ob.graph.ts"), shardBody);
		setMtime(join(dir, "src", "ob.ts"), t);
		setMtime(join(dir, "src", "ob.graph.ts"), t);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "ob.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "ob.graph.ts"),
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
	}

	it("appends the oracle shard contents after the comparison in soft_gate mode", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const shardBody = [
			"// @generated supermodel-sidecar",
			"// [impact]",
			"// risk        LOW",
			"// domains     UI",
		].join("\n");
		lowSeverityPrediction(t, shardBody);

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "ob.ts")),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("allow");
		expect(r?.additional_context).toMatch(/Comparison for/);
		expect(r?.additional_context).toMatch(/Oracle shard for/);
		expect(r?.additional_context).toContain("risk        LOW");
		expect(r?.additional_context).toContain("domains     UI");
	});

	it("does NOT append the inline shard in enforced mode (Option A path)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		lowSeverityPrediction(t, [
			"// @generated supermodel-sidecar",
			"// [impact]",
			"// risk        LOW",
		].join("\n"));

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "ob.ts")),
			cwd: dir,
			mode: "enforced",
		});
		// Enforced mode without prior shard_read should block on the read gate.
		// The inline shard bytes must NOT appear in additional_context.
		expect(r?.decision).toBe("block");
		expect(r?.additional_context ?? "").not.toMatch(/Oracle shard for/);
	});
});

describe("driveGraphPrediction — Option A: enforced-mode shard-read gate", () => {
	const mode: GraphPredictionMode = "enforced";

	function lowSeverityPrediction(t: number): { source: string; shard: string } {
		writeFileSync(join(dir, "src", "oa.ts"), "export {}");
		writeFileSync(join(dir, "src", "oa.graph.ts"), [
			"// @generated supermodel-sidecar",
			"// [impact]",
			"// risk        LOW",
		].join("\n"));
		setMtime(join(dir, "src", "oa.ts"), t);
		setMtime(join(dir, "src", "oa.graph.ts"), t);
		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "oa.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "oa.graph.ts"),
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
		return {
			source: join(dir, "src", "oa.ts"),
			shard: join(dir, "src", "oa.graph.ts"),
		};
	}

	it("blocks the retry Edit in enforced mode until the shard has been read", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const { source } = lowSeverityPrediction(t);
		const r = driveGraphPrediction({
			event: eventForWrite(source),
			cwd: dir,
			mode,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Read the oracle shard/);
		expect(r?.reason).toMatch(/oa\.graph\.ts/);
	});

	it("clears the gate after the agent calls Read on the shard, then allows", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const { source, shard } = lowSeverityPrediction(t);

		// 1) Initial retry: blocked on read gate.
		const blocked = driveGraphPrediction({
			event: eventForWrite(source),
			cwd: dir,
			mode,
		});
		expect(blocked?.decision).toBe("block");

		// 2) Agent reads the shard. The driver records shard_read_at.
		const readEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: { file_path: shard },
			timestamp: "2026-05-10T00:00:01Z",
			cwd: dir,
		};
		const readResult = driveGraphPrediction({ event: readEvent, cwd: dir, mode });
		expect(readResult?.decision).toBe("allow");
		expect(readResult?.additional_context).toMatch(/Shard read recorded/);

		// 3) Retry the Edit — gate is satisfied, reveal + allow.
		const allowed = driveGraphPrediction({
			event: eventForWrite(source),
			cwd: dir,
			mode,
		});
		expect(allowed?.decision).toBe("allow");
		expect(allowed?.additional_context).toMatch(/Comparison for/);
	});

	it("does NOT engage the shard-read gate in soft_gate mode", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const { source } = lowSeverityPrediction(t);
		const r = driveGraphPrediction({
			event: eventForWrite(source),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");
	});
});

describe("driveGraphPrediction — sentinel-path prediction submission", () => {
	// Replaces the transcript-parse fallback. Agent writes a YAML prediction
	// via the Write tool to
	//   .interlinked/predictions/incoming/<session_id>/<slug>.yaml
	// The harness intercepts that Write on PreToolUse, parses synchronously,
	// persists to graph-predictions.jsonl, and returns specific parse errors
	// (instead of looping on the original Edit).

	const sentinelPath = (sessionId: string, slug: string): string =>
		join(dir, ".interlinked", "predictions", "incoming", sessionId, `${slug}.yaml`);

	function setupEFresh(name: string, t: number): string {
		writeFileSync(join(dir, "src", `${name}.ts`), "export {}");
		writeFileSync(join(dir, "src", `${name}.graph.ts`), "// @generated");
		utimesSync(join(dir, "src", `${name}.ts`), t / 1000, t / 1000);
		utimesSync(join(dir, "src", `${name}.graph.ts`), t / 1000, t / 1000);
		return join(dir, "src", `${name}.ts`);
	}

	function submissionEvent(filePath: string, content: string, sessionId = "sess-1"): HarnessEvent {
		return {
			hook_event: "PreToolUse",
			session_id: sessionId,
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: filePath, content },
			timestamp: "2026-05-10T00:00:00Z",
			cwd: dir,
		};
	}

	it("persists a valid prediction submitted via Write to the sentinel path", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const abs = setupEFresh("submit", t);
		const yaml = [
			"graph_prediction:",
			`  file: ${abs}`,
			"  deps:",
			"    imports: []",
			"    imported_by: []",
		].join("\n");

		const r = driveGraphPrediction({
			event: submissionEvent(sentinelPath("sess-1", "submit"), yaml),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");

		// The Edit retry should now find the prediction in cache.
		const retry = driveGraphPrediction({
			event: eventForWrite(abs),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(retry?.decision).toBe("allow");
		expect(retry?.additional_context).toBeDefined();
	});

	it("blocks with a specific parse error when the sentinel YAML is malformed", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const abs = setupEFresh("badyaml", t);
		const yaml = [
			"graph_prediction:",
			`  file: ${abs}`,
			"  this is { not: ] valid yaml",
		].join("\n");

		const r = driveGraphPrediction({
			event: submissionEvent(sentinelPath("sess-1", "badyaml"), yaml),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/parse|malformed/i);
	});

	it("blocks when the sentinel YAML has no graph_prediction: header at all", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		setupEFresh("noheader", t);
		const r = driveGraphPrediction({
			event: submissionEvent(
				sentinelPath("sess-1", "noheader"),
				"some_other_key: foo\nbar: 1",
			),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/graph_prediction|no.*prediction/i);
	});

	it("normalizes relative `file:` in the submission against cwd", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const abs = setupEFresh("rel", t);
		const yaml = [
			"graph_prediction:",
			"  file: src/rel.ts",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
		].join("\n");

		const r = driveGraphPrediction({
			event: submissionEvent(sentinelPath("sess-1", "rel"), yaml),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");

		const retry = driveGraphPrediction({
			event: eventForWrite(abs),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(retry?.decision).toBe("allow");
	});

	it("blocks when the submitted prediction targets a non-E-fresh file", () => {
		// E.g., file: doesn't exist or has no shard
		const r = driveGraphPrediction({
			event: submissionEvent(
				sentinelPath("sess-1", "noshard"),
				[
					"graph_prediction:",
					`  file: ${join(dir, "src", "missing.ts")}`,
					"  deps:",
					"    imports: []",
					"    imported_by: []",
				].join("\n"),
			),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/E-fresh|not.*fresh|no.*shard/i);
	});

	it("the challenge reason directs the agent to write to the sentinel path", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		const abs = setupEFresh("howto", t);
		const r = driveGraphPrediction({
			event: eventForWrite(abs),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/\.interlinked\/predictions\/incoming\//);
		expect(r?.reason).toMatch(/Write tool/i);
	});
});

describe("driveGraphPrediction — writes reconciliation row for retrospective analysis", () => {
	it("appends to graph-reconciliations.jsonl after a successful reconcile", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "rl.ts"), "export {}");
		writeFileSync(
			join(dir, "src", "rl.graph.ts"),
			[
				"// @generated supermodel-sidecar",
				"// [impact]",
				"// risk        MEDIUM",
				"// domains     Server",
				"// direct      3",
				"// transitive  8",
			].join("\n"),
		);
		utimesSync(join(dir, "src", "rl.ts"), t / 1000, t / 1000);
		utimesSync(join(dir, "src", "rl.graph.ts"), t / 1000, t / 1000);

		appendPredictionRow(dir, {
			session_id: "sess-1",
			file_path: join(dir, "src", "rl.ts"),
			source_mtime: new Date(t).toISOString(),
			shard_mtime: new Date(t).toISOString(),
			shard_path: join(dir, "src", "rl.graph.ts"),
			emitted_at: "2026-05-10T12:01:00Z",
			tool_input_hash: "",
			case: "E-fresh",
			prediction: {
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: {
					risk: "medium",
					domains: ["Server"],
					direct: 3,
					transitive: 8,
					affects: [],
				},
			},
			comparison_status: "pending",
		});

		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "rl.ts")),
			cwd: dir,
			mode: "soft_gate",
		});
		expect(r?.decision).toBe("allow");

		const reconPath = join(dir, ".interlinked", "graph-reconciliations.jsonl");
		expect(existsSync(reconPath)).toBe(true);
		const row = JSON.parse(readFileSync(reconPath, "utf8").trim());
		expect(row.file_path).toBe(join(dir, "src", "rl.ts"));
		expect(row.oracle_summary.risk).toBe("MEDIUM");
		expect(row.prediction_summary.risk).toBe("medium");
		expect(typeof row.weighted_avg).toBe("number");
	});
});

describe("driveGraphPrediction — return type contract", () => {
	it("non-null returns include decision + observation or reason fields", () => {
		writeFileSync(join(dir, "src", "no-shard.ts"), "export {}");
		const r = driveGraphPrediction({
			event: eventForWrite(join(dir, "src", "no-shard.ts")),
			cwd: dir,
			mode: "shadow",
		});
		expect(r).not.toBeNull();
		expect(["block", "allow"]).toContain(r?.decision);
	});
});
