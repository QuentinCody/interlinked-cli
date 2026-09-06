import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyManifest } from "./manifest.js";
import type { MutationManifest } from "./types.js";

// Override hook for `mutationIdentityAvailable` — null (the default) passes
// through to the REAL implementation so every other test in this file keeps
// exercising the actual TypeScript-availability check; a single test sets
// this to `false` for its own duration to reach the (otherwise environment-
// dependent — this repo always has `typescript` installed) "identity
// unavailable" branch of `explainRefusal`, then resets it in `afterEach`.
let identityAvailableOverride: boolean | null = null;
// Decoupled from `identityAvailableOverride` on purpose: real `deriveIdentities`
// can only return null for the SAME reason `mutationIdentityAvailable` is false
// (no `typescript`), so `recordEvidenceRefusal`'s `identities === null` branch
// (measure.ts, "the TypeScript API is unavailable" after a target was already
// found) is otherwise unreachable — `mutationIdentityAvailable()` gates it
// first. This override forces JUST `deriveIdentities` null while availability
// stays real (true, in this repo), reaching that second, independent check.
let forceIdentitiesNull = false;
// Independently truncates a REAL (non-null) identities array by one entry, so
// `measuredMutant` sees `identities[index] === undefined` for the last mutant
// — the defensive guard against a zip shorter than the mutant census, which a
// real 1:1 `deriveIdentities` zip can never produce on its own.
let truncateIdentities = false;
vi.mock("./identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./identity.js")>();
	// `explainRefusal` (measure.ts) only calls `mutationIdentityAvailable`, but
	// `seedFileBaseline` (adopt.ts, imported separately) calls `deriveIdentities`
	// / `computeSymbolHashes` directly — both must degrade together for the
	// override to reach the SAME "unavailable" outcome `recordMeasurement`
	// would see for real (a missing `typescript` optionalDependency), rather
	// than explainRefusal disagreeing with what seedFileBaseline actually did.
	return {
		...actual,
		mutationIdentityAvailable: () =>
			identityAvailableOverride ?? actual.mutationIdentityAvailable(),
		deriveIdentities: (...args: Parameters<typeof actual.deriveIdentities>) => {
			if (identityAvailableOverride === false || forceIdentitiesNull) return null;
			const real = actual.deriveIdentities(...args);
			return truncateIdentities && real !== null ? real.slice(0, -1) : real;
		},
		computeSymbolHashes: (...args: Parameters<typeof actual.computeSymbolHashes>) =>
			identityAvailableOverride === false ? null : actual.computeSymbolHashes(...args),
	};
});

// `recordMeasurement`'s "consistency bug" branch fires only when
// `recordEvidenceRefusal` (measure.ts's own admission re-derivation) finds no
// refusal but `seedFileBaseline` (adopt.ts, a SEPARATE re-derivation of the
// same admission) still rejects — which the two independent implementations
// can only disagree on defensively, never for a real input (see adopt.ts's own
// doc comment on `selectTargetEntry`). Forcing just this one write path null,
// while every other test keeps exercising the real writer, reaches it without
// touching measure.ts's own (real, unmocked) admission logic.
let forceSeedFileBaselineNull = false;
vi.mock("./adopt.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./adopt.js")>();
	return {
		...actual,
		seedFileBaseline: (...args: Parameters<typeof actual.seedFileBaseline>) =>
			forceSeedFileBaselineNull ? null : actual.seedFileBaseline(...args),
	};
});

const {
	buildMeasureOverlays,
	buildScopedMeasureOverlays,
	MAX_MEASURE_OVERLAYS,
	measureFile,
	recordMeasurement,
	requestWholeFileReport,
} = await import("./measure.js");
type FetchResponseLike = import("./measure.js").FetchResponseLike;

const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";

function completeRunEvidence() {
	return {
		engine: { exitCode: 0 },
		testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 1 },
		testFiles: {
			"src/a.test.ts": { tests: [{ id: "test-1", name: "f returns true" }] },
		},
	};
}

