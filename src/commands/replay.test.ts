import { parseWire, wireRecord, wireString } from "../lib/value-validation.js";
// `interlinked replay` command — pins the status collector (envelope counts
// the operator sees) and the capture-instructions payload (the exact env the
// runner needs). Actions print; the logic lives in exported pure helpers.
//
// The command entry points (`replay*Action`) drive `process.cwd()` directly,
// so they're exercised here by stubbing `process.cwd()` to return a disposable
// tmpdir fixture (the established pattern in this repo — see init.test.ts)
// rather than injecting a cwd parameter or calling the real `process.chdir()`
// (which throws "not supported in workers" under the mutation runner's
// worker-thread vitest pool — confirmed against this file AND, as a control,
// the pre-existing daemons.ts/daemons.test.ts pair). `fetch` is stubbed
// globally for `replayEvalAction` — the ONLY network boundary in this file —
// so no test here ever dials out, regardless of which mutant is live.

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLedgerRow, type LedgerRow } from "../harness/replay/eval-ledger.js";
import { appendEnvelope, type InferenceEnvelope } from "../harness/replay/inference-store.js";
import { recordStateSnapshot } from "../harness/replay/state-archive.js";
import { TOOLCHAIN_TOOLS } from "../harness/replay/toolchain-manifest.js";
import { perSessionEnvelopePath } from "../harness/replay/trace-assembler.js";
import { recordTreeSnapshot } from "../harness/replay/tree-snapshot.js";
import { stripAnsi } from "../lib/formatter.js";
import { nonNull } from "../lib/non-null.js";
import {
	buildCaptureInstructions,
	collectReplayStatus,
	replayAssembleAction,
	replayCaptureAction,
	replayEvalAction,
	replayReportAction,
	replayRestoreAction,
	replayStatusAction,
} from "./replay.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-replay-cmd-"));
	cleanups.push(dir);
	return dir;
}

/** A fresh cwd for the command actions below (they all read `process.cwd()`
 *  directly — chdir into this rather than injecting a cwd param). */
function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-replay-cwd-"));
	cleanups.push(dir);
	return dir;
}

function writeJsonl(path: string, lines: object[]): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function textResponse(body: string, status = 200): Response {
	return new Response(body, { status });
}

/** Stubs `global.fetch` for one test; ALWAYS intercepts (never dials out,
 *  regardless of which mutant/URL is live). Returns the mock for call
 *  inspection. */
function stubFetch(
	responder: (url: string, init: RequestInit) => Response,
) {
	const fetchMock = vi.fn<typeof fetch>(async (url, init) => responder(String(url), nonNull(init)));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function envelope(overrides: Partial<InferenceEnvelope>): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "2026-07-24T12:00:00.000Z",
		ts_response: "2026-07-24T12:00:01.000Z",
		latency_ms: 1000,
		provider: "anthropic",
		request_headers: {},
		request: { model: "m", messages: [] },
		response: { id: "msg", content: [] },
		tool_use_ids: [],
		request_sha256: "0".repeat(64),
		session_id: null,
		seq: null,
		...overrides,
	};
}

describe("collectReplayStatus", () => {
	it("reports zeros for an empty capture dir", () => {
		const status = collectReplayStatus(tempReplayDir());
		expect(status).toEqual({
			envelope_count: 0,
			tool_turn_count: 0,
			latest_ts: null,
		});
	});

	it("counts envelopes, tool-bearing turns, and the latest response ts", () => {
		const dir = tempReplayDir();
		appendEnvelope(dir, envelope({ request_index: 1, tool_use_ids: ["toolu_1"] }));
		appendEnvelope(
			dir,
			envelope({ request_index: 2, ts_response: "2026-07-24T12:05:00.000Z" }),
		);
		const status = collectReplayStatus(dir);
		expect(status.envelope_count).toBe(2);
		expect(status.tool_turn_count).toBe(1);
		expect(status.latest_ts).toBe("2026-07-24T12:05:00.000Z");
	});

	it("keeps the earlier latest_ts when a later-appended envelope is not newer", () => {
		const dir = tempReplayDir();
		appendEnvelope(dir, envelope({ request_index: 1, ts_response: "2026-07-24T12:10:00.000Z" }));
		appendEnvelope(dir, envelope({ request_index: 2, ts_response: "2026-07-24T12:00:00.000Z" }));
		const status = collectReplayStatus(dir);
		expect(status.envelope_count).toBe(2);
		expect(status.latest_ts).toBe("2026-07-24T12:10:00.000Z");
	});
});

