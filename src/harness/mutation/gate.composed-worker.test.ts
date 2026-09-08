// ===========================================
// Composed: raw Worker response → cloud runner → evaluator → gate → persistence
// ===========================================
// Goal 28 §8 requires ONE test that drives a raw Worker-shaped body through the
// whole chain, because every existing test stops at a boundary: `gate.test.ts`
// injects a fake runner with hand-built `AdaptedMutant[]`, and
// `cloud-runner.test.ts` stops at the runner's return value. Neither can see
// the property that actually matters — whether a given HTTP body ends in a
// manifest write.
//
// The fixtures below are the Worker's real response shape (`mutationResponse`
// in the prototype Worker), not an idealized one, so a change to that shape
// breaks this test rather than silently passing.

import { describe, expect, it } from "vitest";
import { createCloudMutationRunner } from "./cloud-runner.js";
import { runPerEditMutationGate } from "./gate.js";
import { emptyManifest } from "./manifest.js";
import type { MutationManifest, MutationReceipt } from "./types.js";

const TARGET = "src/x.ts";
const CONTENT = "export function bar(x: number): boolean {\n\treturn x > 0;\n}\n";

const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

/** One Killed mutant on the `>` in the target file — the Worker's own shape. */
function workerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "1.0",
		files: {
			[TARGET]: {
				source: CONTENT,
				language: "typescript",
				mutants: [
					{
						id: "0",
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status: "Killed",
						location: { start: { line: 2, column: 11 }, end: { line: 2, column: 12 } },
					},
				],
			},
		},
		testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 1 },
		// Strict evidence (2026-08-28): a conclusive measurement carries the
		// engine's own exit status. Tests that probe its absence override this.
		engine: { exitCode: 0 },
		...over,
	};
}

interface Run {
	decision: Awaited<ReturnType<typeof runPerEditMutationGate>>;
	persists: Array<{ manifest: MutationManifest; receipt: MutationReceipt }>;
}

/** Drive one HTTP body through the REAL runner, evaluator, gate and persister. */
async function driveBody(body: unknown, status = 200): Promise<Run> {
	const runner = createCloudMutationRunner(
		{ url: "http://runner.test/", timeoutMs: 5_000, cwd: "/repo" },
		async () => {
			const stub = {
				ok: status >= 200 && status < 300,
				status,
				text: async () => JSON.stringify(body),
				json: async () => body,
			};
			// The runner reads exactly `ok`, `status`, `text()` and `json()`. A full
			// `Response` would add ~20 members this chain never touches, and
			// fabricating them would make the double LESS faithful to what the code
			// under test actually depends on.
			// SAFETY: every member the caller dereferences is present above.
			return stub;
		},
	);
	const persists: Run["persists"] = [];
	const decision = await runPerEditMutationGate({
		toolName: "Write",
		toolInput: { file_path: TARGET, content: CONTENT },
		config: {
			enabled: true,
			mode: "warn",
			unavailable_behavior: "allow_unmeasured",
			budget_ms: 5_000,
			runner_url: "http://runner.test/",
		},
		runner,
		baseManifest: emptyManifest(META),
		readDisk: (f) => (f === TARGET ? CONTENT : null),
		persist: (manifest, receipt) => {
			persists.push({ manifest, receipt });
		},
		at: "t",
		cwd: "/repo",
	});
	return { decision, persists };
}

const warned = (r: Run): string => (r.decision?.warnings ?? []).join("\n");