/** A Stryker-shaped report for CONTENT with one mutant at the `>`. */
function report(status: string, file: string = FILE, content: string = CONTENT) {
	const line2 = content.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		...completeRunEvidence(),
		files: {
			[file]: {
				source: content,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

function reportWithReplacement(status: string, replacement: string) {
	const base = report(status);
	const entry = base.files[FILE];
	if (entry === undefined) throw new Error("report helper lost its target entry");
	return {
		...base,
		files: {
			[FILE]: {
				...entry,
				mutants: entry.mutants.map((mutant) => ({ ...mutant, replacement })),
			},
		},
	};
}

function fakeResponse(status: number, body: unknown): FetchResponseLike {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
	identityAvailableOverride = null;
	forceIdentitiesNull = false;
	truncateIdentities = false;
	forceSeedFileBaselineNull = false;
});

describe("buildMeasureOverlays", () => {
	it("P1: includes the companion test when it exists on disk", () => {
		const disk = new Map([["src/a.test.ts", "test content"]]);
		const overlays = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(overlays.map((o) => o.path)).toEqual([FILE, "src/a.test.ts"]);
	});

	it("N1: omits the companion test when it does not exist on disk", () => {
		const overlays = buildMeasureOverlays(FILE, CONTENT, () => null);
		expect(overlays.map((o) => o.path)).toEqual([FILE]);
	});

	it("P2: pulls in transitive local deps from both the target and its companion", () => {
		const disk = new Map([
			["src/a.test.ts", "import './b.js'"],
			["src/a.ts", CONTENT],
			["src/b.ts", "import './c.js'"],
			["src/c.ts", "export const z = 1;\n"],
		]);
		const overlays = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(overlays.map((o) => o.path)).toEqual(["src/a.ts", "src/a.test.ts", "src/b.ts", "src/c.ts"]);
	});

	it("N2: never adds a dep path twice even when both the target and companion import it", () => {
		const disk = new Map([
			["src/a.test.ts", "import './shared.js'"],
			["src/a.ts", "import './shared.js'\n" + CONTENT],
			["src/shared.ts", "export const z = 1;\n"],
		]);
		const overlays = buildMeasureOverlays(FILE, disk.get("src/a.ts") ?? "", (p) => disk.get(p) ?? null);
		const sharedCount = overlays.filter((o) => o.path === "src/shared.ts").length;
		expect(sharedCount).toBe(1);
	});

	it("N3: skips the companion entirely when the target has no test-pairable extension (companion === file)", () => {
		// `expectedCompanionTest` only rewrites a recognized `.ts`/`.js`/… suffix;
		// an extensionless path comes back UNCHANGED, so `companion !== file` is
		// false and the companion push is skipped outright.
		const overlays = buildMeasureOverlays("src/README", "readme content", () => "should never be read");
		expect(overlays).toEqual([{ path: "src/README", content: "readme content" }]);
	});
});

describe("buildScopedMeasureOverlays", () => {
	it("P1: ships every test in the scope, plus each scope test's own transitive deps", () => {
		const disk = new Map([
			["src/a.ts", CONTENT],
			["src/a.test.ts", "sibling companion, no imports"],
			["src/a-roundtrip.test.ts", "import './helper.js'"],
			["src/helper.ts", "export const h = 1;\n"],
			["src/a-outcome.test.ts", "no imports here either"],
		]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/a-roundtrip.test.ts",
			"src/a-outcome.test.ts",
		]);
		expect(result.overlays.map((o) => o.path)).toEqual([
			"src/a.ts",
			"src/a.test.ts",
			"src/a-roundtrip.test.ts",
			"src/a-outcome.test.ts",
			"src/helper.ts",
		]);
		expect(result.unreadable).toEqual([]);
		expect(result.capped).toBeUndefined();
	});

	it("N1: a scope test that cannot be read is reported in `unreadable`, not silently dropped", () => {
		const disk = new Map([["src/a.ts", CONTENT]]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/ghost.test.ts",
		]);
		expect(result.overlays.map((o) => o.path)).toEqual(["src/a.ts"]);
		expect(result.unreadable).toEqual(["src/ghost.test.ts"]);
	});

	it("P2: an empty testScope reduces to exactly buildMeasureOverlays's behavior", () => {
		const disk = new Map([["src/a.test.ts", "test content"]]);
		const scoped = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, []);
		const plain = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(scoped.overlays).toEqual(plain);
		expect(scoped.unreadable).toEqual([]);
	});

	it("N2: overflow caps the dependency closure but NEVER drops target/companion/scope files themselves", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const testScope: string[] = [];
		for (let i = 0; i < 10; i++) {
			const testPath = `src/scope-${i}.test.ts`;
			testScope.push(testPath);
			disk.set(testPath, `import './dep-${i}.js'`);
			disk.set(`src/dep-${i}.ts`, "export const z = 1;\n");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, testScope);
		// No overflow at this small scale — everything present, nothing capped.
		expect(result.capped).toBeUndefined();
		for (const t of testScope) {
			expect(result.overlays.some((o) => o.path === t)).toBe(true);
		}
	});

	it("N3: MAX_MEASURE_OVERLAYS caps dependency spillover once the candidate set exceeds it, keeping the request set intact", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const testScope: string[] = [];
		const overCap = MAX_MEASURE_OVERLAYS + 20;
		for (let i = 0; i < overCap; i++) {
			const testPath = `src/scope-${i}.test.ts`;
			testScope.push(testPath);
			disk.set(testPath, "no imports");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, testScope);
		expect(result.capped).toBeUndefined(); // no DEPS here, so the required set alone can exceed the const without a "capped" dep-overflow marker
		// Every requested scope test is still present — required paths are never truncated.
		for (const t of testScope) {
			expect(result.overlays.some((o) => o.path === t)).toBe(true);
		}
	});

	it("N4: a testScope entry that duplicates an already-collected path (the companion) is skipped, not re-added", () => {
		const disk = new Map([["src/a.ts", CONTENT], ["src/a.test.ts", "no imports"]]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/a.test.ts", // == the companion, already collected before the scope loop runs
		]);
		expect(result.overlays.map((o) => o.path)).toEqual(["src/a.ts", "src/a.test.ts"]);
		expect(result.unreadable).toEqual([]);
	});

	it("N5: reports a non-empty `capped.dropped` when the DEPENDENCY closure (not the required set) overflows the cap", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const depCount = MAX_MEASURE_OVERLAYS + 2;
		const imports = Array.from({ length: depCount }, (_, i) => `import './dep-${i}.js';`).join("\n");
		disk.set("src/a.test.ts", imports);
		for (let i = 0; i < depCount; i++) {
			disk.set(`src/dep-${i}.ts`, "export const z = 1;\n");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, []);
		expect(result.capped).toBeDefined();
		expect(result.capped?.limit).toBe(MAX_MEASURE_OVERLAYS);
		expect(result.capped?.dropped.length).toBeGreaterThan(0);
		// The required set (target + companion) is NEVER among the dropped paths.
		expect(result.capped?.dropped).not.toContain("src/a.ts");
		expect(result.capped?.dropped).not.toContain("src/a.test.ts");
		expect(result.overlays.length).toBe(MAX_MEASURE_OVERLAYS);
		expect(result.overlays.some((o) => o.path === "src/a.ts")).toBe(true);
		expect(result.overlays.some((o) => o.path === "src/a.test.ts")).toBe(true);
	});

	it("N6: `capped.dropped` is EXACTLY the overflow tail's real paths, not the whole spillover and not placeholders", () => {
		// test-contract: invariant — a caller trusts `capped.dropped` to name
		// precisely the files missing from `overlays` so it can report an
		// honestly-incomplete closure; a wrong list (too many entries, or
		// entries that aren't real paths) breaks that trust silently.
		const disk = new Map<string, string>();
		const depCount = MAX_MEASURE_OVERLAYS + 5;
		const imports = Array.from({ length: depCount }, (_, i) => `import './dep${i}.js';`).join("\n");
		disk.set(FILE, imports);
		for (let i = 0; i < depCount; i++) disk.set(`src/dep${i}.ts`, "export const z = 1;\n");
		const result = buildScopedMeasureOverlays(FILE, imports, (p) => disk.get(p) ?? null, []);
		expect(result.capped).toBeDefined();
		// Only the target itself is "required" here (no companion, no scope) —
		// so the budget for kept deps is MAX_MEASURE_OVERLAYS minus that one
		// slot. `collectLocalDeps` itself is ALSO capped at MAX_MEASURE_OVERLAYS
		// (measure.ts's own comment on that call site), so the candidate dep
		// list tops out at MAX_MEASURE_OVERLAYS even though depCount asks for 5 more.
		const budget = MAX_MEASURE_OVERLAYS - 1;
		const collectedDeps = Math.min(depCount, MAX_MEASURE_OVERLAYS);
		const expectedDropped = Array.from({ length: collectedDeps - budget }, (_, i) => `src/dep${budget + i}.ts`);
		expect(result.capped?.dropped).toEqual(expectedDropped);
		expect(result.overlays.length).toBe(MAX_MEASURE_OVERLAYS);
		for (const p of expectedDropped) {
			expect(result.overlays.some((o) => o.path === p)).toBe(false);
		}
	});
});

