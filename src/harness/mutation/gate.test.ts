import { describe, expect, it } from "vitest";
import { MutationNotMeasurableError } from "./cloud-runner.js";
import {
	type FileOverlay,
	type MutationGateContext,
	type MutationRunOptions,
	type MutationRunner,
	type PendingHandle,
	type PerEditMutationConfig,
	multiSourceNotMeasuredReason,
	mutationTargetFor,
	primaryCodeFile,
	runPerEditMutationGate,
} from "./gate.js";
import { emptyManifest } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutationManifest, MutationReceipt, TestRunResult } from "./types.js";

const FILE = "src/x.ts";
const CONTENT = "function bar(x: number): boolean { return x > 0; }\n";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

function cfg(over: Partial<PerEditMutationConfig> = {}): PerEditMutationConfig {
	return { enabled: true, mode: "block", unavailable_behavior: "allow_unmeasured", ...over };
}

function survivor(status: AdaptedMutant["status"] = "survived"): AdaptedMutant {
	return {
		raw: { file: FILE, mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: CONTENT.indexOf("> 0") },
		status,
	};
}

/** A well-formed run: the suite ran and passed. */
const GREEN_RUN: TestRunResult = { overlayGreen: true, redWitnessSatisfied: null };

/**
 * A stand-in runner. The default now carries GREEN test-run evidence, because
 * goal 28 §8 makes that evidence a precondition for certifying clean — before
 * the change, a runner that returned mutants and NO test run was allowed to
 * produce a measured-clean allow, which is the false clean the contract closes.
 *
 * Pass `testRun: null` to model a runner that reports no test run at all; that
 * cannot be expressed by passing `undefined`, since a default parameter fires
 * on an explicit `undefined`.
 *
 * The default likewise carries `engineExitCode: 0` (strict, 2026-08-28): a
 * proven engine finish is a precondition for clean. Pass `engineExit: null`
 * (the sentinel, not the value) to model a runner that omits the field.
 */
function fakeRunner(
	mutants: AdaptedMutant[],
	opts: {
		avail?: boolean;
		testRun?: TestRunResult | null;
		engineExit?: { exitCode: number | null } | null;
		executedTestCount?: number | null;
	} = {},
): MutationRunner {
	const { avail = true, testRun = GREEN_RUN, engineExit = { exitCode: 0 }, executedTestCount = 1 } = opts;
	const engine = engineExit === null ? {} : { engineExitCode: engineExit.exitCode };
	return {
		available: () => avail,
		run: () =>
			Promise.resolve(
				testRun === null
					? { mutants, executedTestCount, ...engine }
					: { mutants, testRun, executedTestCount, ...engine },
			),
	};
}

/**
 * A manifest that already knows this file, so the ratchet applies.
 *
 * `emptyManifest` is a FIRST SIGHTING: with no prior state the gate establishes
 * a baseline rather than verdicting, because "changed region" would otherwise
 * mean the whole file and every pre-existing survivor would look new. These
 * tests exercise the ratchet, so they need a prior. The record's hash is
 * deliberately not CONTENT's — the symbol must read as CHANGED.
 */
function withPriorBaseline(): MutationManifest {
	return {
		...emptyManifest(META),
		files: {
			[FILE]: {
				"sym-prior": {
					symbolId: "sym-prior",
					qualifiedName: "bar",
					symbolHash: "hash-that-does-not-match-current-content",
					mutants: {},
					instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
				},
			},
		},
	};
}

function ctx(over: Partial<MutationGateContext> = {}): MutationGateContext {
	return {
		toolName: "Write",
		toolInput: { file_path: FILE, content: CONTENT },
		config: cfg(),
		runner: fakeRunner([survivor()]),
		baseManifest: withPriorBaseline(),
		readDisk: () => CONTENT,
		at: "t",
		...over,
	};
}

