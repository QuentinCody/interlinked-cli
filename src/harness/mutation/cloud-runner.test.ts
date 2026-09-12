import { assert, describe, expect, it, vi } from "vitest";
import {
	type CloudRunnerConfig,
	createCloudMutationRunner,
	describeErrorResponse,
	MutationNotMeasurableError,
	MutationRunnerBusyError,
	MutationRunPendingError,
	readExecutedTestCount,
	readEngineExitCode,
	readNotMeasurable,
	type FetchLike,
	type FetchResponse,
} from "./cloud-runner.js";

const SOURCE = "function f(x){ return x > 0; }";
const REPORT = {
	files: {
		"src/f.ts": {
			source: SOURCE,
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
				},
			],
		},
	},
};

function resp(body: unknown, ok = true, status = 200): FetchResponse {
	return { ok, status, json: () => Promise.resolve(body) };
}

function okFetch(body: unknown): FetchLike {
	return () => Promise.resolve(resp(body));
}

const CFG: CloudRunnerConfig = { url: "https://worker", timeoutMs: 1000 };

describe("readExecutedTestCount", () => {
	it("preserves explicit successful and failed engine exit statuses", () => {
		expect(readEngineExitCode({ engine: { exitCode: 0 } })).toBe(0);
		expect(readEngineExitCode({ engine: { exitCode: 1 } })).toBe(1);
	});

	it.each([null, [], "not a response"])("does not infer execution evidence from a malformed response %j", (body) => {
		expect(readExecutedTestCount(body)).toBeNull();
		expect(readEngineExitCode(body)).toBeUndefined();
	});

	it.each([null, [], "success"])("refuses a malformed claimed engine status %j", (engine) => {
		expect(readEngineExitCode({ engine })).toBeNull();
	});

	it("uses a valid explicit count when the runner provides one", () => {
		expect(readExecutedTestCount({ testRun: { executedTestCount: 3 } })).toBe(3);
	});

	it("refuses Stryker's native test-file inventory because it includes skipped tests without their status", () => {
		expect(
			readExecutedTestCount({
				testFiles: {
					"src/a.test.ts": { tests: [{ id: "1" }, { id: "2" }] },
					"src/b.test.ts": { tests: [{ id: "3" }] },
				},
			}),
		).toBeNull();
	});

	it("rejects a malformed claimed count instead of softening to the native inventory", () => {
		expect(
			readExecutedTestCount({
				testRun: { executedTestCount: "3" },
				testFiles: { "src/a.test.ts": { tests: [{ id: "1" }] } },
			}),
		).toBeNull();
	});

	it("returns null for every native-report-only shape, including empty test files", () => {
		expect(readExecutedTestCount({ testFiles: { "src/a.test.ts": { tests: "not-an-array" } } })).toBeNull();
		expect(readExecutedTestCount({ testFiles: { "src/discovered.test.ts": { tests: [] } } })).toBeNull();
	});
});