describe("requestWholeFileReport", () => {
	const baseArgs = {
		file: FILE,
		content: CONTENT,
		overlays: [{ path: FILE, content: CONTENT }],
		jobId: "job-1",
		deadlineMs: 5_000,
		requestTimeoutMs: 1_000,
	};

	it("P1: returns the body from the first endpoint that answers 200", async () => {
		const body = { files: {} };
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome).toEqual({ ok: true, body });
	});

	it("P2: falls over to the second endpoint when the first is unreachable", async () => {
		const body = { files: {} };
		let calls = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://down/", "http://up/"],
			fetchImpl: async (url) => {
				calls++;
				if (url === "http://down/") throw new Error("ECONNREFUSED");
				return fakeResponse(200, body);
			},
		});
		expect(outcome).toEqual({ ok: true, body });
		expect(calls).toBe(2);
	});

	it("N1: a non-503 HTTP error is reported immediately, without retrying", async () => {
		let calls = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => {
				calls++;
				return fakeResponse(500, {});
			},
		});
		expect(outcome).toEqual({ ok: false, reason: "mutation runner HTTP 500" });
		expect(calls).toBe(1);
	});

	it("N2: every endpoint busy/unreachable until the deadline reports 'busy or unreachable', never a forged success", async () => {
		// A virtual clock: fetchImpl always fails, sleep() advances the clock
		// instead of actually waiting, so the retry loop runs to completion in
		// real time under a millisecond while still exercising the deadline math.
		let clock = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			deadlineMs: 3_000,
			endpoints: ["http://busy/"],
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("busy or unreachable");
	});

	it("P3: a busy-exhausted outcome is TAGGED busy: true — never indistinguishable from a real HTTP error", async () => {
		// The measurement-integrity property under test: a caller must be able to
		// branch on a structured flag, not on parsing the reason string. A busy
		// runner never answered the "does this file have tests?" question, so
		// this MUST NOT read like (or be confusable with) a no_tests verdict.
		let clock = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			deadlineMs: 2_000,
			endpoints: ["http://busy-1/", "http://busy-2/"],
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome).toMatchObject({ ok: false, busy: true });
		expect(outcome.ok === false && outcome.reason).toContain("runner_busy");
		expect(outcome.ok === false && outcome.reason).not.toContain("no_tests");
	});

	it("N3: a genuine non-503 HTTP error is NOT tagged busy — it is a definitive (if unhappy) answer", async () => {
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(500, {}),
		});
		expect(outcome).toEqual({ ok: false, reason: "mutation runner HTTP 500" });
		expect((outcome as { busy?: boolean }).busy).toBeUndefined();
	});

	it("P4: forwards `testScope` verbatim in the request body when provided", async () => {
		let capturedBody = "";
		await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			testScope: ["src/a.test.ts", "src/b.test.ts"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(JSON.parse(capturedBody).testScope).toEqual(["src/a.test.ts", "src/b.test.ts"]);
	});

	it("N4: omits `testScope` from the request body entirely when not provided", async () => {
		let capturedBody = "";
		await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(Object.prototype.hasOwnProperty.call(JSON.parse(capturedBody), "testScope")).toBe(false);
	});

	it("P5: sends the JSON content type and only adds bearer auth when a token is supplied", async () => {
		const headers: Array<Record<string, string>> = [];
		const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
			headers.push(init.headers);
			return fakeResponse(200, { files: {} });
		};
		await requestWholeFileReport({ ...baseArgs, endpoints: ["http://runner/"], fetchImpl });
		await requestWholeFileReport({ ...baseArgs, token: "secret", endpoints: ["http://runner/"], fetchImpl });
		expect(headers[0]).toEqual({ "content-type": "application/json" });
		expect(headers[1]).toEqual({ "content-type": "application/json", authorization: "Bearer secret" });
	});

	it("P6: sends explicit scope/incremental fields and NO range key (protocol v2)", async () => {
		let body = "";
		await requestWholeFileReport({
			...baseArgs,
			content: "one\ntwo\nthree\n",
			endpoints: ["http://runner/"],
			fetchImpl: async (_url, init) => {
				body = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		// The runner selects cache behavior ONLY from the explicit `incremental`
		// field; protocol v2 rejects `range`, so the wire must never carry it.
		// SAFETY: body is the JSON object this very test's request just built.
		const sent = JSON.parse(body) as Record<string, unknown>;
		expect(sent.scope).toBe("whole_file");
		expect(sent.incremental).toBe(false);
		expect("range" in sent).toBe(false);
	});

	it("N5: gives up after exactly three unreachable rounds and names all endpoints", async () => {
		let calls = 0;
		const out = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://dead-1", "http://dead-2"],
			deadlineMs: 100,
			fetchImpl: async () => {
				calls++;
				if (calls <= 6) throw new Error("ECONNREFUSED");
				return fakeResponse(200, { files: {} });
			},
			now: () => 0,
			sleep: async () => {},
		});
		if (out.ok) throw new Error("expected failure");
		expect(calls).toBe(6);
		expect(out.reason).toContain("http://dead-1, http://dead-2");
	});

	it("P7: uses deterministic exponential backoff and reports the deadline in seconds", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			let clock = 0;
			const sleeps: number[] = [];
			const out = await requestWholeFileReport({
				...baseArgs,
				endpoints: ["http://busy/"],
				deadlineMs: 5_000,
				fetchImpl: async () => fakeResponse(503, {}),
				now: () => clock,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock += ms;
				},
			});
			if (out.ok) throw new Error("expected failure");
			expect(sleeps.slice(0, 2)).toEqual([2_375, 4_375]);
			expect(out.reason).toContain("after 5s");
		} finally {
			random.mockRestore();
		}
	});

	it("P8: every request is a POST", async () => {
		// test-contract: public-api — the runner's wire contract is a POST; a
		// GET (or any other verb) would be silently rejected or misrouted by a
		// real HTTP server, so this is load-bearing, not incidental.
		let capturedMethod = "";
		await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async (_url, init) => {
				capturedMethod = init.method;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(capturedMethod).toBe("POST");
	});

	it("N6: the DEFAULT sleep (no `sleep` override) genuinely delays the retry — it is not a no-op", async () => {
		// test-contract: invariant — the backoff strategy depends on the retry
		// actually waiting between rounds; a default that resolves instantly
		// would hammer the runner in a tight loop instead of backing off.
		vi.useFakeTimers();
		try {
			let calls = 0;
			let clock = 0;
			const promise = requestWholeFileReport({
				file: FILE,
				content: CONTENT,
				overlays: [{ path: FILE, content: CONTENT }],
				jobId: "job-1",
				deadlineMs: 60_000,
				requestTimeoutMs: 1_000,
				endpoints: ["http://runner/"],
				now: () => clock,
				fetchImpl: async () => {
					calls++;
					return calls === 1 ? fakeResponse(503, {}) : fakeResponse(200, { files: {} });
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toBe(1);
			clock += 20_000;
			await vi.advanceTimersByTimeAsync(20_000);
			const outcome = await promise;
			expect(outcome).toEqual({ ok: true, body: { files: {} } });
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("measureFile", () => {
	const args = {
		file: FILE,
		content: CONTENT,
		overlays: [{ path: FILE, content: CONTENT }],
	};

	it("P1: a full report classifies as 'measured' with the raw report attached", async () => {
		const body = report("Survived");
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, body) });
		expect(outcome.status).toBe("measured");
		expect(outcome.mutantCount).toBe(1);
		expect(outcome.survivorCount).toBe(1);
		expect(outcome.rawReport).toEqual(body);
	});

	it("P2: distinguishes killed from survived mutants in the same report — not just a length check", async () => {
		const killed = report("Killed");
		const survived = report("Survived");
		const both = {
			...completeRunEvidence(),
			files: {
				[FILE]: {
					source: CONTENT,
					mutants: [...(killed.files[FILE]?.mutants ?? []), ...(survived.files[FILE]?.mutants ?? [])],
				},
			},
		};
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, both) });
		expect(outcome.mutantCount).toBe(2);
		expect(outcome.survivorCount).toBe(1);
	});

	it("N1: a not_measurable response never carries a rawReport for the caller to (mis)record", async () => {
		const body = { not_measurable: { reason: "no_tests" } };
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, body) });
		expect(outcome.status).toBe("not_measurable");
		expect(outcome.reason).toBe("no_tests");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("N2: an unreachable endpoint exhausted to the deadline reports 'busy' (never got a definitive answer), with no rawReport", async () => {
		// Virtual clock again (see requestWholeFileReport's N2): `now` MUST advance
		// or the deadline condition never trips and the retry loop spins forever —
		// a constant `now` with a no-op `sleep` is not a fast test, it is a hang.
		//
		// "unreachable" and "503-busy" share one retry bucket (tryEndpoint treats
		// both as "keep trying"), so exhausting the deadline this way is the SAME
		// "nobody ever answered" outcome as sustained 503s — status "busy", not
		// the generic "error" a truly broken runner (a definitive non-503 HTTP
		// response) earns. This test used to assert "error" here; that was the
		// exact conflation this fix corrects, not a behavior this test should
		// keep pinning.
		let clock = 0;
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			deadlineMs: 500,
			requestTimeoutMs: 100,
			fetchImpl: async () => {
				throw new Error("down");
			},
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.status).toBe("busy");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("P3: a sustained-busy runner classifies as 'busy' — a DIFFERENT status than 'error', and NEVER 'no_tests'", async () => {
		// This is the exact defect under test: a runner that only ever answered
		// 503 must not be misreported as "this file has no tests" (not_measurable)
		// nor folded into the generic "error" bucket a truly broken runner earns.
		let clock = 0;
		const outcome = await measureFile({
			...args,
			endpoints: ["http://busy/"],
			deadlineMs: 500,
			requestTimeoutMs: 100,
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.status).toBe("busy");
		expect(outcome.status).not.toBe("error");
		expect(outcome.status).not.toBe("not_measurable");
		expect(outcome.reason).not.toContain("no_tests");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("N3: a genuine HTTP 500 still classifies as 'error', not 'busy' — a broken runner is not a contended one", async () => {
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(500, {}),
		});
		expect(outcome.status).toBe("error");
	});

	it("P4: forwards `testScope` through to the wire request", async () => {
		let capturedBody = "";
		await measureFile({
			...args,
			endpoints: ["http://runner/"],
			testScope: ["src/a.test.ts"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(JSON.parse(capturedBody).testScope).toEqual(["src/a.test.ts"]);
	});

	it("P5: a not_measurable response WITH a detail folds it into the reason as `<reason>: <detail>`", async () => {
		const body = { not_measurable: { reason: "no_tests", detail: "no companion test on disk" } };
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("not_measurable");
		expect(outcome.reason).toBe("no_tests: no companion test on disk");
	});

	it("P6: forwards an explicit token and creates a stable default job id when omitted", async () => {
		let captured: { job_id: string; authorization: string | undefined } | undefined;
		const fetchImpl = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
			const body = JSON.parse(init.body) as { job_id: string };
			captured = { job_id: body.job_id, authorization: init.headers.authorization };
			return fakeResponse(200, { files: {} });
		};
		const clock = vi.spyOn(Date, "now").mockReturnValue(123456);
		try {
			await measureFile({
				...args,
				endpoints: ["http://runner/"],
				token: "measure-token",
				fetchImpl,
			});
			expect(captured).toEqual({ job_id: "measure-src-a-ts-2n9c", authorization: "Bearer measure-token" });
		} finally {
			clock.mockRestore();
		}
	});

	it("N4: a body with no `files` key is partial rather than throwing or claiming a measurement", async () => {
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { unrelated: true }),
		});
		expect(outcome.status).toBe("partial");
		expect(outcome).toMatchObject({ mutantCount: 0, survivorCount: 0, survivors: [] });
	});

	it("N5: tolerates malformed per-file / per-mutant shapes — skips what it can't read, defaults the rest", async () => {
		const body = {
			...completeRunEvidence(),
			files: {
				"not-a-record": "just a string, not an object",
				"missing-mutants-array": { source: "x", mutants: "not an array" },
				[FILE]: {
					source: CONTENT,
					mutants: [
						"not a record — skipped entirely",
						{
							// No `location` at all, and every scalar field is the WRONG type —
							// every `typeof === "string"` / `isRecord` fallback should fire.
							mutatorName: 123,
							replacement: 456,
							status: 789,
						},
						{
							mutatorName: "EqualityOperator",
							replacement: ">=",
							status: "Survived",
							location: { start: { line: 2, column: 11 }, end: { line: 2, column: 12 } },
						},
					],
				},
			},
		};
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("partial");
		expect(outcome.reason).toContain("report row(s)");
		expect(outcome.mutantCount).toBe(1);
		expect(outcome.survivorCount).toBe(1);
		expect(outcome.survivors).toEqual([{ line: 2, mutator: "EqualityOperator", replacement: ">=" }]);
	});

	it("N6: malformed survivor fields count as parse loss rather than plausible default mutants", async () => {
		const body = {
			...completeRunEvidence(),
			files: {
				[FILE]: {
					source: CONTENT,
					mutants: [
						{ mutatorName: 123, replacement: 456, status: "Survived", location: { start: { line: "2" } } },
						{ mutatorName: "EqualityOperator", replacement: ">=", status: "Survived", location: { start: { line: 2 } } },
					],
				},
			},
		};
		const outcome = await measureFile({
			file: FILE,
			content: CONTENT,
			overlays: [{ path: FILE, content: CONTENT }],
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("partial");
		expect(outcome.reason).toContain("incomplete census");
		expect(outcome.survivors).toEqual([]);
	});

	it("N7: treats a malformed files value as an empty report instead of iterating it", async () => {
		const outcome = await measureFile({
			file: FILE,
			content: CONTENT,
			overlays: [{ path: FILE, content: CONTENT }],
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { files: null }),
		});
		expect(outcome).toMatchObject({ status: "partial", mutantCount: 0, survivorCount: 0, survivors: [] });
	});

	it("N8: a custom `now` is genuinely forwarded and used to compute the retry deadline — not silently dropped", async () => {
		// test-contract: invariant — `now` is how a caller substitutes a virtual
		// clock for testability; if the value stopped propagating, every caller
		// depending on it (including this file's own tests) would silently fall
		// back to real wall-clock time.
		const nowSpy = vi.fn(() => 1_000_000);
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			now: nowSpy,
			fetchImpl: async () => fakeResponse(200, { files: {} }),
		});
		expect(outcome.status).toBe("partial");
		expect(nowSpy).toHaveBeenCalled();
	});

	it("N9: `survivors` is exactly empty (never a placeholder entry) on both the not_measurable and the error/busy paths", async () => {
		// test-contract: invariant — a caller trusts an empty `survivors` array
		// to mean zero survivors; a stray placeholder entry would be silently
		// counted as a real mutant by anything summing this outcome.
		const notMeasurable = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { not_measurable: { reason: "no_tests" } }),
		});
		expect(notMeasurable.survivors).toEqual([]);
		expect(notMeasurable.mutantCount).toBe(0);
		expect(notMeasurable.survivorCount).toBe(0);

		const errored = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(500, {}),
		});
		expect(errored.survivors).toEqual([]);
		expect(errored.mutantCount).toBe(0);
		expect(errored.survivorCount).toBe(0);
	});

	it("N10: a non-array/non-object `mutants` value on an unrelated file is skipped, never iterated", async () => {
		// test-contract: bug — `Array.isArray`/`isJsonObject` guard a for-of
		// below; skipping the guard on a non-iterable `mutants` value (a bare
		// number, here) would throw a TypeError instead of tolerating the
		// malformed entry, turning one bad file in a report into a rejected
		// promise for the whole measurement.
		const body = {
			...completeRunEvidence(),
			files: {
				"bad-shape.ts": { source: "x", mutants: 42 },
				[FILE]: {
					source: CONTENT,
					mutants: [
						{
							mutatorName: "EqualityOperator",
							replacement: ">=",
							status: "Survived",
							location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
						},
					],
				},
			},
		};
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("measured");
		expect(outcome.mutantCount).toBe(1);
	});

	it("N11: missing engine evidence is partial and never exposes a recordable raw report", async () => {
		const { engine: _engine, ...body } = report("Killed");
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("partial");
		expect(outcome.reason).toContain("no engine-exit evidence");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("N12: non-zero and malformed engine evidence cannot certify a report", async () => {
		const failed = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { ...report("Killed"), engine: { exitCode: 2 } }),
		});
		const malformed = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { ...report("Killed"), engine: { exitCode: "0" } }),
		});
		expect(failed).toMatchObject({ status: "partial" });
		expect(failed.reason).toContain("engine exited 2");
		expect(malformed).toMatchObject({ status: "partial" });
		expect(malformed.reason).toContain("exit unrecoverable");
	});

	it("N13: absent, inventory-only, red, and zero-executed test evidence all remain partial", async () => {
		const { testRun: _testRun, ...withoutTestRun } = report("Killed");
		const absent = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, withoutTestRun),
		});
		const red = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () =>
				fakeResponse(200, { ...report("Killed"), testRun: { overlayGreen: false, redWitnessSatisfied: null } }),
		});
		const inventoryOnly = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () =>
				fakeResponse(200, {
					...report("Killed"),
					testRun: { overlayGreen: true, redWitnessSatisfied: null },
				}),
		});
		const zero = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () =>
				fakeResponse(200, {
					...report("Killed"),
					testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 0 },
				}),
		});
		expect(absent.reason).toContain("no test-run evidence");
		expect(inventoryOnly.reason).toContain("no executed-test count");
		expect(red.reason).toContain("RED overlay suite");
		expect(zero.reason).toContain("zero tests executed");
		expect([absent.status, inventoryOnly.status, red.status, zero.status]).toEqual([
			"partial",
			"partial",
			"partial",
			"partial",
		]);
	});

	it("N14: a foreign target or stale source is partial even when every other evidence field is valid", async () => {
		const foreign = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, report("Killed", "src/other.ts")),
		});
		const stale = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, report("Killed", FILE, CONTENT.replace("> 0", "> 1"))),
		});
		expect(foreign.reason).toContain("no entry for src/a.ts");
		expect(stale.reason).toContain("different source");
		expect([foreign.status, stale.status]).toEqual(["partial", "partial"]);
	});

	it("N15: a timeout/indeterminate mutant is partial, naming how many", async () => {
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, report("Timeout")),
		});
		expect(outcome.status).toBe("partial");
		expect(outcome.reason).toContain("1 mutant(s) returned timeout/indeterminate");
	});
});

