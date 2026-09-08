import { nonNull } from "../../lib/non-null.js";
// T1 trace assembler — joins the three capture surfaces into the
// `replay-trace.v1` spine (docs/design/reproducibility/README.md §Trace
// spine): collection tool events (action + result, keyed by seq/tool_use_id)
// ⋈ inference envelopes (exact observation, joined by tool_use_id, then
// stamped with session/seq) ⋈ tree/state snapshots (pre/post trees + state
// ref per seq). Envelope-less steps still produce trace rows (observation_ref
// null) — a session captured without the proxy is degraded, not empty.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEnvelope, parseInferenceEnvelope, type InferenceEnvelope } from "./inference-store.js";
import { assembleTrace, loadTrace, parseTraceStep } from "./trace-assembler.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess-t1";

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-t1-"));
	cleanups.push(dir);
	mkdirSync(join(dir, ".interlinked", "replay", "snapshots"), { recursive: true });
	return dir;
}

function collectionRow(row: Record<string, unknown>): string {
	return `${JSON.stringify({ schema: "collection.v1", kind: "tool_event", session_id: SESSION, ...row })}\n`;
}

function writeCollection(dir: string, rows: string[]): void {
	appendFileSync(join(dir, ".interlinked", "collection.jsonl"), rows.join(""));
}

function writeSnapshotRow(dir: string, row: Record<string, unknown>): void {
	appendFileSync(
		join(dir, ".interlinked", "replay", "snapshots", "index.jsonl"),
		`${JSON.stringify({ schema: "tree-snapshot.v1", session_id: SESSION, backend: "git", commit: "c", ts: "t", ...row })}\n`,
	);
}

function envelope(toolUseId: string): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "2026-07-24T12:00:00.000Z",
		ts_response: "2026-07-24T12:00:01.000Z",
		latency_ms: 1000,
		provider: "anthropic",
		request_headers: {},
		request: { model: "m", messages: [] },
		response: { id: "msg", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }] },
		tool_use_ids: [toolUseId],
		request_sha256: "0".repeat(64),
		session_id: null,
		seq: null,
	};
}

function seedStandardFixture(dir: string): void {
	writeCollection(dir, [
		collectionRow({
			ts: "2026-07-24T12:00:01.100Z",
			seq: 1,
			tool_use_id: "toolu_a",
			phase: "pre",
			provider_tool: "Bash",
			action: { command: "ls", cwd: null },
		}),
		collectionRow({
			ts: "2026-07-24T12:00:01.900Z",
			seq: 2,
			tool_use_id: "toolu_a",
			phase: "post",
			outcome: "ok",
			provider_tool: "Bash",
			observation: { stdout: "files" },
		}),
		collectionRow({
			ts: "2026-07-24T12:00:05.000Z",
			seq: 3,
			tool_use_id: "toolu_b",
			phase: "pre",
			provider_tool: "Read",
			action: { path: "/x.ts" },
		}),
	]);
	writeSnapshotRow(dir, { seq: 1, tool_use_id: "toolu_a", phase: "pre", tree: "tree-pre-a" });
	writeSnapshotRow(dir, { seq: 2, tool_use_id: "toolu_a", phase: "post", tree: "tree-post-a" });
	appendEnvelope(join(dir, ".interlinked", "replay"), envelope("toolu_a"));
}