describe("createCloudMutationRunner — budget expiry yields a harvestable handle", () => {
	it("P: throws MutationRunPendingError when the budget expires, not a generic error", async () => {
		// The engine keeps working after we give up, and the runner retains the
		// report under our job id — so expiry must be distinguishable from failure.
		const hang: FetchLike = (_u, init) =>
			new Promise((_res, rej) => {
				init.signal.addEventListener("abort", () => rej(new Error("aborted")));
			});
		const runner = createCloudMutationRunner({ url: "https://worker", timeoutMs: 10 }, hang);
		await expect(runner.run("src/f.ts", SOURCE)).rejects.toBeInstanceOf(MutationRunPendingError);
	});

	it("P: the pending error carries the job id and the runner it is held on", async () => {
		const hang: FetchLike = (_u, init) =>
			new Promise((_res, rej) => {
				init.signal.addEventListener("abort", () => rej(new Error("aborted")));
			});
		const runner = createCloudMutationRunner({ url: "https://worker-7", timeoutMs: 10 }, hang);
		const err = await runner.run("src/f.ts", SOURCE).catch((e: unknown) => e);
		assert.instanceOf(err, MutationRunPendingError);
		expect(err.runnerUrl).toBe("https://worker-7");
		expect(err.jobId).not.toHaveLength(0);
	});

	it("P: sends a client-minted job_id so a timed-out caller can still claim it", async () => {
		let sent: Record<string, unknown> = {};
		const capture: FetchLike = (_u, init) => {
			// SAFETY: init.body is the JSON object this very test's runner just built.
			sent = JSON.parse(init.body) as Record<string, unknown>;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner(CFG, capture).run("src/f.ts", SOURCE);
		expect(typeof sent.job_id).toBe("string");
		expect(String(sent.job_id).length).toBeGreaterThan(0);
	});

	it("P: the wire states whole-file scope + incremental:false EXPLICITLY, and never carries shard/range (review pass 19)", async () => {
		let sent: Record<string, unknown> = {};
		const capture: FetchLike = (_u, init) => {
			// SAFETY: init.body is the JSON object this very test's runner just built.
			sent = JSON.parse(init.body) as Record<string, unknown>;
			return Promise.resolve(resp(REPORT));
		};
		// v1 sharding is retired — `shard` no longer even exists on the config
		// type — and cache behavior is an explicit field, never inferred from a
		// missing range (the runner's old !range ⇒ --incremental coupling).
		await createCloudMutationRunner(CFG, capture).run("src/f.ts", SOURCE);
		expect(sent.scope).toBe("whole_file");
		expect(sent.incremental).toBe(false);
		expect("shard" in sent).toBe(false);
		expect("range" in sent).toBe(false);
	});

	it("N: no shard config → no shard field in the body (older Workers see the old wire shape)", async () => {
		let sent: Record<string, unknown> = {};
		const capture: FetchLike = (_u, init) => {
			// SAFETY: init.body is the JSON object this very test's runner just built.
			sent = JSON.parse(init.body) as Record<string, unknown>;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner(CFG, capture).run("src/f.ts", SOURCE);
		expect("shard" in sent).toBe(false);
	});

	it("N: a NON-timeout failure stays a plain error, never a pending handle", async () => {
		// A 500 means the runner is broken; claiming a job later would hang forever.
		const boom: FetchLike = () => Promise.resolve(resp({}, false, 500));
		const err = await createCloudMutationRunner(CFG, boom)
			.run("src/f.ts", SOURCE)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(MutationRunPendingError);
	});

	it("N: a successful run inside budget does not produce a pending handle", async () => {
		const out = await createCloudMutationRunner(CFG, okFetch(REPORT)).run("src/f.ts", SOURCE);
		expect(out.mutants).toHaveLength(1);
	});
});

describe("createCloudMutationRunner", () => {
	it("is available only when a URL is configured", () => {
		expect(createCloudMutationRunner({ url: "", timeoutMs: 1 }, okFetch(REPORT)).available()).toBe(false);
		expect(createCloudMutationRunner(CFG, okFetch(REPORT)).available()).toBe(true);
	});

	it("posts and adapts a Stryker report into mutants", async () => {
		const { mutants, testRun } = await createCloudMutationRunner(CFG, okFetch(REPORT)).run("src/f.ts", SOURCE);
		expect(mutants).toHaveLength(1);
		expect(mutants[0]?.status).toBe("survived");
		expect(mutants[0]?.raw.replacement).toBe(">=");
		expect(testRun).toBeUndefined(); // a mutants-only report carries no test-run
	});

	it("forward-parses an optional testRun signal from the response (spec §7)", async () => {
		const withRun = {
			...REPORT,
			testRun: { overlayGreen: true, redWitnessSatisfied: true, executedTestCount: 2 },
		};
		const { testRun, executedTestCount } = await createCloudMutationRunner(CFG, okFetch(withRun)).run(
			"src/f.ts",
			SOURCE,
		);
		expect(testRun).toEqual({ overlayGreen: true, redWitnessSatisfied: true });
		expect(executedTestCount).toBe(2);
	});

	it("carries a missing executed-test count as null so the evaluator refuses clean", async () => {
		const withRun = { ...REPORT, testRun: { overlayGreen: true, redWitnessSatisfied: true } };
		const result = await createCloudMutationRunner(CFG, okFetch(withRun)).run("src/f.ts", SOURCE);
		expect(result.executedTestCount).toBeNull();
	});

	it("treats a malformed/absent redWitnessSatisfied as null", async () => {
		const withRun = { ...REPORT, testRun: { overlayGreen: true } };
		const { testRun } = await createCloudMutationRunner(CFG, okFetch(withRun)).run("src/f.ts", SOURCE);
		expect(testRun).toEqual({ overlayGreen: true, redWitnessSatisfied: null });
	});

	it("throws on a non-ok response (→ gate turns it into not-measured)", async () => {
		const runner = createCloudMutationRunner(CFG, () => Promise.resolve(resp({}, false, 500)));
		await expect(runner.run("a.ts", "x")).rejects.toThrow();
	});

	it("throws on an unrecognized report", async () => {
		await expect(createCloudMutationRunner(CFG, okFetch(42)).run("a.ts", "x")).rejects.toThrow();
	});

	it("sends the file + overlay content and a bearer token", async () => {
		const captured: { url?: string; body?: string; headers?: Record<string, string> } = {};
		// The response echoes the overlay as its source so the content-binding
		// check passes — this test asserts the OUTBOUND wire only.
		const echo: FetchLike = (url, init) => {
			captured.url = url;
			captured.body = init.body;
			captured.headers = init.headers;
			return Promise.resolve(resp({ files: { "src/f.ts": { source: "OVERLAY", mutants: [] } } }));
		};
		await createCloudMutationRunner({ ...CFG, token: "T" }, echo).run("src/f.ts", "OVERLAY");
		expect(captured.url).toBe("https://worker");
		expect(captured.headers?.authorization).toBe("Bearer T");
		expect(captured.body).toContain("OVERLAY");
	});

	it("carries the full overlay set on the wire when provided (spec §7)", async () => {
		let body: string | undefined;
		const spy: FetchLike = (_url, init) => {
			body = init.body;
			return Promise.resolve(resp({ files: { "src/f.ts": { source: "SRC", mutants: [] } } }));
		};
		const overlays = [
			{ path: "src/f.ts", content: "SRC" },
			{ path: "src/f.test.ts", content: "TEST" },
		];
		await createCloudMutationRunner(CFG, spy).run("src/f.ts", "SRC", overlays);
		const parsed = JSON.parse(body ?? "{}");
		expect(parsed.overlays).toEqual(overlays);
	});

	it("carries the CLI-selected exact test scope and its provenance on the wire", async () => {
		let body: string | undefined;
		const spy: FetchLike = (_url, init) => {
			body = init.body;
			return Promise.resolve(resp({ files: { "src/f.ts": { source: "SRC", mutants: [] } } }));
		};
		await createCloudMutationRunner(CFG, spy).run("src/f.ts", "SRC", undefined, {
			testFiles: ["src/f.integration.test.ts", "src/f.mutation-kill.test.ts"],
			scopeMode: "import_graph",
		});
		expect(JSON.parse(body ?? "{}")).toMatchObject({
			testScope: ["src/f.integration.test.ts", "src/f.mutation-kill.test.ts"],
			test_scope_mode: "import_graph",
		});
	});

	it("omits the overlays key entirely when not provided (older-Worker back-compat)", async () => {
		let body: string | undefined;
		const spy: FetchLike = (_url, init) => {
			body = init.body;
			return Promise.resolve(resp({ files: { "src/f.ts": { source: "SRC", mutants: [] } } }));
		};
		await createCloudMutationRunner(CFG, spy).run("src/f.ts", "SRC");
		expect(JSON.parse(body ?? "{}")).not.toHaveProperty("overlays");
	});
});

function jsonRunner(body: unknown) {
	const fetchImpl = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => body,
	}));
	// SAFETY: the mock implements exactly the {ok,status,json} shape FetchLike needs;
	// vi.fn() cannot express that structurally without restating the full DOM type.
	return createCloudMutationRunner({ url: "http://runner/", timeoutMs: 500 }, fetchImpl);
}