describe("runPerEditMutationGate", () => {
	it("no-ops when disabled", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ enabled: false }) }))).toBeNull();
	});

	it("no-ops when mode is off", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ mode: "off" }) }))).toBeNull();
	});

	it("no-ops for a non-mutating tool", async () => {
		expect(await runPerEditMutationGate(ctx({ toolName: "Read" }))).toBeNull();
	});

	it("no-ops when no code file is touched", async () => {
		expect(await runPerEditMutationGate(ctx({ toolInput: { file_path: "README.md", content: "x" } }))).toBeNull();
	});

	it("returns a not-measured allow when no runner is configured", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("[mutation:not-measured]");
	});

	it("returns not-measured when the runner reports unavailable", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([], { avail: false }) }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("fails closed when unavailable_behavior is block", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null, config: cfg({ unavailable_behavior: "block" }) }));
		expect(d?.decision).toBe("block");
	});

	// MUT-AC-26: today's normalizers (Write/Edit/MultiEdit) are SINGLE-FILE,
	// so the multi-source refusal cannot be reached through a real tool_input
	// yet — it is the guard that keeps a future multi-file adapter
	// (apply_patch etc.) from silently under-measuring on day one. Pinned at
	// the exported helper the gate calls first.
	it("P: two eligible source files ⇒ a not-measured reason naming the count (MUT-AC-26)", () => {
		const reason = multiSourceNotMeasuredReason(["src/a.ts", "src/b.ts"]);
		expect(reason).toContain("2 eligible source files");
		expect(reason).toContain("MUT-AC-26");
	});

	it("N: one source + its companion TEST is single-target — no refusal", () => {
		expect(multiSourceNotMeasuredReason(["src/a.ts", "src/a.test.ts"])).toBeNull();
	});

	it("N: one source alone, or tests/scratch only, never refuses", () => {
		expect(multiSourceNotMeasuredReason(["src/a.ts"])).toBeNull();
		expect(multiSourceNotMeasuredReason(["src/a.test.ts", "scratch/probe.ts"])).toBeNull();
	});

	it("P: a red suite with ZERO mutants — the Worker's real red-suite shape — still BLOCKS end to end (review 2026-08-25 pass 7)", async () => {
		const d = await runPerEditMutationGate(
			ctx({ runner: fakeRunner([], { testRun: { overlayGreen: false, redWitnessSatisfied: null } }) }),
		);
		expect(d?.decision).toBe("block");
	});

	it("P: COMPOSED path — Worker-shaped HTTP body → createCloudMutationRunner → gate → block, zero persist calls (review 2026-08-25 pass 8)", async () => {
		// The pass-7 pins proved each layer separately; this one test protects
		// the cross-layer contract that actually failed: the raw wire shape of a
		// red overlay suite must come out of the gate as a block, never as
		// not-measured, and must never touch persistence.
		const { createCloudMutationRunner } = await import("./cloud-runner.js");
		const runner = createCloudMutationRunner({ url: "https://worker", timeoutMs: 1000 }, () =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({ files: {}, testRun: { overlayGreen: false, redWitnessSatisfied: null } }),
			}),
		);
		const persisted: unknown[] = [];
		const d = await runPerEditMutationGate(ctx({ runner, persist: (m) => void persisted.push(m) }));
		// Assert the EXACT cause (review 2026-08-25 pass 9): a block for any other
		// reason would still be a regression of this contract.
		expect(d).toMatchObject({ decision: "block", rule_id: "per-edit-mutation", category: "mutation" });
		expect(d?.reason).toContain("affected tests are RED");
		expect(persisted).toHaveLength(0);
	});

	it("P: a RUNNER EXCEPTION also fails closed under unavailable_behavior=block (review 2026-08-24 item 4)", async () => {
		// Before the choke point, only a NULL runner honored block; exceptions,
		// timeouts, and missing shards all fell through to allow-unmeasured.
		const throwing: MutationRunner = { available: () => true, run: () => Promise.reject(new Error("boom")) };
		const d = await runPerEditMutationGate(
			ctx({ runner: throwing, config: cfg({ unavailable_behavior: "block" }) }),
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("boom");
	});

	it("blocks a measured new survivor", async () => {
		const d = await runPerEditMutationGate(ctx());
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("surviving mutant");
	});

	it("downgrades a block to a warning when mode is warn", async () => {
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.length).toBeGreaterThan(0);
	});

	it("allows a measured clean run (killed)", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toBeUndefined();
	});

	it("blocks a red overlay suite through the gate, even with a killed mutant (spec §7)", async () => {
		const runner = fakeRunner([survivor("killed")], { testRun: { overlayGreen: false, redWitnessSatisfied: null } });
		const d = await runPerEditMutationGate(ctx({ runner }));
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("RED on this edit");
	});

	// This case previously asserted the gate NO-OPS for a file with no disk
	// content — i.e. it pinned the defect. A brand-new source file is the
	// highest-risk edit in the tree (no prior tests, no baseline), and it was
	// the one edit that skipped the gate silently, leaving nothing to audit.
	// "Not measured" is the honest answer: visible, and blockable under a
	// fail-closed unavailable_behavior.
	it("P: a NEW file (no disk baseline) returns an explicit not-measured, never silence", async () => {
		const d = await runPerEditMutationGate(ctx({ readDisk: () => null }));
		expect(d).not.toBeNull();
		expect(d?.warnings?.[0]).toContain("not-measured");
		expect(d?.warnings?.[0]).toContain("no on-disk baseline");
	});

	it("P: the not-measured reason names the file so the user can act on it", async () => {
		const d = await runPerEditMutationGate(ctx({ readDisk: () => null }));
		expect(d?.warnings?.[0]).toContain(FILE);
	});

	// A STALE Edit: the file exists on disk (so the new-file arm above does not
	// fire) but its old_string is gone, so applying the patch throws and the
	// overlay cannot be reconstructed. Silence here would report the same
	// nothing as "not eligible", so the gate says not-measured and names why.
	it("P: a stale Edit whose old_string is absent from disk returns an unreconstructable-overlay not-measured", async () => {
		const d = await runPerEditMutationGate(
			ctx({
				toolName: "Edit",
				toolInput: { file_path: FILE, old_string: "no such text on disk", new_string: "y" },
			}),
		);
		expect(d?.warnings?.[0]).toBe(
			`[mutation:not-measured] could not reconstruct the proposed content for ${FILE}`,
		);
	});

	it("returns not-measured when the runner throws", async () => {
		const throwing: MutationRunner = { available: () => true, run: () => Promise.reject(new Error("boom")) };
		const d = await runPerEditMutationGate(ctx({ runner: throwing }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("ships the full overlay set: primary first, companion test read from disk (spec §7)", async () => {
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		// ctx's readDisk returns content for every path — so the companion test
		// "exists" on local disk and must travel with the edit.
		await runPerEditMutationGate(ctx({ runner: capturing }));
		expect(captured?.map((o) => o.path)).toEqual([FILE, "src/x.test.ts"]);
		expect(captured?.[0]?.content).toBe(CONTENT);
	});
});

describe("runPerEditMutationGate — manifest/receipt persistence (spec §4/§12)", () => {
	function persistSpy(): { calls: Array<{ generation: number; overlayHash: string }>; persist: (m: MutationManifest, r: MutationReceipt) => void } {
		const calls: Array<{ generation: number; overlayHash: string }> = [];
		return { calls, persist: (m, r) => calls.push({ generation: m.generation, overlayHash: r.overlayHash }) };
	}

	it("persists the refreshed manifest + receipt on a measured-clean allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.generation).toBe(1); // bumped from the empty manifest's 0
		expect(spy.calls[0]?.overlayHash).toHaveLength(64); // receipt bound to the overlay
	});

	// test-contract: invariant — the "never forge clean" guarantee: a partial shard
	// set (incompleteShards > 0) must land as not-measured and NEVER refresh the
	// manifest, however clean the reporting shards look (review finding 1).
	it("N: an INCOMPLETE sharded result is not-measured and does NOT persist", async () => {
		const spy = persistSpy();
		const partial: MutationRunner = {
			available: () => true,
			run: () => Promise.resolve({ mutants: [survivor("killed")], incompleteShards: 1 }),
		};
		const d = await runPerEditMutationGate(ctx({ runner: partial, persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("not-measured");
		expect(d?.warnings?.[0]).toContain("did not report");
		expect(spy.calls).toHaveLength(0);
	});

	it("does NOT persist on a survivor block", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ persist: spy.persist }));
		expect(d?.decision).toBe("block");
		expect(spy.calls).toHaveLength(0);
	});

	it("does NOT persist when warn-mode downgrades a dirty run to allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }), persist: spy.persist }));
		expect(d?.decision).toBe("allow"); // downgraded on the wire…
		expect(spy.calls).toHaveLength(0); // …but the OUTCOME was dirty → no refresh
	});

	it("does NOT persist on a not-measured allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: null, persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(0);
	});

	it("surfaces a persistence failure as a warning — the allow stands", async () => {
		const persist = () => {
			throw new Error("disk full");
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.some((w) => w.includes("persistence failed") && w.includes("disk full"))).toBe(true);
	});
});