describe("buildCaptureInstructions", () => {
	it("names the dist entry, the replay dir, and the base-url export", () => {
		const text = buildCaptureInstructions("/repo");
		expect(text).toContain("dist/harness/replay/inference-proxy.js");
		expect(text).toContain(join("/repo", ".interlinked", "replay"));
		expect(text).toContain("ANTHROPIC_BASE_URL");
	});

	it("produces the exact multi-line text end to end (pins every line and the join separator)", () => {
		const cwd = "/repo";
		const replayDir = join(cwd, ".interlinked", "replay");
		const expected = [
			"Start the inference-boundary capture proxy (records the EXACT model",
			"input/output — the one signal hooks cannot see):",
			"",
			`  1. node ${join(cwd, "dist", "harness", "replay", "inference-proxy.js")}`,
			"       PORT=8787 by default; ANTHROPIC_REAL_BASE_URL to override upstream.",
			"  2. In the runner's shell:  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787",
			"  3. Work normally. Envelopes land in:",
			`       ${join(replayDir, "inference", "pending.jsonl")}`,
			"",
			"Notes: auth headers are forwarded live and NEVER persisted; envelopes",
			"contain full prompts, stay gitignored, and are never synced. `interlinked",
			"replay status` shows capture counts.",
		].join("\n");
		expect(buildCaptureInstructions(cwd)).toBe(expected);
	});
});

describe("replayCaptureAction", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});
	afterEach(() => {
		logSpy.mockRestore();
	});

	it("prints the exact capture instructions for the current cwd (json mode) and returns 0", () => {
		const code = replayCaptureAction({ json: true });
		expect(code).toBe(0);
		expect(logSpy).toHaveBeenCalledTimes(1);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed).toEqual({ instructions: buildCaptureInstructions(process.cwd()) });
	});

	it("prints the same instructions as plain text in normal mode", () => {
		const code = replayCaptureAction({});
		expect(code).toBe(0);
		expect(String(logSpy.mock.calls[0]?.[0])).toBe(buildCaptureInstructions(process.cwd()));
	});
});