describe("composed: a Worker body reaching (or not reaching) persistence", () => {
	// test-contract: public-api — the happy path must still work end-to-end, or
	// every negative below would pass for the wrong reason.
	it("P: a complete body with green tests is measured and persists exactly once", async () => {
		const run = await driveBody(workerBody());
		expect(run.decision?.decision).toBe("allow");
		expect(run.persists).toHaveLength(1);
		expect(run.persists[0]?.receipt.sites).toHaveLength(1);
	});

	// test-contract: invariant — goal 28 §8, the #1 false clean. A mutants-only
	// runner reports every mutant Killed because no test ever ran.
	it("N: the SAME body with testRun removed persists NOTHING", async () => {
		const body: Partial<ReturnType<typeof workerBody>> = workerBody();
		// Delete the property to model a runner that omits the field entirely.
		delete body.testRun;
		const run = await driveBody(body);
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("not-measured");
		expect(warned(run)).toContain("no test-run evidence");
	});

	// test-contract: invariant — a green flag with zero executed tests is the
	// same false-clean class as an omitted test run: no oracle observed a mutant.
	it("N: a green body with zero executed tests persists NOTHING", async () => {
		const run = await driveBody(workerBody({
			testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 0 },
		}));
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("not-measured");
		expect(warned(run)).toContain("zero tests executed");
	});

	// Stryker's JSON report lists skipped tests but drops their status. Those
	// rows are discovery inventory, not proof that any oracle executed.
	it("N: native test rows without an explicit executed count persist NOTHING", async () => {
		const run = await driveBody(workerBody({
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
			testFiles: { "src/x.test.ts": { tests: [{ id: "skipped-test" }] } },
		}));
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("not-measured");
		expect(warned(run)).toContain("no executed-test count");
	});

	// test-contract: invariant — goal 28 §8 census. A truncated location makes a
	// mutant unparseable; dropping it silently shortens the census.
	it("N: a malformed mutant row makes the run not-measured and persists nothing", async () => {
		const body = workerBody();
		// `workerBody()` built this object one line above, so the shape is known;
		// the cast narrows the deliberately-loose fixture type to append a row.
		// SAFETY: constructed locally by workerBody() with exactly this shape.
		const files = body.files as Record<string, { mutants: Array<Record<string, unknown>> }>;
		const mutants = files[TARGET]?.mutants ?? [];
		mutants.push({
			id: "1",
			mutatorName: "EqualityOperator",
			replacement: "<",
			status: "Survived",
			location: { start: { line: 2, column: 11 } }, // no `end` — unparseable
		});
		const run = await driveBody(body);
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("incomplete census");
	});

	// test-contract: invariant — adverse evidence must survive every not-measured
	// short-circuit. This is the ordering the whole contract rests on.
	it("P: a RED suite blocks even though the mutant list is empty", async () => {
		const run = await driveBody({
			schemaVersion: "1.0",
			files: {},
			testRun: { overlayGreen: false, redWitnessSatisfied: null, executedTestCount: 0 },
		});
		expect(run.decision?.decision).toBe("allow"); // warn mode downgrades…
		expect(warned(run)).toMatch(/red|fail/i); // …but the finding still speaks
		expect(run.persists).toHaveLength(0);
	});

	// test-contract: boundary — an HTTP failure is not evidence of anything.
	it("N: a 500 from the runner is not-measured and persists nothing", async () => {
		const run = await driveBody({ error: "clone failed" }, 500);
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("not-measured");
	});

	// test-contract: invariant — goal 28 §8 "engine exit 0". A mutation engine
	// that dies partway still leaves a report behind, and the survivors it never
	// got to are exactly what a forged clean pass would hide — so a CRASH reads
	// as cleaner than a healthy run unless the status is checked.
	it("N: a non-zero engine exit is not-measured and persists nothing", async () => {
		const run = await driveBody(workerBody({ engine: { exitCode: 1 } }));
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("engine exited 1");
	});

	// test-contract: invariant — the Worker deliberately refuses to collapse an
	// unrecoverable status to 0, and that refusal has to survive the trip.
	it("N: an unrecoverable engine exit (null) is not-measured and persists nothing", async () => {
		const run = await driveBody(workerBody({ engine: { exitCode: null } }));
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("unrecoverable");
	});

	// test-contract: invariant — a malformed `engine` must not read as silence.
	// Claiming a status and producing garbage is a STRONGER failure than never
	// mentioning the engine, so it must not soften into the permissive path.
	it("N: a malformed engine field is not-measured and persists nothing", async () => {
		const run = await driveBody(workerBody({ engine: { exitCode: "zero" } }));
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("unrecoverable");
	});

	// test-contract: public-api — the healthy path must still certify, or the
	// three negatives above would pass for the wrong reason.
	it("P: an explicit engine exit 0 still measures and persists", async () => {
		const run = await driveBody(workerBody({ engine: { exitCode: 0 } }));
		expect(run.decision?.decision).toBe("allow");
		expect(run.persists).toHaveLength(1);
	});

	// test-contract: invariant — STRICT (2026-08-28). Absence of engine-exit
	// evidence must not certify: `runner_url` is configurable, so an old runner,
	// a proxy, a replay, or a misdeployed Worker can legitimately omit the field
	// — and a crashed engine's partial report would then read as complete.
	it("N: a body with NO engine field is not-measured and persists nothing", async () => {
		const body: Partial<ReturnType<typeof workerBody>> = workerBody();
		// Delete the property to model a runner that omits the field entirely.
		delete body.engine;
		const run = await driveBody(body);
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("no engine-exit evidence");
	});

	// test-contract: invariant — a report about OTHER files says nothing about
	// this one; it must never be read as "nothing survived here".
	it("N: an other-files-only report persists nothing", async () => {
		const run = await driveBody({
			schemaVersion: "1.0",
			files: {
				"src/other.ts": { source: "export const y = 1;\n", language: "typescript", mutants: [] },
			},
			testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 1 },
		});
		expect(run.persists).toHaveLength(0);
		expect(warned(run)).toContain("not-measured");
	});
});