describe("primaryCodeFile — choosing what is worth mutating", () => {
	it("picks a plain code file", () => {
		expect(primaryCodeFile(["src/a.ts"])).toBe("src/a.ts");
	});

	it("skips a test file — mutating tests measures nothing", () => {
		// Live failure this prevents: a run targeting harvest.test.ts derived the
		// scope harvest.test.test.ts, matched no tests, and reported an opaque
		// "the mutation runner failed".
		expect(primaryCodeFile(["src/a.test.ts"])).toBeNull();
	});

	it("prefers the code file when a change set holds both", () => {
		expect(primaryCodeFile(["src/a.test.ts", "src/a.ts"])).toBe("src/a.ts");
	});

	it("skips __tests__ directory files too", () => {
		expect(primaryCodeFile(["src/__tests__/a.test.ts"])).toBeNull();
	});

	it("returns null for non-code paths", () => {
		expect(primaryCodeFile(["README.md", "data.json"])).toBeNull();
	});

	it("returns null for an empty change set", () => {
		expect(primaryCodeFile([])).toBeNull();
	});

	it("skips repo scratch probes — they have no companion test by design", () => {
		// Observed live: a run targeting scratch/two-box-runner/runner.mjs could
		// only ever report "no tests were executed".
		expect(primaryCodeFile(["scratch/probe.mjs"])).toBeNull();
		expect(primaryCodeFile(["scratch/two-box-runner/runner.mjs"])).toBeNull();
	});

	it("still picks product code when a scratch file is also in the change set", () => {
		expect(primaryCodeFile(["scratch/probe.mjs", "src/a.ts"])).toBe("src/a.ts");
	});
});

const NM_CONFIG: PerEditMutationConfig = {
	enabled: true,
	mode: "warn",
	unavailable_behavior: "allow_unmeasured",
	budget_ms: 1000,
};

function nmGateCtx(runError: unknown): MutationGateContext {
	return {
		toolName: "Edit",
		toolInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
		config: NM_CONFIG,
		runner: {
			available: () => true,
			run: async () => {
				throw runError;
			},
		},
		baseManifest: emptyManifest({
			engine: "stryker",
			engineVersion: "9",
			dependencyGraphVersion: "1",
			environmentHash: "h",
			authoritativeAt: "2026-07-28T00:00:00Z",
		}),
		readDisk: () => "export const a = 1;\n",
		at: "2026-07-28T00:00:00Z",
	};
}