describe("replayAssembleAction", () => {
	const SESSION = "sess-assemble-cmd";
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		logSpy.mockRestore();
	});

	function collectionRow(row: Record<string, unknown>): object {
		return { schema: "collection.v1", kind: "tool_event", session_id: SESSION, ...row };
	}

	/** Three pre-events: toolu_a has a post row, an exact-obs envelope, and a
	 *  pre tree snapshot; toolu_b and toolu_c have none — TWO tree-less steps
	 *  against ONE tree-having step makes the tree/envelope counts asymmetric
	 *  (a 1-vs-1 split can't tell "count where present" from "count where
	 *  absent" apart). */
	function seedFixture(dir: string): void {
		writeJsonl(join(dir, ".interlinked", "collection.jsonl"), [
			collectionRow({
				ts: "t1",
				seq: 1,
				tool_use_id: "toolu_a",
				phase: "pre",
				provider_tool: "Bash",
				action: { command: "ls" },
			}),
			collectionRow({
				ts: "t1b",
				seq: 1,
				tool_use_id: "toolu_a",
				phase: "post",
				outcome: "ok",
				observation: { stdout: "x" },
			}),
			collectionRow({
				ts: "t2",
				seq: 2,
				tool_use_id: "toolu_b",
				phase: "pre",
				provider_tool: "Read",
				action: { file_path: "/x" },
			}),
			collectionRow({
				ts: "t3",
				seq: 3,
				tool_use_id: "toolu_c",
				phase: "pre",
				provider_tool: "Read",
				action: { file_path: "/y" },
			}),
		]);
		writeJsonl(join(dir, ".interlinked", "replay", "snapshots", "index.jsonl"), [
			{
				schema: "tree-snapshot.v1",
				session_id: SESSION,
				seq: 1,
				tool_use_id: "toolu_a",
				phase: "pre",
				backend: "git",
				tree: "tree-pre-a",
				commit: "c",
				ts: "t1",
			},
		]);
		appendEnvelope(join(dir, ".interlinked", "replay"), envelope({ tool_use_ids: ["toolu_a"] }));
	}

	it("assembles the session, reports step/envelope/tree counts, and writes a real trace file (json mode)", () => {
		const dir = tempCwd();
		seedFixture(dir);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayAssembleAction({ session: SESSION, json: true });
		expect(code).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed).toMatchObject({
			steps: 3,
			steps_with_envelope: 1,
			steps_with_tree: 1,
			session: SESSION,
		});

		// Real observable side effect: the trace file landed on disk.
		const raw = readFileSync(
			join(dir, ".interlinked", "replay", "trace", `${SESSION}.jsonl`),
			"utf-8",
		);
		const steps = raw
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(steps).toHaveLength(3);
		expect(steps[0].pre_tree).toBe("tree-pre-a");
		expect(steps[1].pre_tree).toBeNull();
		expect(steps[2].pre_tree).toBeNull();
	});

	it("renders the human-readable summary in normal mode", () => {
		const dir = tempCwd();
		seedFixture(dir);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayAssembleAction({ session: SESSION });
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain(`Assembled replay trace for ${SESSION}`);
		expect(text).toContain("steps               3");
		expect(text).toContain("with exact obs      1  (G1 envelopes joined by tool_use_id)");
		expect(text).toContain("with tree snapshots 1");
		expect(text).toContain("trace file          .interlinked/replay/trace/");
		// Pins the join("\n") separator: one real line per array entry, not a
		// single run-on string.
		expect(text.split("\n")).toHaveLength(5);
	});
});