describe("recordMeasurement — the only write path, and it goes through seedFileBaseline", () => {
	function must(m: MutationManifest | null | undefined): MutationManifest {
		if (m === null || m === undefined) throw new Error("expected a manifest");
		return m;
	}

	it("P1: records a survivor and reports a real before/after delta, not a hardcoded one", () => {
		const base = emptyManifest(META);
		const first = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t1" });
		expect(first.recorded).toBe(true);
		expect(first.before).toEqual({ mutants: 0, survivors: 0 });
		expect(first.after).toEqual({ mutants: 1, survivors: 1 });

		// Re-measure with the SAME mutant now killed — before must reflect the
		// PRIOR (survived) state, after the NEW (killed) state. If the before/after
		// computation were stubbed to constants this would fail.
		const second = recordMeasurement({
			base: must(first.manifest),
			file: FILE,
			content: CONTENT,
			rawReport: report("Killed"),
			at: "t2",
		});
		expect(second.before).toEqual({ mutants: 1, survivors: 1 });
		expect(second.after).toEqual({ mutants: 1, survivors: 0 });
	});

	it("N1: refuses a test-file target — never trusts the report enough to write", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: "src/a.test.ts",
			content: CONTENT,
			rawReport: report("Survived", "src/a.test.ts"),
			at: "t",
		});
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("test files are not mutation targets");
		expect(result.manifest).toBeUndefined();
	});

	it("N2: refuses (and explains) an unrecognizable report rather than writing an empty baseline", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: { nonsense: true }, at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("not a recognizable mutation report");
	});

	it("N3: refuses a report naming zero mutants for this file", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: FILE,
			content: CONTENT,
			rawReport: {
				...completeRunEvidence(),
				files: { [FILE]: { source: CONTENT, mutants: [] } },
			},
			at: "t",
		});
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("zero mutants");
	});

	it("N4: refuses (and explains) when the TypeScript identity API is unavailable", () => {
		identityAvailableOverride = false;
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("TypeScript API is unavailable");
		expect(result.manifest).toBeUndefined();
	});

	it("N4b: refuses the SAME way when derivation independently returns null even though the API reports available (a second, distinct guard from N4)", () => {
		// `mutationIdentityAvailable()` stays real/true here — only
		// `deriveIdentities` is forced null (`computeSymbolHashes` still runs for
		// real, since it keys off `identityAvailableOverride`, not this flag),
		// reaching `recordEvidenceRefusal`'s second, independent identity check
		// (after a target was already found) rather than N4's earlier
		// availability gate.
		forceIdentitiesNull = true;
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("TypeScript API is unavailable");
		expect(result.manifest).toBeUndefined();
	});

	it("N4c: throws when identity derivation returns fewer rows than the validated mutant census", () => {
		// A real 1:1 `deriveIdentities` zip can never produce this; the guard
		// exists for a corrupted/short zip. Truncating a real (non-null) array
		// by one row reaches it without breaking the "identities === null" gate.
		truncateIdentities = true;
		const base = emptyManifest(META);
		expect(() =>
			recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t" }),
		).toThrow("identity derivation returned fewer rows than the validated mutant census");
	});

	it("N4d: reports a consistency-bug reason when seedFileBaseline rejects evidence that already passed measure.ts's own admission checks", () => {
		forceSeedFileBaselineNull = true;
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toBe(
			"seedFileBaseline rejected evidence that passed record admission — this indicates a consistency bug, not a safe write",
		);
	});

	function attemptRecord(rawReport: unknown): ReturnType<typeof recordMeasurement> {
		return recordMeasurement({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			rawReport,
			at: "t",
		});
	}

	it("N5: missing engine evidence cannot cross the direct record boundary", () => {
		const { engine: _engine, ...body } = report("Killed");
		const result = attemptRecord(body);
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("no engine-exit evidence");
		expect(result.manifest).toBeUndefined();
	});

	it("N6: non-zero and malformed engine exits cannot cross the direct record boundary", () => {
		const nonzero = attemptRecord({ ...report("Killed"), engine: { exitCode: 2 } });
		const malformed = attemptRecord({ ...report("Killed"), engine: { exitCode: "0" } });
		expect(nonzero.recorded).toBe(false);
		expect(nonzero.reason).toContain("engine exited 2");
		expect(nonzero.manifest).toBeUndefined();
		expect(malformed.recorded).toBe(false);
		expect(malformed.reason).toContain("exit unrecoverable");
		expect(malformed.manifest).toBeUndefined();
	});

	it("N7: absent, inventory-only, red, and zero-executed test evidence cannot cross the direct record boundary", () => {
		const { testRun: _testRun, ...withoutTestRun } = report("Killed");
		const absent = attemptRecord(withoutTestRun);
		const red = attemptRecord({
			...report("Killed"),
			testRun: { overlayGreen: false, redWitnessSatisfied: null },
		});
		const inventoryOnly = attemptRecord({
			...report("Killed"),
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
		});
		const zero = attemptRecord({
			...report("Killed"),
			testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 0 },
		});
		expect(absent.recorded).toBe(false);
		expect(absent.reason).toContain("no test-run evidence");
		expect(inventoryOnly.recorded).toBe(false);
		expect(inventoryOnly.reason).toContain("no executed-test count");
		expect(inventoryOnly.manifest).toBeUndefined();
		expect(red.recorded).toBe(false);
		expect(red.reason).toContain("RED overlay suite");
		expect(zero.recorded).toBe(false);
		expect(zero.reason).toContain("zero tests executed");
		expect([absent.manifest, inventoryOnly.manifest, red.manifest, zero.manifest]).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("N8: a dropped mutant row cannot cross the direct record boundary", () => {
		const body = report("Killed");
		const entry = body.files[FILE];
		if (entry === undefined) throw new Error("report helper lost its target entry");
		const result = attemptRecord({
			...body,
			files: {
				[FILE]: { ...entry, mutants: [...entry.mutants, { status: "Survived" }] },
			},
		});
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("incomplete census");
		expect(result.manifest).toBeUndefined();
	});

	it("N9: foreign-target and stale-source reports cannot cross the direct record boundary", () => {
		const foreign = attemptRecord(report("Killed", "src/other.ts"));
		const stale = attemptRecord(report("Killed", FILE, CONTENT.replace("> 0", "> 1")));
		expect(foreign.recorded).toBe(false);
		expect(foreign.reason).toContain("no entry for src/a.ts");
		expect(stale.recorded).toBe(false);
		expect(stale.reason).toContain("different source");
		expect([foreign.manifest, stale.manifest]).toEqual([undefined, undefined]);
	});

	it("keys an absolute-path measurement under the SAME repo-relative key a relative one would use", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: "/repo/root/src/a.ts",
			content: CONTENT,
			rawReport: report("Survived"),
			at: "t",
			cwd: "/repo/root",
		});
		expect(result.recorded).toBe(true);
		expect(Object.keys(must(result.manifest).files)).toEqual([FILE]);
	});

	it("counts equivalent mutants as survivors in the before summary", () => {
		const base = emptyManifest(META);
		base.files[FILE] = {
			symbol: {
				symbolId: "symbol",
				qualifiedName: "f",
				symbolHash: "hash",
				mutants: {
					mutant: {
						mutantId: "mutant",
						siteId: "site",
						mutator: "EqualityOperator",
						originalLexeme: ">",
						replacement: ">=",
						ordinalWithinSymbol: 0,
						status: "equivalent",
						firstSeen: "t0",
					},
				},
				instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
			},
		};
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: { nonsense: true }, at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.before).toEqual({ mutants: 1, survivors: 1 });
	});

	it("explains zero mutants for the requested file even when another report file has mutants", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: FILE,
			content: CONTENT,
			rawReport: {
				...completeRunEvidence(),
				files: {
					"src/other.ts": {
						source: CONTENT,
						mutants: [{ mutatorName: "EqualityOperator", replacement: ">=", status: "Survived", location: { start: { line: 2, column: 10 }, end: { line: 2, column: 11 } } }],
					},
					[FILE]: { source: CONTENT, mutants: [] },
				},
			},
			at: "t",
		});
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("zero mutants");
	});

	it("refuses via the SAME zero-mutants reason as a direct match, even when the target is found behind an earlier non-empty file", () => {
		// test-contract: invariant — the diagnostic's own `adapted.find(...) ??
		// adapted[0]` re-derivation must find the SAME entry `seedFileBaseline`
		// found (matching this file's key), not silently fall back to
		// `adapted[0]` (a DIFFERENT file) and explain the wrong thing.
		const base = emptyManifest(META);
		const rawReport = {
			...completeRunEvidence(),
			files: {
				"other.ts": {
					source: "export const z = 1;\n",
					mutants: [
						{
							mutatorName: "EqualityOperator",
							replacement: ">=",
							status: "Survived",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
						},
					],
				},
				[FILE]: { source: CONTENT, mutants: [] },
			},
		};
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport, at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toBe("the runner reported zero mutants for this file — nothing to record");
	});

	it("threads BOTH `cwd` and `provenance` to the SAME normalized key the before/after summary reads back", () => {
		// test-contract: invariant — before/after/fileProvenance are all keyed
		// by normalizeManifestKey(file, cwd); if cwd failed to reach either the
		// seeding call or the provenance stamp, the write would land under a
		// different key than the one this function reads back from, making a
		// real write look like it recorded nothing.
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: "/repo/root/src/a.ts",
			content: CONTENT,
			rawReport: report("Survived"),
			at: "t1",
			cwd: "/repo/root",
			provenance: { scope: "unknown", testCount: 6, surface: "measure" },
		});
		expect(result.recorded).toBe(true);
		expect(result.after).toEqual({ mutants: 1, survivors: 1 });
		expect(must(result.manifest).fileProvenance).toEqual({
			[FILE]: { scope: "unknown", testCount: 6, surface: "measure", at: "t1" },
		});
	});

	it("N10: refuses a truncated census that drops a prior mutant from an unchanged symbol", () => {
		const base = emptyManifest(META);
		const first = recordMeasurement({
			base,
			file: FILE,
			content: CONTENT,
			rawReport: reportWithReplacement("Killed", ">="),
			at: "t1",
		});
		const second = recordMeasurement({
			base: must(first.manifest),
			file: FILE,
			content: CONTENT,
			rawReport: reportWithReplacement("Killed", "<"),
			at: "t2",
		});
		expect(second.recorded).toBe(false);
		expect(second.reason).toContain("incomplete unchanged-symbol census");
		expect(second.manifest).toBeUndefined();
	});
});