describe("gate messaging — the reader can act on the difference", () => {
	it("says the file has no test, not that the runner failed", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("no_tests")));
		expect(d?.warnings?.join("\n")).toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("runner failed");
	});

	it("names an unrecognized not-measurable reason instead of hiding it", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("engine_unsupported")));
		expect(d?.warnings?.join("\n")).toContain("engine_unsupported");
	});

	it("still reports a genuine failure as a failure", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("connection refused")));
		expect(d?.warnings?.join("\n")).toContain("runner failed");
	});

	it("P: says the runner is BUSY, not that the file has no tests, when the runner throws the dedicated busy error", async () => {
		// The measurement-integrity property under test: a contended runner must
		// never read as "no test exercises this file" — that would silently drop
		// a perfectly-tested file out of the campaign's denominator every time
		// the fleet is loaded.
		const busyErr = Object.assign(new Error("mutation runner is busy with another job (HTTP 503)"), {
			name: "MutationRunnerBusyError",
		});
		const d = await runPerEditMutationGate(nmGateCtx(busyErr));
		expect(d?.warnings?.join("\n")).toContain("busy");
		expect(d?.warnings?.join("\n")).not.toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("runner failed");
	});

	it("P: also recognizes a generic HTTP 503 error (a runner with no dedicated busy type) as busy, not as a plain failure", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("mutation runner HTTP 503")));
		expect(d?.warnings?.join("\n")).toContain("busy");
		expect(d?.warnings?.join("\n")).not.toContain("no test exercises this file");
	});

	it("N: a non-503 HTTP error stays a plain failure, never mislabeled busy", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("mutation runner HTTP 500")));
		expect(d?.warnings?.join("\n")).toContain("runner failed");
		expect(d?.warnings?.join("\n")).not.toContain("busy");
	});

	it("N: a genuine no_tests verdict is unaffected by the busy check — still terminal, still says no tests", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("no_tests")));
		expect(d?.warnings?.join("\n")).toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("busy");
	});

	it("prefers the still-running message when handles came back", async () => {
		// Budget expiry outranks everything: results are genuinely still coming.
		const pendingErr = Object.assign(new Error("pending"), {
			jobId: "j1",
			runnerUrl: "http://runner/",
		});
		const d = await runPerEditMutationGate(nmGateCtx(pendingErr));
		expect(d?.warnings?.join("\n")).toContain("still running past the budget");
	});

	it("falls back to 'unspecified' when the not-measurable reason is an empty string", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("")));
		expect(d?.warnings?.join("\n")).toContain("mutation not measurable here (unspecified)");
	});

	it("falls back to 'unspecified' when the not-measurable reason is not a string at all", async () => {
		const nonStringReasonErr = Object.assign(new Error("x"), {
			name: "MutationNotMeasurableError",
			reason: 42,
		});
		const d = await runPerEditMutationGate(nmGateCtx(nonStringReasonErr));
		expect(d?.warnings?.join("\n")).toContain("mutation not measurable here (unspecified)");
	});
});

describe("runPerEditMutationGate — local-dependency overlay walk (spec §7)", () => {
	const TARGET = "src/y.ts";
	const COMPANION = "src/y.test.ts";
	const DEP = "src/shared.ts";
	const GONE = "src/gone.ts";

	it("carries a local dep imported by both the target and its companion exactly once, and drops one that vanishes before the second read", async () => {
		const files: Record<string, string> = {
			[TARGET]: 'import "./shared.js";\nimport "./gone.js";\nexport const y = 1;\n',
			[COMPANION]: 'import "./shared.js";\nexport {};\n',
			[DEP]: "export const shared = 1;\n",
			[GONE]: "export const gone = 1;\n",
		};
		const counts: Record<string, number> = {};
		const readDisk = (p: string): string | null => {
			if (!(p in files)) return null;
			counts[p] = (counts[p] ?? 0) + 1;
			// GONE resolves fine the first two times collectLocalDeps reads it
			// (once confirming the specifier, once when dequeued) but has vanished
			// by the time addLocalDeps does its own re-read.
			if (p === GONE && counts[p] > 2) return null;
			return files[p] ?? null;
		};
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: TARGET, content: files[TARGET] as string },
				runner: capturing,
				readDisk,
			}),
		);
		const paths = captured?.map((o) => o.path) ?? [];
		expect(paths.filter((p) => p === DEP)).toEqual([DEP]);
		expect(paths).not.toContain(GONE);
	});
});

describe("runPerEditMutationGate — cwd threading (spec: manifest key normalization)", () => {
	it("accepts an explicit cwd for manifest-key resolution without throwing", async () => {
		const d = await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: "/repo/src/z.ts", content: "export const z = 1;\n" },
				readDisk: () => "export const z = 1;\n",
				runner: fakeRunner([survivor("killed")]),
				baseManifest: emptyManifest(META),
				cwd: "/repo",
			}),
		);
		expect(d?.decision).toBe("allow");
	});
});

describe("persistIfCleanMeasured — non-Error persistence failure (via runPerEditMutationGate)", () => {
	it("stringifies a thrown non-Error value in the persistence-failure warning", async () => {
		const persist = () => {
			// eslint-disable-next-line no-throw-literal
			throw "disk full (string throw)";
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.some((w) => w.includes("persistence failed") && w.includes("disk full (string throw)"))).toBe(
			true,
		);
	});
});

describe("mutationTargetFor — a test edit measures the code it protects", () => {
	/** Pretend every path exists on disk. */
	const anyExists = (): boolean => true;

	it("P1: returns the source file directly when one was edited", () => {
		expect(mutationTargetFor(["src/foo.ts"], anyExists)).toBe("src/foo.ts");
	});

	it("P2: resolves a test-only edit to its companion source", () => {
		expect(mutationTargetFor(["src/foo.test.ts"], anyExists)).toBe("src/foo.ts");
	});

	it("P3: resolves a .spec companion too", () => {
		expect(mutationTargetFor(["src/foo.spec.ts"], anyExists)).toBe("src/foo.ts");
	});

	it("P4: prefers a directly-edited source over a co-edited test", () => {
		// The source is what changed behavior; measuring it is the point.
		expect(mutationTargetFor(["src/foo.test.ts", "src/bar.ts"], anyExists)).toBe("src/bar.ts");
	});

	it("N1: skips a test whose companion source does not exist", () => {
		// An integration suite protecting no single module. Guessing a target
		// would measure something the edit was not about.
		expect(mutationTargetFor(["src/e2e-flow.test.ts"], () => false)).toBeNull();
	});

	it("N2: returns null for a change set with no code in it", () => {
		expect(mutationTargetFor(["README.md", "docs/x.md"], anyExists)).toBeNull();
	});

	it("N3: never resolves a test to itself", () => {
		// The `foo.test.test.ts` failure mode: a bad inverse yields a path that
		// matches no tests and reports an opaque runner failure.
		expect(mutationTargetFor(["src/foo.test.ts"], anyExists)).not.toBe("src/foo.test.ts");
	});

	it("N4: does not treat a non-code test-named file as a target", () => {
		expect(mutationTargetFor(["src/fixtures/foo.test.json"], anyExists)).toBeNull();
	});
});