describe("replayEvalAction", () => {
	const SESSION = "sess-eval-cmd";
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	let originalApiKey: string | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalApiKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		vi.unstubAllGlobals();
		if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalApiKey;
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	function evalEnvelope(overrides: Partial<InferenceEnvelope> = {}): InferenceEnvelope {
		return envelope({
			request_headers: { "anthropic-version": "2099-01-01" },
			request: {
				model: "ref-model",
				system: "sys",
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", text: "secret plan" },
							{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
						],
					},
				],
				params: { max_tokens: 100 },
			},
			response: { id: "msg", content: [] },
			tool_use_ids: ["toolu_1"],
			...overrides,
		});
	}

	function evalTraceStep(overrides: Record<string, unknown> = {}): object {
		return {
			schema: "replay-trace.v1",
			key: { session_id: SESSION, seq: 1, tool_use_id: "toolu_1", ts: "t1" },
			observation_ref: `inference/${SESSION}.jsonl#seq=1`,
			action: { tool: "Bash", input: { command: "ls" } },
			result: { outcome: "ok", observation: null },
			pre_tree: null,
			post_tree: null,
			state_ref: null,
			...overrides,
		};
	}

	function writeTrace(dir: string, steps: object[]): void {
		writeJsonl(join(dir, ".interlinked", "replay", "trace", `${SESSION}.jsonl`), steps);
	}

	it("refuses to run without an API key or --base-url, and touches no filesystem or network", async () => {
		const code = await replayEvalAction({ session: SESSION, candidate: "cand" });
		expect(code).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"replay eval: set ANTHROPIC_API_KEY (cloud candidate) or pass --base-url (local candidate).",
		);
	});

	it("reports zero evaluated/skipped/failed for a session with no assembled trace (json mode)", async () => {
		const dir = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		const fetchMock = stubFetch(() => textResponse("{}"));

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-empty",
			baseUrl: "http://127.0.0.1:9",
			json: true,
		});
		expect(code).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.evaluated).toBe(0);
		expect(printed.skipped_no_envelope).toBe(0);
		expect(printed.failed).toBe(0);
		expect(printed.aggregate.steps).toBe(0);
		expect(printed.run_id).toMatch(/^run-\d{8}T\d{6}-cand-empty$/);
	});

	it("proceeds on ANTHROPIC_API_KEY alone (no --base-url) and never calls fetch when there is nothing to evaluate", async () => {
		const dir = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		process.env.ANTHROPIC_API_KEY = "sk-test-key";
		const fetchMock = stubFetch(() => textResponse("{}"));

		const code = await replayEvalAction({ session: SESSION, candidate: "cand", json: true });
		expect(code).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("evaluates an enveloped step end-to-end: posts to --base-url, strips thinking by default, writes a ledger row", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		const fetchMock = stubFetch(() =>
			textResponse(
				JSON.stringify({
					id: "msg_c",
					stop_reason: "tool_use",
					content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
				}),
			),
		);

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-1",
			baseUrl: "http://127.0.0.1:4010",
			json: true,
		});
		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, requestOptions] = nonNull(fetchMock.mock.calls[0]);
		const init = nonNull(requestOptions);
		expect(url).toBe("http://127.0.0.1:4010/v1/messages");
		const headers = parseWire(init.headers, wireRecord(wireString), "test JSON value");
		expect(headers["x-api-key"]).toBeUndefined();
		const body = JSON.parse(parseWire(init.body, wireString, "test JSON value"));
		expect(body.model).toBe("cand-1");
		const assistantMsg = body.messages[1];
		expect(assistantMsg.content.some((b: { type: string }) => b.type === "thinking")).toBe(false);

		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.evaluated).toBe(1);
		expect(printed.failed).toBe(0);
		expect(printed.aggregate.steps).toBe(1);
		expect(printed.aggregate.action_match_rate).toBe(1);

		const ledgerRaw = readFileSync(
			join(dir, ".interlinked", "replay", "eval", printed.run_id, "ledger.jsonl"),
			"utf-8",
		);
		expect(ledgerRaw.trim().split("\n")).toHaveLength(1);
	});

	it("renders the human-readable eval summary in normal mode", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		stubFetch(() =>
			textResponse(
				JSON.stringify({ content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] }),
			),
		);

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-normal",
			baseUrl: "http://127.0.0.1:4020",
		});
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain("Eval run-");
		expect(text).toContain("candidate=cand-normal");
		expect(text).toContain("steps scored        1");
		expect(text).toContain("action match        100.0%");
		expect(text).toContain("structural scored   1");
		expect(text).toContain("steps=1  match=100.0%");
		expect(text).toContain("evaluated=1  no-envelope=0  failed=0");
		expect(text).toContain("ledger: .interlinked/replay/eval/");
		// Pins both join("\n") separators (renderSummary's internal one and the
		// command's outer one): 5 renderSummary lines (title/steps/match/
		// structural/1 by-tool row) + evaluated line + ledger line = 7.
		expect(text.split("\n")).toHaveLength(7);
	});

	it("keeps thinking blocks when --keep-thinking is passed", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		const fetchMock = stubFetch(() => textResponse(JSON.stringify({ content: [] })));

		await replayEvalAction({
			session: SESSION,
			candidate: "cand-keep",
			baseUrl: "http://127.0.0.1:4011",
			keepThinking: true,
			json: true,
		});
		const init = nonNull(nonNull(fetchMock.mock.calls[0])[1]);
		const body = JSON.parse(parseWire(init.body, wireString, "test JSON value"));
		const assistantMsg = body.messages[1];
		expect(assistantMsg.content.some((b: { type: string }) => b.type === "thinking")).toBe(true);
	});

	it("forwards ANTHROPIC_API_KEY as the x-api-key header when set", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		process.env.ANTHROPIC_API_KEY = "sk-real-ish-test-key";
		const fetchMock = stubFetch(() => textResponse(JSON.stringify({ content: [] })));

		await replayEvalAction({
			session: SESSION,
			candidate: "cand-key",
			baseUrl: "http://127.0.0.1:4012",
			json: true,
		});
		const init = nonNull(nonNull(fetchMock.mock.calls[0])[1]);
		const headers = parseWire(init.headers, wireRecord(wireString), "test JSON value");
		expect(headers["x-api-key"]).toBe("sk-real-ish-test-key");
	});

	it("honors --limit, capping evaluation before any candidate call", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		const fetchMock = stubFetch(() => textResponse(JSON.stringify({ content: [] })));

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-lim",
			baseUrl: "http://127.0.0.1:4013",
			limit: "0",
			json: true,
		});
		expect(code).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.evaluated).toBe(0);
	});

	it("counts a candidate failure, logs it, and returns 1 when nothing was evaluated", async () => {
		const dir = tempCwd();
		writeTrace(dir, [evalTraceStep()]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [evalEnvelope()]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		stubFetch(() => textResponse("boom", 500));

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-fail",
			baseUrl: "http://127.0.0.1:4014",
			json: true,
		});
		expect(code).toBe(1);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.evaluated).toBe(0);
		expect(printed.failed).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(String(errorSpy.mock.calls[0]?.[0])).toContain("eval step");
	});

	it("returns 0 when at least one step evaluated even though another step failed", async () => {
		const dir = tempCwd();
		writeTrace(dir, [
			evalTraceStep(),
			evalTraceStep({
				key: { session_id: SESSION, seq: 2, tool_use_id: "toolu_2", ts: "t2" },
				observation_ref: `inference/${SESSION}.jsonl#seq=2`,
			}),
		]);
		writeJsonl(perSessionEnvelopePath(dir, SESSION), [
			evalEnvelope(),
			evalEnvelope({ tool_use_ids: ["toolu_2"] }),
		]);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		let call = 0;
		const fetchMock = stubFetch(() => {
			call++;
			return call === 1 ? textResponse(JSON.stringify({ content: [] })) : textResponse("boom", 500);
		});

		const code = await replayEvalAction({
			session: SESSION,
			candidate: "cand-mixed",
			baseUrl: "http://127.0.0.1:4015",
			json: true,
		});
		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.evaluated).toBe(1);
		expect(printed.failed).toBe(1);
	});
});