describe("assembleTrace", () => {
	it("builds one step per pre event, joined across all three surfaces", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(2);
		expect(summary.steps_with_envelope).toBe(1);

		const steps = loadTrace(dir, SESSION);
		expect(steps).toHaveLength(2);
		const first = steps[0];
		expect(first?.key).toEqual({
			session_id: SESSION,
			seq: 1,
			tool_use_id: "toolu_a",
			ts: "2026-07-24T12:00:01.100Z",
		});
		expect(first?.action).toEqual({ tool: "Bash", input: { command: "ls", cwd: null } });
		expect(first?.result).toEqual({ outcome: "ok", observation: { stdout: "files" } });
		expect(first?.pre_tree).toBe("tree-pre-a");
		expect(first?.post_tree).toBe("tree-post-a");
		expect(first?.observation_ref).toContain("inference/");
	});

	it("leaves observation_ref null for envelope-less steps (degraded, not dropped)", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		const second = loadTrace(dir, SESSION)[1];
		expect(second?.key.tool_use_id).toBe("toolu_b");
		expect(second?.observation_ref).toBeNull();
		expect(second?.result).toBeNull();
		expect(second?.pre_tree).toBeNull();
	});

	it("stamps joined envelopes with session/seq into the per-session file", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		const perSession = readFileSync(
			join(dir, ".interlinked", "replay", "inference", `${SESSION}.jsonl`),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((l) => nonNull(parseInferenceEnvelope(JSON.parse(l))));
		expect(perSession).toHaveLength(1);
		expect(perSession[0]?.session_id).toBe(SESSION);
		expect(perSession[0]?.seq).toBe(1);
	});

	it("ignores other sessions' rows and returns zeros for an unknown session", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		const summary = assembleTrace(dir, "someone-else");
		expect(summary.steps).toBe(0);
		expect(loadTrace(dir, "someone-else")).toEqual([]);
	});

	it("is idempotent — reassembling overwrites rather than duplicating", () => {
		const dir = fixture();
		seedStandardFixture(dir);
		assembleTrace(dir, SESSION);
		assembleTrace(dir, SESSION);
		expect(loadTrace(dir, SESSION)).toHaveLength(2);
	});

	it("returns zero steps when collection.jsonl does not exist at all", () => {
		const dir = fixture();
		const summary = assembleTrace(dir, SESSION);
		expect(summary).toEqual({ steps: 0, steps_with_envelope: 0 });
		expect(loadTrace(dir, SESSION)).toEqual([]);
	});

	it("falls back to 'unknown-session' when the session id sanitizes to empty, and stamps '#seq=?' when an envelope's seq is null", () => {
		const dir = fixture();
		const emptyId = "";
		writeCollection(dir, [
			`${JSON.stringify({
				schema: "collection.v1",
				kind: "tool_event",
				session_id: emptyId,
				ts: "2026-07-24T12:00:01.000Z",
				seq: null,
				tool_use_id: "toolu_z",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "ls" },
			})}\n`,
		]);
		appendEnvelope(join(dir, ".interlinked", "replay"), envelope("toolu_z"));

		const summary = assembleTrace(dir, emptyId);
		expect(summary).toEqual({ steps: 1, steps_with_envelope: 1 });

		const step = loadTrace(dir, emptyId)[0];
		expect(step?.observation_ref).toBe("inference/unknown-session.jsonl#seq=?");

		const perSession = readFileSync(
			join(dir, ".interlinked", "replay", "inference", "unknown-session.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((l) => nonNull(parseInferenceEnvelope(JSON.parse(l))));
		expect(perSession).toHaveLength(1);
		expect(perSession[0]?.seq).toBeNull();
	});

	it("skips unparseable and wrong-schema lines in both collection.jsonl and the trace file", () => {
		const dir = fixture();
		writeCollection(dir, [
			"{not valid json at all\n",
			`${JSON.stringify({ schema: "some-other.v1", kind: "tool_event", session_id: SESSION })}\n`,
			collectionRow({
				ts: "2026-07-24T12:00:01.000Z",
				seq: 1,
				tool_use_id: "toolu_ok",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
		]);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(1);

		// Now corrupt the freshly-written trace file by appending garbage and a
		// foreign-schema row, and confirm loadTrace tolerates both.
		appendFileSync(
			join(dir, ".interlinked", "replay", "trace", `${SESSION}.jsonl`),
			`{not valid json\n${JSON.stringify({ schema: "other.v1" })}\n`,
		);
		const steps = loadTrace(dir, SESSION);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.key.tool_use_id).toBe("toolu_ok");
	});

	it("sorts pre-rows by seq first, falling back to timestamp for equal (or missing) seq", () => {
		const dir = fixture();
		writeCollection(dir, [
			// Both rows omit `seq` entirely (typeof !== "number" on both sides) —
			// order must fall back to ts comparison (earlier ts first).
			collectionRow({
				ts: "2026-07-24T12:00:05.000Z",
				tool_use_id: "toolu_later",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "later" },
			}),
			collectionRow({
				ts: "2026-07-24T12:00:01.000Z",
				tool_use_id: "toolu_earlier",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "earlier" },
			}),
		]);
		const summary = assembleTrace(dir, SESSION);
		expect(summary.steps).toBe(2);
		const steps = loadTrace(dir, SESSION);
		expect(steps.map((s) => s.key.tool_use_id)).toEqual(["toolu_earlier", "toolu_later"]);
		// Missing seq -> null in the emitted key (not coerced to Infinity).
		expect(steps[0]?.key.seq).toBeNull();
	});

	it("a pre-row without a tool_use_id gets null refs, an 'ok' outcome default is unreachable without a post row, and a missing action/ts default cleanly", () => {
		const dir = fixture();
		writeCollection(dir, [
			`${JSON.stringify({
				schema: "collection.v1",
				kind: "tool_event",
				session_id: SESSION,
				seq: 1,
				phase: "pre",
				provider_tool: 7, // non-string tool name -> null
				// no `action`, no `ts`, no `tool_use_id`
			})}\n`,
		]);
		const summary = assembleTrace(dir, SESSION);
		expect(summary).toEqual({ steps: 1, steps_with_envelope: 0 });

		const step = loadTrace(dir, SESSION)[0];
		expect(step).toEqual({
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: 1, tool_use_id: null, ts: "" },
			observation_ref: null,
			action: { tool: null, input: null },
			result: null,
			pre_tree: null,
			post_tree: null,
			state_ref: null,
		});
	});

	it("defaults a post row's non-string outcome to 'ok'", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				ts: "2026-07-24T12:00:01.000Z",
				seq: 1,
				tool_use_id: "toolu_a",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
			collectionRow({
				ts: "2026-07-24T12:00:02.000Z",
				seq: 2,
				tool_use_id: "toolu_a",
				phase: "post",
				// no `outcome` field at all -> falls back to "ok"
				observation: { stdout: "x" },
			}),
		]);
		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.result).toEqual({ outcome: "ok", observation: { stdout: "x" } });
	});

	it("treats an array-shaped action as not an object (asObject rejects arrays)", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				ts: "2026-07-24T12:00:01.000Z",
				seq: 1,
				tool_use_id: "toolu_arr",
				phase: "pre",
				provider_tool: "Bash",
				action: ["not", "an", "object"],
			}),
		]);
		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.action).toEqual({ tool: "Bash", input: null });
	});

	it("sets state_ref (with a real seq) once the per-session state file exists", () => {
		const dir = fixture();
		writeCollection(dir, [
			collectionRow({
				ts: "2026-07-24T12:00:01.000Z",
				seq: 9,
				tool_use_id: "toolu_state",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
		]);
		mkdirSync(join(dir, ".interlinked", "replay", "state"), { recursive: true });
		appendFileSync(join(dir, ".interlinked", "replay", "state", `${SESSION}.jsonl`), "");

		assembleTrace(dir, SESSION);
		const step = loadTrace(dir, SESSION)[0];
		expect(step?.state_ref).toBe(`state/${SESSION}.jsonl#seq=9`);
	});
});