// ===========================================
// Mutation-kill campaign (pass-1, W6 residue) — exact-observable assertions
// against gate.ts survivors. Each case is grounded via a `test-contract`
// receipt naming the real behavior it pins, never "kills mutant X".
// ===========================================

describe("describeRunnerFailure (via the not-measured warning) — exact message text", () => {
	// test-contract: invariant — a runner rejection with no Error at all (a bare
	// throw of `undefined`) must still resolve to the generic not-measured
	// message, not crash the gate. Exercises every `?.` guard on the raw `err`
	// value across describeRunnerFailure/isRunnerBusy/notMeasurableReasonOf.
	it("resolves the generic message, without throwing, when the rejection carries no value at all", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(undefined));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed"]);
	});

	// test-contract: invariant — a genuine Error's message is appended VERBATIM,
	// not replaced by a generic string, once it is confirmed to be a non-empty
	// string.
	it("appends the real error text verbatim for a normal Error rejection", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("connection refused")));
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed — connection refused"]);
	});

	// test-contract: invariant — a `.message` that is a non-string value (here a
	// number) must still be reported as a generic failure, never fed to
	// `.trim()` (which would throw on a number).
	it("falls back to the generic message when .message is a non-string value", async () => {
		const d = await runPerEditMutationGate(nmGateCtx({ message: 42 }));
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed"]);
	});

	// test-contract: invariant — a whitespace-only message trims to empty and is
	// therefore reported as the generic failure, not as "failed — " with a
	// trailing blank.
	it("treats a whitespace-only message as empty, not as real text", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("   ")));
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed"]);
	});

	// test-contract: invariant — the appended text is the TRIMMED message, so
	// incidental leading/trailing whitespace around the real text never leaks
	// into the reader-facing warning.
	it("trims surrounding whitespace from the appended message text", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("  connection refused  ")));
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed — connection refused"]);
	});
});

describe("isRunnerBusy (via the not-measured warning) — busy vs plain-failure boundary", () => {
	// test-contract: invariant — the busy verdict is keyed on the error's own
	// `name`, not merely on message text that happens to look like an HTTP
	// status. A busy-named error whose message carries NO "HTTP 503" text must
	// still read as busy.
	it("reads as busy from the error name alone, even when the message doesn't mention HTTP 503", async () => {
		const busyErr = Object.assign(new Error("temporarily overloaded"), { name: "MutationRunnerBusyError" });
		const d = await runPerEditMutationGate(nmGateCtx(busyErr));
		expect(d?.warnings).toEqual([
			"[mutation:not-measured] the mutation runner is busy with another job right now — not measured this edit, and NOT evidence this file has no tests (retry on the next edit)",
		]);
	});

	// test-contract: boundary — the message-based busy check short-circuits on a
	// non-string `.message` (never calling the regex against it). A boxed
	// `String` object is `typeof "object"`, so its own `toString()` text
	// (which incidentally matches the busy pattern) must NOT leak through a
	// regex coercion that only a broken guard would allow.
	it("does not classify a non-string message as busy even when its coerced text matches the HTTP-503 pattern", async () => {
		const trickyErr: unknown = { name: "WeirdError", message: new String("gateway HTTP 503") };
		const d = await runPerEditMutationGate(nmGateCtx(trickyErr));
		expect(d?.warnings).toEqual(["[mutation:not-measured] the mutation runner failed"]);
	});
});

describe("mutationTargetFor — boundary cases beyond the P/N suite", () => {
	const anyExists = (): boolean => true;

	// test-contract: boundary — a file that merely LIVES under a `__tests__/`
	// directory (the broad, directory-based test convention) but carries no
	// `.test.`/`.spec.` infix in its own name has no naming-convention
	// "source" to resolve to; it must never be returned as a target.
	it("does not resolve a __tests__/ helper file whose own filename carries no .test./.spec. infix", () => {
		expect(mutationTargetFor(["src/__tests__/helpers.ts"], anyExists)).toBeNull();
	});

	// test-contract: boundary — stripping ONE test/spec infix from a
	// double-infixed name (`foo.spec.test.ts`) yields `foo.spec.ts`, which is
	// STILL a test path by the naming convention. Such a "source" must never
	// be treated as a valid mutation target.
	it("does not resolve a double .spec.test. infix whose stripped remainder is itself still a test path", () => {
		expect(mutationTargetFor(["src/foo.spec.test.ts"], anyExists)).toBeNull();
	});
});

describe("primaryCodeFile — path-separator normalization before the scratch check", () => {
	// test-contract: boundary — a backslash-separated (Windows-style) path must
	// be normalized to forward slashes BEFORE the `scratch/` prefix check, or a
	// scratch probe stops being recognized as scratch and gets treated as a
	// real mutation target.
	it("still recognizes a backslash-separated scratch path as scratch, not as a target", () => {
		expect(primaryCodeFile(["scratch\\probe.ts"])).toBeNull();
	});
});

describe("failClosed — exact wire shape (spec §9)", () => {
	// test-contract: public-api — the fail-closed decision's reason, rule_id,
	// severity, and category are the contract other tooling (and the agent
	// reading the block) matches on; every field must carry its real value,
	// not a blanked-out placeholder.
	it("returns the exact block decision when the runner is unavailable and unavailable_behavior is block", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null, config: cfg({ unavailable_behavior: "block" }) }));
		expect(d).toEqual({
			decision: "block",
			reason:
				"[interlinked:mutation] BLOCKED: mutation could not be measured — no mutation runner configured (unavailable_behavior=block).",
			rule_id: "per-edit-mutation",
			severity: "medium",
			category: "mutation",
		});
	});
});

