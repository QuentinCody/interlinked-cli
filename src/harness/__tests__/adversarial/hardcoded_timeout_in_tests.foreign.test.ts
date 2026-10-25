// Cross-repo falsification of `hardcoded_timeout_in_tests` (2026-10-21,
// scratch/2026-10-21-cross-repo/falsify-result.json). Every negative below is
// REAL code from a foreign repository (tinylibs/tinybench, colinhacks/zod)
// that an independent adjudication confirmed as a false positive: the literal
// delay is the MEASURED INPUT of a timing system under test (a workload passed
// to `bench.add`) or a fixture callback that simulates async work (a
// `z.codec` decode/encode hook). It sits inside a callback handed to a call
// that is not the test function, so the test never waits on it. Each case is
// attributed to its source file:line and trimmed to the enclosing test. The
// positives pin the class: a literal delay in the test's own control flow.
import { describe, expect, it } from "vitest";
import { checkHardcodedTimeoutInTests } from "../../checks/test-hygiene-isolation.js";

const TINYBENCH_BASIC = (provider: string) =>
	[
		"import { expect, test } from 'vitest'",
		"",
		"import { Bench, type Task } from '../src'",
		"",
		"// If running in CI, allow a bit more leeway for the mean value",
		"const maxMeanValue = process.env.CI ? 1100 : 1002",
		"",
		`test('${provider} basic (async)', async () => {`,
		"  const bench = new Bench({",
		"    iterations: 16,",
		"    time: 100,",
		`    timestampProvider: '${provider}',`,
		"  })",
		"  bench",
		"    .add('foo', async () => {",
		"      await new Promise(resolve => setTimeout(resolve, 50))",
		"    })",
		"    .add('bar', async () => {",
		"      await new Promise(resolve => setTimeout(resolve, 100))",
		"    })",
		"",
		"  await bench.run()",
		"",
		"  const tasks = bench.tasks as [Task, Task]",
		"  expect(tasks[0].result.totalTime).toBeGreaterThanOrEqual(50)",
		"  expect(Math.ceil(tasks[0].result.latency.mean)).toBeGreaterThanOrEqual(50)",
		"  expect(tasks[1].result.totalTime).toBeGreaterThanOrEqual(100)",
		"  expect(tasks[0].result.throughput.mean * tasks[0].result.period).toBeLessThan(maxMeanValue)",
		"})",
	].join("\n");

// zod packages/zod/src/v4/{classic,mini}/tests/codec.test.ts, "async codec
// functionality" (identical fixture hooks in both packages).
const ZOD_ASYNC_CODEC = [
	'test("async codec functionality", async () => {',
	"  // Test that async encode/decode functions work properly",
	"  const asyncCodec = z.codec(z.string(), z.number(), {",
	"    decode: async (str) => {",
	"      await new Promise((resolve) => setTimeout(resolve, 1)); // Simulate async work",
	"      return Number.parseFloat(str);",
	"    },",
	"    encode: async (num) => {",
	"      await new Promise((resolve) => setTimeout(resolve, 1)); // Simulate async work",
	"      return num.toString();",
	"    },",
	"  });",
	"",
	"  // Test async decode/encode",
	'  const decoded = await z.decodeAsync(asyncCodec, "42.5");',
	"  expect(decoded).toBe(42.5);",
	"",
	'  const encoded = await z.encodeAsync(asyncCodec, 42.5);',
	'  expect(encoded).toBe("42.5");',
	"});",
].join("\n");

function linesFlagged(content: string, file: string): number[] {
	return checkHardcodedTimeoutInTests(content, file).map((m) => m.line);
}