describe("parseTraceStep", () => {
	const full = {
		schema: "replay-trace.v1",
		key: { session_id: SESSION, seq: 1, tool_use_id: "toolu_a", ts: "2026-08-10T00:00:00Z" },
		observation_ref: "inference/sess.jsonl#seq=1",
		action: { tool: "Bash", input: { command: "ls" } },
		result: { outcome: "ok", observation: { stdout: "x" } },
		pre_tree: "tree-pre",
		post_tree: "tree-post",
		state_ref: "state/sess.jsonl#seq=1",
	};

	it("P1: accepts a fully-populated step", () => {
		expect(parseTraceStep(full)).toEqual(full);
	});

	it("P2: accepts a degraded step (null action/result/refs, missing tool_use_id/seq)", () => {
		const degraded = {
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: null, tool_use_id: null, ts: "t" },
			observation_ref: null,
			action: null,
			result: null,
			pre_tree: null,
			post_tree: null,
			state_ref: null,
		};
		expect(parseTraceStep(degraded)).toEqual(degraded);
	});

	it("N1: rejects the wrong schema tag", () => {
		expect(parseTraceStep({ ...full, schema: "other.v1" })).toBeNull();
	});

	it("N2: rejects a non-object action (rejects the whole step, not just the field)", () => {
		expect(parseTraceStep({ ...full, action: "not-an-object" })).toBeNull();
	});

	it("N3: rejects a result missing the required string outcome", () => {
		expect(
			parseTraceStep({ ...full, result: { observation: null } }),
		).toBeNull();
	});

	it("N4: rejects a key missing session_id", () => {
		expect(
			parseTraceStep({ ...full, key: { seq: 1, tool_use_id: "t", ts: "t" } }),
		).toBeNull();
	});

	it("N5: rejects a non-object line (array)", () => {
		expect(parseTraceStep(["replay-trace.v1"])).toBeNull();
	});
});