describe("replayReportAction", () => {
	const SESSION = "sess-report-cmd";
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		logSpy.mockRestore();
	});

	function ledgerRow(runId: string, model: string, match: boolean, seq = 1): LedgerRow {
		return {
			schema: "replay-eval.v1",
			run_id: runId,
			ts: "2026-07-24T15:00:00.000Z",
			mode: "off_policy",
			reference: { session_id: SESSION, seq, tool_use_id: `toolu_${seq}`, model: "ref-model" },
			candidate: { model, decode: "default" },
			scores: {
				action_match: { same_tool: true, same_input: match, match },
				structural: {
					kind: "argv",
					comparable: true,
					distance: match ? 0 : 2,
					normalized: match ? 0 : 0.5,
				},
			},
			reference_tool: "Bash",
		};
	}

	it("reports a single run in json mode with no comparison key", () => {
		const dir = tempCwd();
		appendLedgerRow(dir, ledgerRow("run-solo", "cand-a", true));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayReportAction({ run: "run-solo", json: true });
		expect(code).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed).toHaveProperty("primary");
		expect(printed).not.toHaveProperty("comparison");
		expect(printed.primary.steps).toBe(1);
		expect(printed.primary.action_match_rate).toBe(1);
	});

	it("compares two runs and reports both summaries (json mode)", () => {
		const dir = tempCwd();
		appendLedgerRow(dir, ledgerRow("run-a", "cand-a", true));
		appendLedgerRow(dir, ledgerRow("run-b", "cand-b", false));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayReportAction({ run: "run-a", compare: "run-b", json: true });
		expect(code).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.primary.action_match_rate).toBe(1);
		expect(printed.comparison.action_match_rate).toBe(0);
	});

	it("renders both summaries and the action-match delta in normal mode", () => {
		const dir = tempCwd();
		// primary: 1/1 matched (rate 1). comparison: 1/2 matched (rate 0.5) — a
		// non-zero, non-equal pair so subtraction and addition disagree (both
		// give 100.0 when the comparison rate is 0, which hid the ArithmeticOperator
		// mutant on the delta calculation).
		appendLedgerRow(dir, ledgerRow("run-x", "cand-a", true, 1));
		appendLedgerRow(dir, ledgerRow("run-y", "cand-b", true, 1));
		appendLedgerRow(dir, ledgerRow("run-y", "cand-b", false, 2));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayReportAction({ run: "run-x", compare: "run-y" });
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain("Eval run-x");
		expect(text).toContain("candidate=cand-a");
		expect(text).toContain("Eval run-y");
		expect(text).toContain("candidate=cand-b");
		expect(text).toContain("steps scored        1");
		expect(text).toContain("steps scored        2");
		expect(text).toContain("Δ action match (primary − comparison): 50.0 points");
		expect(text).toContain("Bash");
		// Pins every join("\n") (5-line primary + blank + 5-line comparison +
		// blank + delta = 13) AND — by checking the separator lines are
		// LITERALLY empty, not just present — the two `parts.push("", ...)`
		// blank-line arguments specifically (a same-line-count mutant that
		// replaces "" with other one-line text would pass a length-only check).
		const lines = text.split("\n");
		expect(lines).toHaveLength(13);
		expect(lines[5]).toBe("");
		expect(lines[11]).toBe("");
	});

	it("renders a single run without a comparison in normal mode (no delta line)", () => {
		const dir = tempCwd();
		appendLedgerRow(dir, ledgerRow("run-solo-normal", "cand-a", true));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayReportAction({ run: "run-solo-normal" });
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain("Eval run-solo-normal");
		expect(text).not.toContain("Δ action match");
		expect(text.split("\n")).toHaveLength(5);
	});
});