describe("hardcoded_timeout_in_tests — negative (must not fire)", () => {
	it("N1: tinybench test/basic-async-hrtime-now.test.ts:16 — the 50ms task body is the benchmarked workload", () => {
		const content = TINYBENCH_BASIC("hrtimeNow");
		expect(content.split("\n")[15]).toContain("setTimeout(resolve, 50)");
		expect(linesFlagged(content, "test/basic-async-hrtime-now.test.ts")).not.toContain(16);
	});

	it("N2: tinybench test/basic-async-hrtime-now.test.ts:19 — the 100ms task body is the second workload", () => {
		const content = TINYBENCH_BASIC("hrtimeNow");
		expect(content.split("\n")[18]).toContain("setTimeout(resolve, 100)");
		expect(linesFlagged(content, "test/basic-async-hrtime-now.test.ts")).not.toContain(19);
	});

	it("N3: tinybench test/basic-async-performance-now.test.ts:16 — same 50ms workload under performanceNow", () => {
		const content = TINYBENCH_BASIC("performanceNow");
		expect(linesFlagged(content, "test/basic-async-performance-now.test.ts")).not.toContain(16);
	});

	it("N4: tinybench test/basic-async-performance-now.test.ts:19 — same 100ms workload under performanceNow", () => {
		const content = TINYBENCH_BASIC("performanceNow");
		expect(checkHardcodedTimeoutInTests(content, "test/basic-async-performance-now.test.ts")).toEqual([]);
	});

	it("N5: tinybench test/bench-consistency-async.test.ts:8 — a 50ms workload whose run counts are asserted", () => {
		// tinybench test/bench-consistency-async.test.ts lines 1-22.
		const content = [
			"import { expect, test } from 'vitest'",
			"",
			"import { Bench } from '../src'",
			"",
			"test('bench task runs and time consistency (async)', async () => {",
			"  const bench = new Bench({ iterations: 32, time: 100 })",
			"  bench.add('foo', async () => {",
			"    await new Promise(resolve => setTimeout(resolve, 50))",
			"  })",
			"",
			"  await bench.run()",
			"",
			"  const fooTask = bench.getTask('foo')",
			"  expect(fooTask).toBeDefined()",
			"  if (!fooTask) return",
			"  expect(fooTask.runs).toBeGreaterThanOrEqual(bench.iterations)",
			"  expect(fooTask.runs).toBe(fooTask.result.latency.samplesCount)",
			"})",
		].join("\n");
		expect(content.split("\n")[7]).toContain("setTimeout(resolve, 50)");
		expect(checkHardcodedTimeoutInTests(content, "test/bench-consistency-async.test.ts")).toEqual([]);
	});

	it("N6: tinybench test/bench-table-async.test.ts:8 — a 1ms async workload for the table test", () => {
		// tinybench test/bench-table-async.test.ts lines 1-17.
		const content = [
			"import { expect, test } from 'vitest'",
			"",
			"import { Bench } from '../src'",
			"",
			"test('bench table (async)', async () => {",
			"  const bench = new Bench({ iterations: 32, time: 100 })",
			"  bench.add('foo', async () => {",
			"    await new Promise(resolve => setTimeout(resolve, 1))",
			"  })",
			"",
			"  await bench.run()",
			"",
			"  const table = bench.table()",
			"  expect(table).toHaveLength(1)",
			"  if (table[0] == null) return",
			"  expect(table[0]['Task name']).toBe('foo')",
			"})",
		].join("\n");
		expect(content.split("\n")[7]).toContain("setTimeout(resolve, 1)");
		expect(checkHardcodedTimeoutInTests(content, "test/bench-table-async.test.ts")).toEqual([]);
	});

	it("N7: zod packages/zod/src/v4/classic/tests/codec.test.ts:539 — the decode hook simulates async work", () => {
		expect(ZOD_ASYNC_CODEC.split("\n")[4]).toContain("setTimeout(resolve, 1)");
		expect(linesFlagged(ZOD_ASYNC_CODEC, "packages/zod/src/v4/classic/tests/codec.test.ts")).not.toContain(5);
	});

	it("N8: zod packages/zod/src/v4/classic/tests/codec.test.ts:543 — the encode hook simulates async work", () => {
		expect(ZOD_ASYNC_CODEC.split("\n")[8]).toContain("setTimeout(resolve, 1)");
		expect(linesFlagged(ZOD_ASYNC_CODEC, "packages/zod/src/v4/classic/tests/codec.test.ts")).not.toContain(9);
	});

	it("N9: zod packages/zod/src/v4/mini/tests/codec.test.ts:458 — mini mirror of the decode hook", () => {
		expect(linesFlagged(ZOD_ASYNC_CODEC, "packages/zod/src/v4/mini/tests/codec.test.ts")).not.toContain(5);
	});

	it("N10: zod packages/zod/src/v4/mini/tests/codec.test.ts:462 — mini mirror of the encode hook", () => {
		expect(checkHardcodedTimeoutInTests(ZOD_ASYNC_CODEC, "packages/zod/src/v4/mini/tests/codec.test.ts")).toEqual([]);
	});

	// The sleep() family (added with this refinement) exposed the same class in
	// pmndrs/zustand: async fake-storage implementations that sleep to be
	// genuinely asynchronous. Not in the falsification set; pinned so the
	// regex extension does not open a new false-positive surface.
	it("N11: zustand tests/persistAsync.test.tsx:59 — an object-literal storage fake inside the test", () => {
		// zustand tests/persistAsync.test.tsx lines 56-62 (trimmed).
		const content = [
			"it('can rehydrate state', async () => {",
			"  const onRehydrateStorageSpy = vi.fn()",
			"  const storage = {",
			"    getItem: async (name: string) => {",
			"      await sleep(10)",
			"      return JSON.stringify({ state: { count: 42, name }, version: 0 })",
			"    },",
			"    setItem: () => {},",
			"    removeItem: () => {},",
			"  }",
			"})",
		].join("\n");
		expect(checkHardcodedTimeoutInTests(content, "tests/persistAsync.test.tsx")).toEqual([]);
	});

	it("N12: zustand tests/persistAsync.test.tsx:16 — a module-level storage factory's async methods", () => {
		// zustand tests/persistAsync.test.tsx lines 10-29.
		const content = [
			"const createPersistantStore = (initialValue: string | null) => {",
			"  let state = initialValue",
			"",
			"  const getItem = async (): Promise<string | null> => {",
			"    getItemSpy()",
			"    await sleep(10)",
			"    return state",
			"  }",
			"  const setItem = async (name: string, newState: string) => {",
			"    setItemSpy(name, newState)",
			"    await sleep(10)",
			"    state = newState",
			"  }",
			"}",
		].join("\n");
		expect(checkHardcodedTimeoutInTests(content, "tests/persistAsync.test.tsx")).toEqual([]);
	});

	it("N13: zustand tests/persistAsync.test.tsx:632 — a fake method assigned onto the storage stub, under fake timers", () => {
		// zustand tests/persistAsync.test.tsx lines 624-637 (trimmed).
		const content = [
			"it('rehydrates with the replaced getItem', async () => {",
			"  const useBoundStore = create(",
			"    persist(() => ({ count: 0 }), {",
			"      name: 'test-storage',",
			"      storage: createJSONStorage(() => storage),",
			"    }),",
			"  )",
			"",
			"  storage.getItem = async () => {",
			"    await sleep(10)",
			"    return storageValue",
			"  }",
			"  const rehydratePromise = useBoundStore.persist.rehydrate()",
			"  await act(() => vi.advanceTimersByTimeAsync(10))",
			"  await rehydratePromise",
			"})",
		].join("\n");
		expect(checkHardcodedTimeoutInTests(content, "tests/persistAsync.test.tsx")).toEqual([]);
	});
});