describe("runPerEditMutationGate — exact not-measured wire shape when no runner is configured", () => {
	// test-contract: public-api — the honest-disclosure warning text (spec
	// §12) must name the real reason, not a blanked-out placeholder.
	it("returns the exact not-measured decision", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null }));
		expect(d).toEqual({
			decision: "allow",
			warnings: ["[mutation:not-measured] no mutation runner configured"],
			rule_id: "per-edit-mutation",
			category: "mutation",
		});
	});
});

describe("runPerEditMutationGate — v1 always measures the WHOLE FILE (review passes 11-18)", () => {
	const LINES = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
	const BEFORE = LINES.join("\n");
	const AFTER = LINES.map((l, i) => (i === 9 ? "CHANGED" : l)).join("\n");
	const SCOPED_FILE = "src/scoped.ts";

	// test-contract: invariant — line-range execution is REMOVED from v1.
	// Stryker only emits mutants whose whole AST span fits a range, so every
	// ranged run was a partial view (adverse evidence possible, clean never
	// certifiable) and a boundary-spanning mutant could vanish entirely. Even
	// a small localized edit must hand the runner NO range argument: the whole
	// file runs; verdict scoping stays symbol-level in the evaluator.
	it("passes NO range for a small localized edit — the runner measures the whole file", async () => {
		let capturedArgs: unknown[] | null = null;
		const capturing: MutationRunner = {
			available: () => true,
			run: (...args) => {
				capturedArgs = args;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: SCOPED_FILE, content: AFTER },
				readDisk: (p) => (p === SCOPED_FILE ? BEFORE : null),
				runner: capturing,
			}),
		);
		// file, overlayContent, overlays — and NOTHING after (no 4th range arg).
		expect(capturedArgs).toHaveLength(3);
		expect((capturedArgs ?? [])[3]).toBeUndefined();
	});
});

describe("runPerEditMutationGate — dependency-graph test selection", () => {
	it("ships the exact selected tests, their local dependencies, and the scope mode", async () => {
		const selectedTest = "src/x.integration.test.ts";
		const testHelper = "src/x-test-helper.ts";
		let capturedOverlays: FileOverlay[] | undefined;
		let capturedOptions: MutationRunOptions | undefined;
		const runner: MutationRunner = {
			available: () => true,
			run: (_file, _overlay, overlays, options) => {
				capturedOverlays = overlays;
				capturedOptions = options;
				return Promise.resolve({ mutants: [survivor("killed")], testRun: GREEN_RUN, engineExitCode: 0 });
			},
		};
		const disk = new Map([
			[FILE, CONTENT],
			[selectedTest, 'import "./x-test-helper.js";\n'],
			[testHelper, "export const fixture = 1;\n"],
		]);
		await runPerEditMutationGate(
			ctx({
				runner,
				readDisk: (path) => disk.get(path) ?? null,
				testSelection: {
					kind: "selected",
					options: { testFiles: [selectedTest], scopeMode: "import_graph" },
					partial: false,
				},
			}),
		);
		expect(capturedOptions).toEqual({ testFiles: [selectedTest], scopeMode: "import_graph" });
		expect(capturedOverlays?.map((overlay) => overlay.path)).toEqual([FILE, selectedTest, testHelper]);
	});

	it("does not invoke the runner when the production path cannot prove an exact test scope", async () => {
		let calls = 0;
		const runner: MutationRunner = {
			available: () => true,
			run: () => {
				calls += 1;
				return Promise.resolve({ mutants: [] });
			},
		};
		const decision = await runPerEditMutationGate(
			ctx({
				runner,
				testSelection: { kind: "unavailable", reason: "dependency graph unavailable" },
			}),
		);
		expect(calls).toBe(0);
		expect(decision?.warnings?.[0]).toContain("dependency graph unavailable");
	});

	it("lets a reduced companion scope find adverse evidence but never certify clean", async () => {
		const decision = await runPerEditMutationGate(
			ctx({
				runner: fakeRunner([survivor("killed")]),
				testSelection: {
					kind: "selected",
					options: { testFiles: ["src/x.mutation-kill.test.ts"], scopeMode: "companion_fallback" },
					partial: true,
				},
			}),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toContain("partial");
	});
});

describe("runPerEditMutationGate — onPending is gated strictly on real pending handles", () => {
	// test-contract: invariant — a run that outlives its budget hands the exact
	// target file, exact overlay content, and exact handle list to onPending —
	// this is the only channel PostToolUse has to claim work this window paid
	// for but could not wait for.
	it("invokes onPending with the exact target/content/handles for a genuine budget-expiry", async () => {
		const pendingErr = Object.assign(new Error("pending"), { jobId: "j1", runnerUrl: "http://runner/" });
		const calls: Array<{ file: string; content: string; pending: readonly PendingHandle[] }> = [];
		const d = await runPerEditMutationGate({
			...nmGateCtx(pendingErr),
			onPending: (file, content, pending) => calls.push({ file, content, pending }),
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.file).toBe("src/a.ts");
		expect(calls[0]?.content).toBe("export const b = 1;\n");
		expect(calls[0]?.pending).toHaveLength(1);
		expect(calls[0]?.pending[0]?.jobId).toBe("j1");
		expect(calls[0]?.pending[0]?.runnerUrl).toBe("http://runner/");
		expect(d?.warnings?.join("\n")).toContain("still running past the budget");
	});

	// test-contract: invariant — a plain (non-pending) failure must NEVER
	// invoke onPending, even when a callback is provided — there is nothing
	// pending to claim, and calling it anyway would fabricate a handle.
	it("never invokes onPending for a plain failure with no pending handles", async () => {
		const calls: unknown[] = [];
		const d = await runPerEditMutationGate({
			...nmGateCtx(new Error("connection refused")),
			onPending: (...args: unknown[]) => calls.push(args),
		});
		expect(calls).toEqual([]);
		expect(d?.decision).toBe("allow");
	});
});

describe("runPerEditMutationGate — cwd threading resolves the manifest key, not process.cwd()", () => {
	// test-contract: invariant — the explicit `cwd` must reach manifest-key
	// resolution (manifest.ts's `normalizeManifestKey`), so an absolute
	// `file_path` under that cwd is recorded under its REPO-RELATIVE key, not
	// under some other resolution of the real process cwd.
	it("keys the persisted manifest by the repo-relative path resolved against the explicit cwd", async () => {
		let capturedManifest: MutationManifest | undefined;
		const d = await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: "/repo/src/z.ts", content: "export const z = 1;\n" },
				readDisk: () => "export const z = 1;\n",
				runner: fakeRunner([survivor("killed")]),
				baseManifest: emptyManifest(META),
				cwd: "/repo",
				persist: (m) => {
					capturedManifest = m;
				},
			}),
		);
		expect(d?.decision).toBe("allow");
		expect(Object.keys(capturedManifest?.files ?? {})).toEqual(["src/z.ts"]);
	});
});