describe("replayRestoreAction", () => {
	const SESSION = "sess-restore-cmd";
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	function fixture(): string {
		const dir = tempCwd();
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "t@t.local");
		git(dir, "config", "user.name", "probe");
		writeFileSync(join(dir, "app.ts"), "export const version = 1;\n");
		git(dir, "add", "app.ts");
		git(dir, "commit", "-qm", "init");
		writeFileSync(join(dir, "app.ts"), "export const version = 2;\n");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "metric-caps.json"), '{"lines":500}');
		recordTreeSnapshot({
			cwd: dir,
			sessionId: SESSION,
			seq: 9,
			toolUseId: "toolu_9",
			phase: "pre",
			log: () => undefined,
		});
		recordStateSnapshot({
			cwd: dir,
			sessionId: SESSION,
			seq: 9,
			liveSnapshot: { tool_call_count: 4 },
			log: () => undefined,
		});
		return dir;
	}

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("restores the tree + baseline files, records a toolchain manifest, and returns 0 (json mode)", () => {
		const dir = fixture();
		const dest = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayRestoreAction({ session: SESSION, seq: "9", dest, json: true });
		expect(code).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.tree).toMatch(/^[0-9a-f]{40}$/);
		expect(printed.state_found).toBe(true);
		expect(printed.baselines_written).toBe(1);
		expect(printed.dest).toBe(dest);
		expect(printed.toolchain.node).toBe(process.version);
		for (const tool of TOOLCHAIN_TOOLS) expect(printed.toolchain).toHaveProperty(tool);

		// Real observable side effects on disk.
		expect(readFileSync(join(dest, "app.ts"), "utf-8")).toBe("export const version = 2;\n");
		expect(readFileSync(join(dest, ".interlinked", "metric-caps.json"), "utf-8")).toBe(
			'{"lines":500}',
		);
		const manifestOnDisk = JSON.parse(
			readFileSync(join(dir, ".interlinked", "replay", "toolchain-manifest.json"), "utf-8"),
		);
		expect(manifestOnDisk.schema).toBe("toolchain-manifest.v1");
	});

	it("renders the restore summary in normal mode", () => {
		const dir = fixture();
		const dest = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayRestoreAction({ session: SESSION, seq: "9", dest });
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain(`Restored ${SESSION} @ seq 9`);
		// The tree line prints EXACTLY the first 12 hex chars of the 40-char
		// sha — pins both the "" -> blank-line mutant and the .slice(0, 12)
		// removal (which would leave all 40 chars there instead of 12).
		const treeMatch = text.match(/tree {16}([0-9a-f]+)/);
		expect(treeMatch?.[1]).toHaveLength(12);
		expect(text).toContain("restored (1 baseline file(s))");
		expect(text).toContain(dest);
		expect(text).toContain("toolchain manifest recorded — pin the sandbox to it for rollouts");
		// Pins the final join("\n"): title + tree + state + dest + dim note = 5.
		expect(text.split("\n")).toHaveLength(5);
	});

	it("reports state not archived when only the tree (not the state) was captured, in both json and normal mode", () => {
		const dir = tempCwd();
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "t@t.local");
		git(dir, "config", "user.name", "probe");
		writeFileSync(join(dir, "app.ts"), "v1\n");
		git(dir, "add", "app.ts");
		git(dir, "commit", "-qm", "init");
		recordTreeSnapshot({
			cwd: dir,
			sessionId: SESSION,
			seq: 3,
			toolUseId: "toolu_3",
			phase: "pre",
			log: () => undefined,
		});
		const dest = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const codeJson = replayRestoreAction({ session: SESSION, seq: "3", dest, json: true });
		expect(codeJson).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed.state_found).toBe(false);
		expect(printed.baselines_written).toBe(0);

		// Normal-mode rendering of the SAME not-archived state — the only case
		// that exercises the ternary's false branch text.
		const codeNormal = replayRestoreAction({ session: SESSION, seq: "3", dest });
		expect(codeNormal).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[1]?.[0]));
		expect(text).toContain("not archived for this seq");
	});

	it("prints a descriptive error and returns 1 when no snapshot exists for the seq", () => {
		const dir = fixture();
		const dest = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayRestoreAction({ session: SESSION, seq: "999", dest });
		expect(code).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const message = String(errorSpy.mock.calls[0]?.[0]);
		expect(message).toContain("replay restore:");
		expect(message).toContain("no tree snapshot");
	});
});