describe("hardcoded_timeout_in_tests — positive (must fire)", () => {
	it("P1: a bare await sleep(500) in the test body", () => {
		const content = [
			"it('settles the cache', async () => {",
			"  cache.refresh()",
			"  await sleep(500)",
			"  expect(cache.size).toBe(3)",
			"})",
		].join("\n");
		const m = checkHardcodedTimeoutInTests(content, "src/cache.test.ts");
		expect(m.map((x) => x.line)).toEqual([3]);
		expect(m[0]?.text).toContain("hardcoded 500ms wait in test");
	});

	it("P2: setTimeout(done, 1000) in the test's own flow", () => {
		const content = [
			"it('emits ready', (done) => {",
			"  server.start()",
			"  setTimeout(done, 1000)",
			"})",
		].join("\n");
		const m = checkHardcodedTimeoutInTests(content, "src/server.test.ts");
		expect(m.map((x) => x.line)).toEqual([3]);
		expect(m[0]?.text).toContain("hardcoded 1000ms wait in test");
	});

	it("P3: page.waitForTimeout(2000) in a Playwright test body", () => {
		const content = [
			"test('shows the toast', async ({ page }) => {",
			"  await page.click('#save')",
			"  await page.waitForTimeout(2000)",
			"  await expect(page.locator('.toast')).toBeVisible()",
			"})",
		].join("\n");
		const m = checkHardcodedTimeoutInTests(content, "e2e/toast.spec.ts");
		expect(m.map((x) => x.line)).toEqual([3]);
		expect(m[0]?.text).toContain("hardcoded 2000ms wait in test");
	});

	it("P4: a promise-executor sleep in the test body is still the test's own wait", () => {
		const content = [
			"test('flushes', async () => {",
			"  queue.push(1)",
			"  await new Promise(resolve => setTimeout(resolve, 250))",
			"  expect(queue.flushed).toBe(true)",
			"})",
		].join("\n");
		expect(checkHardcodedTimeoutInTests(content, "src/queue.test.ts").map((x) => x.line)).toEqual([3]);
	});

	it("P5: setTimeout(done, 1000) nested in an event callback still resolves the test itself", () => {
		const content = [
			"it('reconnects', (done) => {",
			"  client.on('close', () => {",
			"    setTimeout(done, 1000)",
			"  })",
			"})",
		].join("\n");
		expect(checkHardcodedTimeoutInTests(content, "src/client.test.ts").map((x) => x.line)).toEqual([3]);
	});
});