describe("runPerEditMutationGate — persistence-failure warning is the ONLY warning on an otherwise-clean allow", () => {
	// test-contract: invariant — a clean measured-allow starts with no
	// warnings; a persistence failure must APPEND to that (empty) list, not
	// seed it with an unrelated placeholder entry.
	it("carries exactly one warning: the real persistence-failure text", async () => {
		const persist = (): void => {
			throw new Error("disk full");
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		// Wording deliberately admits the split-brain (Grok 2026-08-28 issue 3):
		// the persister writes manifest THEN receipt, so a mid-sequence throw can
		// leave a valid manifest — "PARTIAL", never "nothing happened".
		expect(d?.warnings).toEqual([
			"[interlinked:mutation] manifest persistence failed partway (disk full) — the on-disk mutation state may be PARTIAL (a manifest can exist without its receipt or index). The allow stands; the next run re-measures against whatever survived.",
		]);
	});
});

describe("runPerEditMutationGate — site_count_threshold is threaded through, not silently defaulted", () => {
	// test-contract: invariant — an explicitly configured (truthy) threshold
	// must be the value the oversize check actually compares against; silently
	// substituting the module default would let an intentionally-tight
	// small-scope limit go unenforced.
	it("blocks with the OVERSIZE reason (naming the configured threshold) rather than a generic survivor reason", async () => {
		const d = await runPerEditMutationGate(ctx({ config: cfg({ site_count_threshold: -5 }) }));
		expect(d?.decision).toBe("block");
		expect(d?.reason).toBe(
			"[interlinked:mutation] BLOCKED: this edit changes 1 mutation sites in one patch (over the -5-site small-scope limit). Split it into smaller behavioral changes — each with its test — so the gate stays inside its budget. (spec §6)",
		);
	});
});

describe("runPerEditMutationGate — test-edit-effect warning fires on a real delta (spec: does the new test kill anything)", () => {
	const SRC = "src/y.ts";
	const TEST = "src/y.test.ts";

	function priorSourceManifest(): MutationManifest {
		return {
			...emptyManifest(META),
			files: {
				[SRC]: {
					"sym-y": {
						symbolId: "sym-y",
						qualifiedName: "y",
						symbolHash: "stale-hash",
						mutants: {
							"mut-1": {
								mutantId: "mut-1",
								siteId: "site-1",
								mutator: "Eq",
								originalLexeme: ">",
								replacement: ">=",
								ordinalWithinSymbol: 0,
								status: "survived",
								firstSeen: META.authoritativeAt,
							},
						},
						instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
					},
				},
			},
		};
	}

	// test-contract: invariant — editing ONLY the companion test measures the
	// source it protects against the PRIOR recorded survivor count; a run that
	// kills the recorded survivor must say so, by exact text, not stay silent.
	it("reports the exact before/after survivor delta for a test-only edit", async () => {
		const d = await runPerEditMutationGate(
			ctx({
				toolName: "Edit",
				toolInput: { file_path: TEST, old_string: "old", new_string: "new" },
				readDisk: (p) =>
					p === SRC ? "export function y(x: number): boolean { return x > 0; }\n" : p === TEST ? "old test\n" : null,
				runner: fakeRunner([survivor("killed")]),
				baseManifest: priorSourceManifest(),
			}),
		);
		const effectWarning = d?.warnings?.find((w) => w.startsWith("[mutation:test-effect]"));
		expect(effectWarning).toBe(`[mutation:test-effect] ${TEST} killed 1 mutant(s) in ${SRC} (1 → 0 surviving).`);
	});
});

describe("applyMode — warn-mode downgrade preserves the real decision content", () => {
	// test-contract: invariant — mode=warn must NEVER touch a decision that is
	// already an allow; wrapping it in the block-downgrade shape would inject
	// a fabricated generic warning where none belongs.
	it("leaves an already-clean allow untouched when mode is warn", async () => {
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }), runner: fakeRunner([survivor("killed")]) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toBeUndefined();
	});

	// test-contract: invariant — downgrading a block to a warning must carry
	// the REAL block reason verbatim, never a generic fallback string, so the
	// agent reading the warning gets the same actionable detail a block would
	// have given it.
	it("preserves the real block reason text verbatim when downgrading to a warning", async () => {
		const blocked = await runPerEditMutationGate(ctx());
		const warned = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }) }));
		expect(blocked?.decision).toBe("block");
		expect(warned?.decision).toBe("allow");
		expect(warned?.warnings?.[0]).toBe(blocked?.reason);
	});
});

