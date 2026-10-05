// Pins for `fcAssert`: the one fast-check entry point that carries the three
// Hegel-trial ideas — replay-first failures, a CI seed pinned per test id, and
// a heavy-rejection warning (hegel-trial.md §7, ideas 1–3).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExampleStore, recordExample, stableSeed } from "./fast-check-examples.js";
import { DEFAULT_HEAVY_REJECTION_RATIO, failureOrigin, fcAssert, fcAssertAsync, resolveRunPlan, unshrunkPathOf } from "./fc-assert.js";
import { replayBinding } from "./replay-compatibility.js";

const TEST_ID = "src/x.test.ts::suite > fails above";
const LIMIT = 500;
const UPPER = 1000;
const integers = fc.integer({ min: 0, max: UPPER });
const STORED = { seed: 42, path: "0", counterexample: "[690]", ts: "2026-10-04T00:00:00.000Z",
    compatibility: replayBinding(process.cwd(), TEST_ID, "fixture-v1") };
const CLEARED_LINE = `[interlinked:fast-check] cleared stored failure for ${TEST_ID} (replay passed; not reproduced, not proof of a fix)`;
const PIN_LINE = (shown: string) => `[interlinked:fast-check] to keep it as a regression case, add to the fcAssert params: examples: [${shown}]`;
const passesAlways = fc.property(integers, (n) => n <= UPPER);
const failsAbove = (hits: number[] = []) =>
	fc.property(integers, (n) => {
		hits.push(n);
		return n < LIMIT;
	});