// ===========================================
// The sweep's own error path. `cloud-runner.ts` (the per-edit gate's client)
// had the same defect and was fixed first; a live 719-file sweep then reported
// a bare `runner HTTP 500` from THIS copy, which is why both now share
// `describeErrorResponse`.
// ===========================================
describe("requestWholeFileReport — a failing runner is quoted, not summarized", () => {
	function failing(status: number, body: string | null) {
		return () =>
			Promise.resolve({
				ok: false,
				status,
				json: () => Promise.resolve(null),
				...(body === null ? {} : { text: () => Promise.resolve(body) }),
			});
	}

	const base = {
		file: "src/a.ts",
		content: "export const x = 1;\n",
		overlays: [],
		endpoints: ["http://runner.invalid"],
		jobId: "job-1",
		deadlineMs: 5_000,
		requestTimeoutMs: 1_000,
	};

	/** Narrow the union so a passing run cannot silently skip the assertion. */
	async function failureOf(status: number, body: string | null) {
		const out = await requestWholeFileReport({ ...base, fetchImpl: failing(status, body) });
		if (out.ok) throw new Error("expected the request to fail");
		return out;
	}

	it("P1: carries a JSON error body into the reason", async () => {
		const out = await failureOf(500, JSON.stringify({ error: "worktree checkout failed" }));
		expect(out.reason).toContain("worktree checkout failed");
	});

	it("P2: carries a plain-text body too", async () => {
		const out = await failureOf(502, "bad gateway from proxy");
		expect(out.reason).toContain("bad gateway from proxy");
	});

	it("N1: degrades to the bare status when no body can be read", async () => {
		const out = await failureOf(500, null);
		expect(out.reason).toBe("mutation runner HTTP 500");
	});

	it("N2: a non-ok status is a definitive failure, never reported as busy", async () => {
		const out = await failureOf(500, "boom");
		expect(out.busy).toBeUndefined();
	});
});