describe("buildOverlays / overlayContentFor — a test-only edit's overlay set (spec §7)", () => {
	const SRC = "src/foo.ts";
	const TEST = "src/foo.test.ts";
	const SRC_CONTENT = "export const foo = 1;\n";

	// test-contract: invariant — when the edit is on the COMPANION TEST, the
	// primary (source) overlay must reflect unchanged disk content (the source
	// itself was not touched), while the test overlay in the SAME set must
	// carry the EDITED test body — never the stale, pre-edit disk copy, and
	// never a duplicate entry.
	it("carries the unchanged source plus the freshly-edited companion test, in that order, with no duplicates", async () => {
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolName: "Edit",
				toolInput: { file_path: TEST, old_string: "OLD", new_string: "NEW" },
				readDisk: (p) => (p === SRC ? SRC_CONTENT : p === TEST ? "OLD test body\n" : null),
				runner: capturing,
				baseManifest: emptyManifest(META),
			}),
		);
		expect(captured).toEqual([
			{ path: SRC, content: SRC_CONTENT },
			{ path: TEST, content: "NEW test body\n" },
		]);
	});

	it("resolves the graph scope from the chosen source target, not from the edited companion test", async () => {
		let selectedTarget: string | undefined;
		let capturedOptions: MutationRunOptions | undefined;
		const runner: MutationRunner = {
			available: () => true,
			run: (_file, _overlay, _overlays, options) => {
				capturedOptions = options;
				return Promise.resolve({ mutants: [survivor("killed")], testRun: GREEN_RUN, engineExitCode: 0 });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolName: "Edit",
				toolInput: { file_path: TEST, old_string: "OLD", new_string: "NEW" },
				readDisk: (path) => (path === SRC ? SRC_CONTENT : path === TEST ? "OLD test body\n" : null),
				runner,
				baseManifest: emptyManifest(META),
				selectTests: (target) => {
					selectedTarget = target;
					return {
						kind: "selected",
						options: { testFiles: [TEST], scopeMode: "import_graph" },
						partial: false,
					};
				},
			}),
		);
		expect(selectedTarget).toBe(SRC);
		expect(capturedOptions).toEqual({ testFiles: [TEST], scopeMode: "import_graph" });
	});

	// test-contract: invariant — when the companion test does not exist on
	// disk at all, the overlay set must carry ONLY the primary — never a
	// phantom companion entry with null/undefined content.
	it("does not add a companion overlay entry when the companion doesn't exist on disk", async () => {
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: FILE, content: CONTENT },
				readDisk: (p) => (p === FILE ? CONTENT : null),
				runner: capturing,
			}),
		);
		expect(captured).toEqual([{ path: FILE, content: CONTENT }]);
	});
});

describe("addLocalDeps — walks BOTH the target's and the companion's own imports", () => {
	const TARGET2 = "src/dep-walk-target.ts";
	const COMPANION2 = "src/dep-walk-target.test.ts";
	const TARGET_ONLY_DEP = "src/dep-walk-target-only.ts";
	const COMPANION_ONLY_DEP = "src/dep-walk-companion-only.ts";

	// test-contract: invariant — a local dependency reachable ONLY through the
	// companion test's own imports (not the target's) must still be carried in
	// the overlay set; walking just the target would silently drop it.
	it("carries a dep imported only by the companion test, not only the target's own deps", async () => {
		const targetContent = 'import "./dep-walk-target-only.js";\nexport const z = 1;\n';
		const files: Record<string, string> = {
			[TARGET2]: targetContent,
			[COMPANION2]: 'import "./dep-walk-companion-only.js";\nexport {};\n',
			[TARGET_ONLY_DEP]: "export const a = 1;\n",
			[COMPANION_ONLY_DEP]: "export const b = 1;\n",
		};
		const readDisk = (p: string): string | null => files[p] ?? null;
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: TARGET2, content: targetContent },
				runner: capturing,
				readDisk,
			}),
		);
		expect(captured?.map((o) => o.path)).toEqual([TARGET2, COMPANION2, TARGET_ONLY_DEP, COMPANION_ONLY_DEP]);
	});

	const TARGET3 = "src/dep-dup-target.ts";
	const COMPANION3 = "src/dep-dup-target.test.ts";

	// test-contract: invariant — the have-set that prevents duplicate overlay
	// entries must track REAL paths already in the overlay (including the
	// companion added earlier in the same call), not merely a same-length
	// placeholder collection; a dep that resolves back to an already-carried
	// path must be skipped, not appended again.
	it("does not duplicate the companion overlay when the target's own imports resolve back to it", async () => {
		const targetContent = 'import "./dep-dup-target.test.js";\nexport const w = 1;\n';
		const files: Record<string, string> = {
			[TARGET3]: targetContent,
			[COMPANION3]: "export {};\n",
		};
		const readDisk = (p: string): string | null => files[p] ?? null;
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: TARGET3, content: targetContent },
				runner: capturing,
				readDisk,
			}),
		);
		expect(captured?.map((o) => o.path)).toEqual([TARGET3, COMPANION3]);
	});
});
