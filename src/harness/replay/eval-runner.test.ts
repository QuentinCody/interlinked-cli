// T1 eval runner — walks an assembled trace, replays each enveloped step's
// exact observation into the candidate (injected here — no network in tests),
// scores action-match + structural distance against the recorded action, and
// writes one ledger row per evaluated step
// (docs/design/reproducibility/tier1-teacher-forced-eval.md). Envelope-less
// steps are skipped and COUNTED — degraded coverage must be visible, never
// silent.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CandidateRunResult } from "./candidate-runner.js";
import { loadLedger } from "./eval-ledger.js";
import { runEvalOverTrace } from "./eval-runner.js";
import type { InferenceEnvelope } from "./inference-store.js";
import { perSessionEnvelopePath } from "./trace-assembler.js"

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess-eval";

function write(path: string, lines: object[]): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function fixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "il-eval-"));
	cleanups.push(cwd);
	write(join(cwd, ".interlinked", "replay", "trace", `${SESSION}.jsonl`), [
		{
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: 1, tool_use_id: "toolu_a", ts: "t1" },
			observation_ref: `inference/${SESSION}.jsonl#seq=1`,
			action: { tool: "Bash", input: { command: "ls" } },
			result: { outcome: "ok", observation: null },
			pre_tree: null,
			post_tree: null,
			state_ref: null,
		},
		{
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: 2, tool_use_id: "toolu_b", ts: "t2" },
			observation_ref: null,
			action: { tool: "Read", input: { file_path: "/x" } },
			result: null,
			pre_tree: null,
			post_tree: null,
			state_ref: null,
		},
	]);
	const envelope: InferenceEnvelope = {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "t0",
		ts_response: "t1",
		latency_ms: 1,
		provider: "anthropic",
		request_headers: {},
		request: { model: "ref-model", messages: [] },
		response: { id: "msg", content: [] },
		tool_use_ids: ["toolu_a"],
		request_sha256: "0".repeat(64),
		session_id: SESSION,
		seq: 1,
	};
	write(perSessionEnvelopePath(cwd, SESSION), [envelope]);
	return cwd;
}

function stubRunner(proposedCommand: string) {
	const calls: string[] = [];
	const runner = async (): Promise<CandidateRunResult> => {
		calls.push("call");
		return {
			raw: {},
			stop_reason: "tool_use",
			content: [],
			proposed: { tool: "Bash", input: { command: proposedCommand } },
		};
	};
	return { runner, calls };
}

describe("runEvalOverTrace", () => {
	it("evaluates enveloped steps, skips-and-counts the rest, writes ledger rows", async () => {
		const cwd = fixture();
		const { runner, calls } = stubRunner("ls");
		const summary = await runEvalOverTrace({
			cwd,
			sessionId: SESSION,
			candidateModel: "cand-1",
			runId: "run-test",
			runner,
		});
		expect(summary).toMatchObject({
			run_id: "run-test",
			evaluated: 1,
			skipped_no_envelope: 1,
		});
		expect(calls).toHaveLength(1);

		const rows = loadLedger(cwd, "run-test");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reference).toEqual({
			session_id: SESSION,
			seq: 1,
			tool_use_id: "toolu_a",
			model: "ref-model",
		});
		expect(rows[0]?.reference_tool).toBe("Bash");
		expect(rows[0]?.scores.action_match.match).toBe(true);
		expect(rows[0]?.scores.structural).toMatchObject({ kind: "argv", distance: 0 });
	});

	it("scores a divergent candidate as a mismatch with structural distance", async () => {
		const cwd = fixture();
		const { runner } = stubRunner("rm -r build");
		await runEvalOverTrace({
			cwd,
			sessionId: SESSION,
			candidateModel: "cand-2",
			runId: "run-div",
			runner,
		});
		const row = loadLedger(cwd, "run-div")[0];
		expect(row?.scores.action_match.match).toBe(false);
		expect(row?.scores.structural?.distance).toBeGreaterThan(0);
	});

	it("honors the step limit", async () => {
		const cwd = fixture();
		const { runner, calls } = stubRunner("ls");
		const summary = await runEvalOverTrace({
			cwd,
			sessionId: SESSION,
			candidateModel: "cand-3",
			runId: "run-lim",
			limit: 0,
			runner,
		});
		expect(summary.evaluated).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("falls back to a no-op logger when a failed step is not given one", async () => {
		const cwd = fixture();
		const runner = async (): Promise<CandidateRunResult> => {
			throw new Error("candidate call boom");
		};
		// No `log` passed — resolveEvalDefaults' default logger must run
		// without throwing, or the promise below would reject instead of
		// resolving with failed: 1.
		const summary = await runEvalOverTrace({
			cwd,
			sessionId: SESSION,
			candidateModel: "cand-4",
			runId: "run-fail",
			runner,
		});
		expect(summary).toMatchObject({ run_id: "run-fail", evaluated: 0, failed: 1 });
		expect(loadLedger(cwd, "run-fail")).toHaveLength(0);
	});
});