// ===========================================
// Disconnection. A contended runner frees up; a closed laptop does not, and
// treating them the same burned a full per-file budget (900s in the live sweep)
// on every remaining file.
// ===========================================
describe("requestWholeFileReport — an unreachable host is not a busy one", () => {
	const base = {
		file: "src/a.ts",
		content: "export const x = 1;\n",
		overlays: [],
		jobId: "job-1",
		requestTimeoutMs: 50,
	};

	it("P1: gives up well before the deadline when nothing answers at all", async () => {
		let slept = 0;
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead-1", "http://dead-2"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async (ms: number) => {
				slept += ms;
			},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.reason).toContain("runner_unreachable");
		// It must NOT have waited out the 900s deadline.
		expect(slept).toBeLessThan(60_000);
	});

	it("P2: names the endpoints it could not reach, so the operator knows which host to check", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://mbp:8790"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.reason).toContain("http://mbp:8790");
	});

	it("P3: still refuses to read as a no-tests verdict — busy stays set", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.busy).toBe(true);
		expect(out.reason).toContain("NOT evidence this file lacks tests");
	});

	it("N1: one reachable-but-busy endpoint keeps the run alive to the deadline", async () => {
		let clock = 0;
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead", "http://busy"],
			deadlineMs: 30_000,
			fetchImpl: (url: string) =>
				url.includes("busy")
					? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) })
					: Promise.reject(new Error("ECONNREFUSED")),
			now: () => clock,
			sleep: async (ms: number) => {
				clock += ms;
			},
		});
		if (out.ok) throw new Error("expected failure");
		// Reached someone every round, so the early-exit must NOT have fired.
		expect(out.reason).toContain("runner_busy");
	});

	it("N2: a healthy fallback answers even when the preferred endpoint is dead", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead", "http://alive"],
			deadlineMs: 30_000,
			fetchImpl: (url: string) =>
				url.includes("alive")
					? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ files: {} }) })
					: Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		expect(out.ok).toBe(true);
	});
});