describe("fcAssert", () => {
	it("preserves even prunable entries when writes are disabled with a native test identity", () => {
		const root = mkdtempSync(join(tmpdir(), "fc-readonly-"));
		const path = join(root, "examples.json");
		try {
			recordExample(path, "missing.test.ts::removed", STORED);
			const before = readFileSync(path, "utf8");
			const plan = resolveRunPlan({ storePath: path, env: { INTERLINKED_TEST_PROJECT_ROOT: root, INTERLINKED_FC_EXAMPLES: "off" } });
			expect(plan.testId).not.toBeNull();
			expect(plan.writesDisabled).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	let dir: string;
	let storePath: string;
	let warnings: string[];
	const base = () => ({ storePath, testId: TEST_ID, replayCompatibility: "fixture-v1", env: {} as NodeJS.ProcessEnv, warn: (line: string) => warnings.push(line) });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fc-assert-"));
		storePath = join(dir, "examples.json");
		warnings = [];
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	describe("replay store — positive (must fire)", () => {
		it("P1: a failing property records seed, path and a truncated counterexample under the test id", () => {
			expect(() => fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 })).toThrow(/Property failed/);
			const entry = readExampleStore(storePath).entries[TEST_ID];
			expect(entry).toBeDefined();
			expect(entry?.seed).toBe(42);
			expect(entry?.path).toMatch(/^\d+(:\d+)*$/);
			expect(Number(entry?.counterexample.replace(/[[\]]/g, ""))).toBeGreaterThanOrEqual(LIMIT);
			expect(Date.parse(entry?.ts ?? "")).not.toBeNaN();
		});

		it("P2: the next run replays the stored failure first and fails in fewer body calls", () => {
			const first: number[] = [];
			expect(() => fcAssert(failsAbove(first), { ...base(), seed: 42, numRuns: 50 })).toThrow();
			const second: number[] = [];
			expect(() => fcAssert(failsAbove(second), { ...base(), seed: 42, numRuns: 50 })).toThrow(/replayed from/);
			expect(second.length).toBeLessThan(first.length);
			expect(second[0]).toBeGreaterThanOrEqual(LIMIT);
		});

		it("P4: without an explicit id the plan keys by the live vitest file and title", () => {
			const plan = resolveRunPlan({ storePath, env: {} as NodeJS.ProcessEnv });
			expect(plan.testId).toBe("src/test-setup/fc-assert.test.ts::fcAssert > replay store — positive (must fire) > P4: without an explicit id the plan keys by the live vitest file and title");
		});

		it("P3: the failure message carries seed and path (fast-check default report) and the test id", () => {
			let message = "";
			try {
				fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 });
			} catch (err) {
				message = String((err as Error).message);
			}
			expect(message).toContain(TEST_ID);
			expect(message).toMatch(/seed: 42/);
			expect(message).toMatch(/path: "\d+(:\d+)*"/);
			expect(message).toMatch(/Counterexample: \[\d+\]/);
		});
	});

	describe("replay store — negative (must not fire)", () => {
		it("N1: a passing property writes nothing", () => {
			fcAssert(fc.property(integers, (n) => n <= UPPER), { ...base(), numRuns: 20 });
			expect(existsSync(storePath)).toBe(false);
		});

		it("N2: writes are skipped under a Stryker mutant, but the failure still throws", () => {
			const env = { __STRYKER_ACTIVE_MUTANT__: "1" } as NodeJS.ProcessEnv;
			expect(() => fcAssert(failsAbove(), { ...base(), env, seed: 42, numRuns: 50 })).toThrow(/Property failed/);
			expect(existsSync(storePath)).toBe(false);
		});

		it("N3: without a vitest test id nothing is stored or replayed", () => {
			const plan = resolveRunPlan({ storePath, testId: null, env: {} as NodeJS.ProcessEnv, numRuns: 5 });
			expect(plan.replay).toBeNull();
			expect(plan.testId).toBeNull();
		});
	});

	describe("replay clearing — positive (must fire)", () => {
		it("P1: a passing replay removes the entry and emits one cleared line", () => {
			expect(() => fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 })).toThrow();
			expect(readExampleStore(storePath).entries[TEST_ID]).toBeDefined();
			const shown = readExampleStore(storePath).entries[TEST_ID]?.counterexample ?? "";
			fcAssert(passesAlways, { ...base(), seed: 42, numRuns: 20 });
			expect(readExampleStore(storePath).entries[TEST_ID]).toBeUndefined();
			expect(warnings).toEqual([CLEARED_LINE, PIN_LINE(shown)]);
		});

		it("P2: clearing keeps the other test ids in the store", () => {
			recordExample(storePath, "src/y.test.ts::other", STORED);
			recordExample(storePath, TEST_ID, STORED);
			fcAssert(passesAlways, { ...base(), numRuns: 5 });
			const entries = readExampleStore(storePath).entries;
			expect(Object.keys(entries)).toEqual(["src/y.test.ts::other"]);
		});

		it("P3: the async twin clears a passing replay too", async () => {
			recordExample(storePath, TEST_ID, STORED);
			await fcAssertAsync(fc.asyncProperty(integers, async () => true), { ...base(), numRuns: 5 });
			expect(readExampleStore(storePath).entries[TEST_ID]).toBeUndefined();
			expect(warnings).toEqual([CLEARED_LINE, PIN_LINE("[690]")]);
		});

		it("P4: a replay that still fails keeps the entry, refreshes it and emits no cleared line", () => {
			expect(() => fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 })).toThrow();
			const before = readExampleStore(storePath).entries[TEST_ID];
			expect(() => fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 })).toThrow(/replayed from/);
			const after = readExampleStore(storePath).entries[TEST_ID];
			expect(after).toBeDefined();
			expect(after?.path).toBe(before?.path);
			expect(warnings).toEqual([]);
		});
	});

	describe("replay clearing — negative (must not fire)", () => {
		it("N1: with writes disabled the entry and the file bytes stay untouched and nothing is emitted", () => {
			recordExample(storePath, TEST_ID, STORED);
			const bytes = readFileSync(storePath, "utf8");
			const env = { INTERLINKED_FC_EXAMPLES: "off" } as NodeJS.ProcessEnv;
			fcAssert(passesAlways, { ...base(), env, numRuns: 5 });
			expect(readFileSync(storePath, "utf8")).toBe(bytes);
			expect(warnings).toEqual([]);
		});

		it("N2: with no stored entry nothing is emitted and no store file appears", () => {
			fcAssert(passesAlways, { ...base(), numRuns: 5 });
			expect(warnings).toEqual([]);
			expect(existsSync(storePath)).toBe(false);
		});

		it("N3: a passing random phase never clears an entry (only a passing replay does)", () => {
			recordExample(storePath, "src/y.test.ts::other", STORED);
			fcAssert(passesAlways, { ...base(), numRuns: 5 });
			expect(readExampleStore(storePath).entries["src/y.test.ts::other"]).toBeDefined();
			expect(warnings).toEqual([]);
		});
	});

	describe("unshrunk replay — positive (must fire)", () => {
		it("P1: a stored path with shrink steps plans a second replay of its first segment", () => {
			expect(unshrunkPathOf("12:3:0")).toBe("12");
			recordExample(storePath, TEST_ID, { ...STORED, path: "7:0:1" });
			const plan = resolveRunPlan(base());
			expect(plan.replay?.path).toBe("7:0:1");
			expect(plan.replayOriginal?.path).toBe("7");
			expect(plan.replayOriginal?.seed).toBe(STORED.seed);
		});

		it("P2: a shrunk path that passes while the unshrunk one fails still fails, and stores the unshrunk path", () => {
			expect(() => fcAssert(failsAbove(), { ...base(), seed: 42, numRuns: 50 })).toThrow();
			const stored = readExampleStore(storePath).entries[TEST_ID];
			expect(stored?.counterexample).toBe(`[${LIMIT}]`);
			const unshrunk = unshrunkPathOf(stored?.path ?? "");
			expect(stored?.path).not.toBe(unshrunk);
			// fast-check continues to a passing node's shrink siblings, so the shrunk replay passes only when none of
			// them fails either: with seed 42 the unshrunk draw is 995 and every value near 500 is below 990.
			const failsNearTop = fc.property(integers, (n) => n < 990);
			expect(() => fcAssert(failsNearTop, { ...base(), seed: 42, numRuns: 50 })).toThrow(/replayed from/);
			expect(warnings).toEqual([
				`[interlinked:fast-check] ${TEST_ID}: the shrunk path no longer fails, but the unshrunk failure (path "${unshrunk}") still does`,
			]);
			expect(readExampleStore(storePath).entries[TEST_ID]?.path).toBe(unshrunk);
		});

		it("P3: two failures at different origins emit one shrink-slippage line", () => {
			const twoBugs = fc.property(integers, (n) => {
				if (n === 0) throw new RangeError("zero");
				if (n >= LIMIT) throw new TypeError("large");
				return true;
			});
			expect(() => fcAssert(twoBugs, { ...base(), seed: 42, numRuns: 50 })).toThrow();
			expect(readExampleStore(storePath).entries[TEST_ID]?.counterexample).toBe("[0]");
			expect(() => fcAssert(twoBugs, { ...base(), seed: 42, numRuns: 50 })).toThrow(/replayed from/);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(
				/^\[interlinked:fast-check\] shrink slippage for .*: unshrunk failure TypeError at \S+fc-assert\.test\.ts:\d+, shrunk failure RangeError at \S+fc-assert\.test\.ts:\d+/,
			);
		});

		it("P4: the origin is the error name plus the first frame outside dependencies", () => {
			const error = new TypeError("x");
			error.stack = "TypeError: x\n    at f (/r/node_modules/fast-check/a.js:1:2)\n    at g (/r/src/a.test.ts:40:7)";
			expect(failureOrigin(error)).toBe("TypeError at /r/src/a.test.ts:40");
		});
	});

	describe("unshrunk replay — negative (must not fire)", () => {
		it("N1: a stored path without shrink steps plans no second replay", () => {
			recordExample(storePath, TEST_ID, STORED);
			expect(resolveRunPlan(base()).replayOriginal).toBeNull();
		});

		it("N2: two failures at the same origin emit no slippage line", () => {
			const oneBug = fc.property(integers, (n) => {
				if (n >= LIMIT) throw new TypeError(`large ${n}`);
				return true;
			});
			expect(() => fcAssert(oneBug, { ...base(), seed: 42, numRuns: 50 })).toThrow();
			expect(() => fcAssert(oneBug, { ...base(), seed: 42, numRuns: 50 })).toThrow(/replayed from/);
			expect(warnings).toEqual([]);
		});

		it("N3: a truncated counterexample gets no pin line on clear", () => {
			recordExample(storePath, TEST_ID, { ...STORED, counterexample: '["abc…' });
			fcAssert(passesAlways, { ...base(), numRuns: 5 });
			expect(warnings).toEqual([CLEARED_LINE]);
		});
	});

	describe("CI seed pin — positive (must fire)", () => {
		it("P1: under CI with no explicit seed the plan seed is the stable hash of the test id", () => {
			const plan = resolveRunPlan({ storePath, testId: TEST_ID, env: { CI: "true" } as NodeJS.ProcessEnv });
			expect(plan.random.seed).toBe(stableSeed(TEST_ID));
			expect(plan.seedSource).toBe("ci-test-id");
		});

		it("P2: the thrown message names the pinned seed", () => {
			const env = { CI: "1" } as NodeJS.ProcessEnv;
			expect(() => fcAssert(failsAbove(), { ...base(), env, numRuns: 50 })).toThrow(new RegExp(`seed: ${stableSeed(TEST_ID)}\\b`));
		});
	});

	describe("CI seed pin — negative (must not fire)", () => {
		it("N1: a local run (no CI) leaves the seed to fast-check's clock", () => {
			const plan = resolveRunPlan({ storePath, testId: TEST_ID, env: {} as NodeJS.ProcessEnv });
			expect(plan.random.seed).toBeUndefined();
			expect(plan.seedSource).toBe("random");
		});

		it("N2: an explicit seed wins over the CI pin", () => {
			const plan = resolveRunPlan({ storePath, testId: TEST_ID, env: { CI: "1" } as NodeJS.ProcessEnv, seed: 7 });
			expect(plan.random.seed).toBe(7);
			expect(plan.seedSource).toBe("explicit");
		});
	});

	describe("heavy rejection — positive (must fire)", () => {
		it("P1: a fc.pre that rejects most draws warns once, naming the test id and the ratio", () => {
			const mostlyRejected = fc.property(integers, (n) => {
				fc.pre(n % 10 === 0);
				return true;
			});
			fcAssert(mostlyRejected, { ...base(), numRuns: 20, seed: 1 });
			fcAssert(mostlyRejected, { ...base(), numRuns: 20, seed: 1 });
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/^\[interlinked:fast-check\] heavy rejection: /);
			expect(warnings[0]).toContain(TEST_ID);
			expect(warnings[0]).toMatch(/skipped \d+\/\d+ draws \(\d+%\)/);
		});

		it("P2: the ratio is configurable per call and through the env", () => {
			const lightlyRejected = fc.property(integers, (n) => {
				fc.pre(n % 4 !== 0);
				return true;
			});
			fcAssert(lightlyRejected, { ...base(), testId: `${TEST_ID} per call`, numRuns: 40, seed: 1, heavyRejectionRatio: 0.1 });
			expect(warnings).toHaveLength(1);
			const env = { INTERLINKED_FC_REJECTION_WARN: "0.1" } as NodeJS.ProcessEnv;
			fcAssert(lightlyRejected, { ...base(), env, testId: `${TEST_ID} via env`, numRuns: 40, seed: 1 });
			expect(warnings).toHaveLength(2);
		});
	});

	describe("heavy rejection — negative (must not fire)", () => {
		it("N1: a property with no preconditions never warns", () => {
			fcAssert(fc.property(integers, () => true), { ...base(), numRuns: 20 });
			expect(warnings).toEqual([]);
			expect(DEFAULT_HEAVY_REJECTION_RATIO).toBe(0.5);
		});

		it("N2: rejection at or below the default ratio stays silent", () => {
			fcAssert(
				fc.property(integers, (n) => {
					fc.pre(n % 4 !== 0);
					return true;
				}),
				{ ...base(), numRuns: 40, seed: 1 },
			);
			expect(warnings).toEqual([]);
		});
	});

	describe("per-edit property budget", () => {
		it("P1: INTERLINKED_PROPERTY_NUMRUNS caps an explicit numRuns, replay included", () => {
			const env = { INTERLINKED_PROPERTY_NUMRUNS: "5" } as NodeJS.ProcessEnv;
			const hits: number[] = [];
			fcAssert(
				fc.property(integers, (n) => {
					hits.push(n);
					return true;
				}),
				{ ...base(), env, numRuns: 200 },
			);
			expect(hits).toHaveLength(5);
			const plan = resolveRunPlan({ storePath, testId: TEST_ID, env, numRuns: 200 });
			expect(plan.random.numRuns).toBe(5);
		});

		it("N1: without the budget the explicit numRuns stands", () => {
			const plan = resolveRunPlan({ storePath, testId: TEST_ID, env: {} as NodeJS.ProcessEnv, numRuns: 200 });
			expect(plan.random.numRuns).toBe(200);
		});
	});

	describe("fcAssertAsync", () => {
		it("P1: records and rethrows an async failure", async () => {
			const prop = fc.asyncProperty(integers, async (n) => n < LIMIT);
			await expect(fcAssertAsync(prop, { ...base(), seed: 42, numRuns: 50 })).rejects.toThrow(/Property failed/);
			expect(readExampleStore(storePath).entries[TEST_ID]?.seed).toBe(42);
		});

		it("N1: a passing async property resolves and writes nothing", async () => {
			await fcAssertAsync(fc.asyncProperty(integers, async () => true), { ...base(), numRuns: 10 });
			expect(existsSync(storePath)).toBe(false);
		});
	});
});