describe("replayStatusAction", () => {
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		logSpy.mockRestore();
	});

	it("shows the nothing-captured hint when the replay dir is empty (normal mode)", () => {
		const dir = tempCwd();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayStatusAction({});
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).toContain("Replay capture status");
		expect(text).toContain("envelopes      0");
		expect(text).toContain("tool turns     0");
		// Pins the ?? "—" fallback specifically (not && and not ?? ""): with
		// latest_ts null, "&&" would print "null" and "?? \"\"" would print
		// nothing at all.
		expect(text).toContain("latest         —");
		expect(text).toContain("nothing captured yet");
		// Pins the join("\n") separator: title + envelopes + tool turns +
		// latest + hint = 5 real lines, not one run-on string.
		expect(text.split("\n")).toHaveLength(5);
	});

	it("omits the hint and reports real counts once envelopes exist (json mode)", () => {
		const dir = tempCwd();
		appendEnvelope(join(dir, ".interlinked", "replay"), envelope({ tool_use_ids: ["toolu_1"] }));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayStatusAction({ json: true });
		expect(code).toBe(0);
		const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(printed).toEqual({
			envelope_count: 1,
			tool_turn_count: 1,
			latest_ts: "2026-07-24T12:00:01.000Z",
		});
	});

	it("omits the hint in normal-mode text once envelopes exist", () => {
		const dir = tempCwd();
		appendEnvelope(join(dir, ".interlinked", "replay"), envelope({ tool_use_ids: [] }));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		const code = replayStatusAction({});
		expect(code).toBe(0);
		const text = stripAnsi(String(logSpy.mock.calls[0]?.[0]));
		expect(text).not.toContain("nothing captured yet");
		expect(text).toContain("envelopes      1");
	});
});