describe("MutationNotMeasurableError — 'nothing to measure' is not 'runner broke'", () => {
	it("is raised when the runner reports a structured not_measurable body", async () => {
		const runner = jsonRunner({ not_measurable: { reason: "no_tests", detail: "0 tests matched" } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toBeInstanceOf(MutationNotMeasurableError);
	});

	it("carries the reason so callers can branch on it", async () => {
		const runner = jsonRunner({ not_measurable: { reason: "no_tests" } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toMatchObject({ reason: "no_tests" });
	});

	it("is NOT raised for an ordinary report", async () => {
		const runner = jsonRunner({ files: { "src/a.ts": { source: "x", mutants: [] } } });
		await expect(runner.run("src/a.ts", "x", [])).resolves.toBeDefined();
	});

	it("P: an EMPTY files report is refused — silence about the target is not measurement (review 2026-08-24 item 1)", async () => {
		const runner = jsonRunner({ files: {} });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/no entry for src\/a\.ts/);
	});

	it("P: the Worker's RED-suite shape — {files:{}, testRun:{overlayGreen:false}} — is a RESULT, not an error (review 2026-08-25 pass 7)", async () => {
		// Stryker never runs on a red overlay suite, so the report legitimately
		// has no target entry. Throwing here turned a KNOWN red suite into
		// "unavailable", which allow_unmeasured then allowed.
		const runner = jsonRunner({ files: {}, testRun: { overlayGreen: false, redWitnessSatisfied: null } });
		const out = await runner.run("src/a.ts", "x", []);
		expect(out.mutants).toEqual([]);
		expect(out.testRun?.overlayGreen).toBe(false);
	});

	it("N: a GREEN test run does not bypass target selection — the empty report is still refused", async () => {
		const runner = jsonRunner({ files: {}, testRun: { overlayGreen: true, redWitnessSatisfied: null } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/no entry/);
	});

	it("P: a report mentioning only OTHER files is refused for the requested target", async () => {
		const runner = jsonRunner({ files: { "src/other.ts": { source: "y", mutants: [] } } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/missing target is not a clean measurement/);
	});

	it("N: an absolute requested path canonicalizes against config.cwd and matches its repo-relative entry", async () => {
		const fetchImpl: FetchLike = () =>
			Promise.resolve(resp({ files: { "src/a.ts": { source: "x", mutants: [] } } }));
		const runner = createCloudMutationRunner({ ...CFG, cwd: "/repo" }, fetchImpl);
		await expect(runner.run("/repo/src/a.ts", "x", [])).resolves.toBeDefined();
	});

	it("P: a colliding path SUFFIX is refused — packages/x/src/a.ts is not src/a.ts (review 2026-08-25)", async () => {
		const runner = jsonRunner({ files: { "packages/x/src/a.ts": { source: "x", mutants: [] } } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/no entry for src\/a\.ts/);
	});

	it("P: a bare basename is refused for a nested target — a.ts is not src/a.ts", async () => {
		const runner = jsonRunner({ files: { "a.ts": { source: "x", mutants: [] } } });
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/no entry/);
	});

	it("P: only the TARGET entry's mutants are returned — foreign files' mutants never leak in", async () => {
		const runner = jsonRunner({
			files: {
				"src/a.ts": { source: "x", mutants: [] },
				"src/other.ts": {
					source: "function g(y){ return y > 0; }",
					mutants: [
						{
							mutatorName: "EqualityOperator",
							replacement: ">=",
							status: "Killed",
							location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
						},
					],
				},
			},
		});
		const out = await runner.run("src/a.ts", "x", []);
		expect(out.mutants).toEqual([]);
	});

	it("P: a report describing STALE source is refused — a stale result never certifies a new edit", async () => {
		const runner = jsonRunner({ files: { "src/a.ts": { source: "OLD CONTENT", mutants: [] } } });
		await expect(runner.run("src/a.ts", "NEW CONTENT", [])).rejects.toThrow(/different source/);
	});

	it("P: two spellings resolving to one canonical target are refused as ambiguous", async () => {
		const runner = jsonRunner({
			files: {
				"src/a.ts": { source: "x", mutants: [] },
				"./src/a.ts": { source: "x", mutants: [] },
			},
		});
		await expect(runner.run("src/a.ts", "x", [])).rejects.toThrow(/ambiguous/);
	});

	it("ignores a malformed not_measurable payload rather than inventing a reason", async () => {
		for (const body of [{ not_measurable: null }, { not_measurable: {} }, { not_measurable: { reason: "" } }]) {
			const runner = jsonRunner({ ...body, files: { "src/a.ts": { source: "x", mutants: [] } } });
			await expect(runner.run("src/a.ts", "x", [])).resolves.toBeDefined();
		}
	});
});

describe("readNotMeasurable — validate the wire shape at its boundaries", () => {
	it("rejects null and primitive bodies without throwing", () => {
		expect(readNotMeasurable(null)).toBeNull();
		expect(readNotMeasurable("not an object")).toBeNull();
		expect(readNotMeasurable(42)).toBeNull();
	});

	it("keeps a string detail and omits a non-string detail", () => {
		expect(readNotMeasurable({ not_measurable: { reason: "no_tests", detail: "none matched" } })).toEqual({
			reason: "no_tests",
			detail: "none matched",
		});
		expect(readNotMeasurable({ not_measurable: { reason: "no_tests", detail: 42 } })).toEqual({
			reason: "no_tests",
		});
	});
});

describe("cloud-runner error responses — preserve useful diagnostics", () => {
	function errorResponse(text: string, status = 500): FetchResponse {
		return {
			ok: false,
			status,
			json: async () => ({}),
			text: async () => text,
		};
	}

	it("uses the bare status when an error response has no text reader", async () => {
		await expect(describeErrorResponse({ ok: false, status: 502, json: async () => ({}) })).resolves.toBe(
			"mutation runner HTTP 502",
		);
	});

	it("uses the bare status for whitespace-only text", async () => {
		await expect(describeErrorResponse(errorResponse(" \n\t "))).resolves.toBe("mutation runner HTTP 500");
	});

	it("extracts JSON string and object messages, including each supported key", async () => {
		await expect(describeErrorResponse(errorResponse(JSON.stringify("plain message")))).resolves.toBe(
			"mutation runner HTTP 500: plain message",
		);
		for (const key of ["error", "message", "detail", "reason"]) {
			await expect(
				describeErrorResponse(errorResponse(JSON.stringify({ [key]: `${key} message` }))),
			).resolves.toBe(`mutation runner HTTP 500: ${key} message`);
		}
	});

	it("skips unusable JSON fields and falls through to a later supported key", async () => {
		await expect(
			describeErrorResponse(errorResponse(JSON.stringify({ error: { nested: true }, message: "fallback" }))),
		).resolves.toBe("mutation runner HTTP 500: fallback");
		await expect(
			describeErrorResponse(errorResponse(JSON.stringify({ error: "   ", message: "fallback" }))),
		).resolves.toBe("mutation runner HTTP 500: fallback");
		await expect(
			describeErrorResponse(errorResponse(JSON.stringify({ error: "Stryker was here!", message: "fallback" }))),
		).resolves.toBe("mutation runner HTTP 500: Stryker was here!");
	});

	it("uses the bare status when reading the error body itself throws", async () => {
		await expect(
			describeErrorResponse({
				ok: false,
				status: 500,
				json: async () => ({}),
				text: () => Promise.reject(new Error("body stream already consumed")),
			}),
		).resolves.toBe("mutation runner HTTP 500");
	});

	it("collapses and bounds whitespace in a JSON string message", async () => {
		const long = `  first\n\tsecond ${"x".repeat(500)}  `;
		const result = await describeErrorResponse(errorResponse(JSON.stringify(long)));
		const detail = result.slice("mutation runner HTTP 500: ".length);
		expect(detail).toBe(`first second ${"x".repeat(500)}`.slice(0, 400));
		expect(detail).not.toContain("\n");
	});
});

describe("cloud-runner protocol details", () => {
	it("reports a busy runner with a dedicated typed error and stable identity", async () => {
		const runner = createCloudMutationRunner(CFG, () => Promise.resolve(resp({}, true, 503)));
		const err = await runner.run("src/f.ts", SOURCE).catch((value: unknown) => value);
		assert.instanceOf(err, MutationRunnerBusyError);
		expect(err.name).toBe("MutationRunnerBusyError");
		expect(err.message).toContain("HTTP 503");
	});

	it("does not treat a non-ok response containing a valid report as success", async () => {
		const runner = createCloudMutationRunner(CFG, () => Promise.resolve(resp(REPORT, false, 500)));
		await expect(runner.run("src/f.ts", SOURCE)).rejects.toThrow("mutation runner HTTP 500");
	});

	it("keeps the explicit unrecognized-report diagnostic", async () => {
		await expect(createCloudMutationRunner(CFG, okFetch(42)).run("a.ts", "x")).rejects.toThrow(
			"unrecognized mutation report",
		);
	});

	it("sends a POST request", async () => {
		let method: string | undefined;
		const capture: FetchLike = (_url, init) => {
			method = init.method;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner(CFG, capture).run("src/f.ts", SOURCE);
		expect(method).toBe("POST");
	});

	it("always sends the JSON content type and only adds authorization when tokened", async () => {
		let headers: Record<string, string> | undefined;
		const capture: FetchLike = (_url, init) => {
			headers = init.headers;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner(CFG, capture).run("src/f.ts", SOURCE);
		expect(headers).toEqual({ "content-type": "application/json" });
	});

	it("does not expose malformed overlayGreen values as a test run", async () => {
		const body = { ...REPORT, testRun: { overlayGreen: "yes", redWitnessSatisfied: true } };
		const result = await createCloudMutationRunner(CFG, okFetch(body)).run("src/f.ts", SOURCE);
		expect(result.testRun).toBeUndefined();
	});

	it("clears the timeout after a successful response", async () => {
		vi.useFakeTimers();
		try {
			let signal: AbortSignal | undefined;
			const capture: FetchLike = (_url, init) => {
				signal = init.signal;
				return Promise.resolve(resp(REPORT));
			};
			await createCloudMutationRunner({ ...CFG, timeoutMs: 100 }, capture).run("src/f.ts", SOURCE);
			vi.advanceTimersByTime(101);
			expect(signal?.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("cloud-runner error identities", () => {
	it("retain the detail in MutationNotMeasurableError.message", () => {
		const error = new MutationNotMeasurableError("no_tests", "0 tests matched");
		expect(error.message).toBe("no_tests: 0 tests matched");
	});

	it("retain the pending-job message, name, and an eight-character random suffix", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
		try {
			const hang: FetchLike = (_u, init) =>
				new Promise((_res, rej) => {
					init.signal.addEventListener("abort", () => rej(new Error("aborted")));
				});
			const runner = createCloudMutationRunner({ ...CFG, timeoutMs: 10 }, hang);
			const error = await runner.run("src/f.ts", SOURCE).catch((value: unknown) => value);
			assert.instanceOf(error, MutationRunPendingError);
			expect(error.name).toBe("MutationRunPendingError");
			expect(error.message).toMatch(/^mutation run still pending \(job m-[^-]+-[a-z0-9]{8}\)$/);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
