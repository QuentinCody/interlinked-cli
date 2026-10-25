// Independent false-positive review of `floating_promises` (pre_warn) against
// CONFIRMED false positives found on real foreign repositories (2026-10-21
// cross-repo run: scratch/2026-10-21-cross-repo/falsify-result.json). Every
// negative case is a trimmed REAL snippet, attributed in a comment; each fired
// before the refinement. The positive cases pin the bug class so none of the
// fixes can be a blanket exemption.
import { describe, expect, it } from "vitest";
import { checkFloatingPromises } from "../../checks/agent-safety-async.js";

describe("floating_promises — negative (must not fire)", () => {
	it("N1: tinybench src/task.ts:500 — file-wide async-id set has no scope: a sync local sharing its name with an async local elsewhere", () => {
		// tinybench src/task.ts — `async run()` declares `const benchmarkTask = async () =>`
		// (line 389); `runSync()` declares a SYNC `const benchmarkTask = () =>` (466)
		// and calls it in a while loop (500).
		const src = [
			"export class Task {",
			"  async run() {",
			"    const benchmarkTask = async () => {",
			"      if (this.aborted) {",
			"        return",
			"      }",
			"    }",
			"    await benchmarkTask()",
			"  }",
			"  runSync() {",
			"    let totalTime = 0",
			"    const samples: number[] = []",
			"    const benchmarkTask = () => {",
			"      if (this.aborted) {",
			"        return",
			"      }",
			"      const idx = samples.push(1) - 1",
			"      totalTime += idx",
			"    }",
			"    while (totalTime < 10 && !this.aborted) {",
			"      benchmarkTask()",
			"    }",
			"  }",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/task.ts")).toEqual([]);
	});

	it("N2: ky source/utils/body.ts:149 — shorthand method definition `value() {` after a line ending in `{`", () => {
		// ky source/utils/body.ts — `async value()` (126) inside Object.defineProperty,
		// then `clone: { value() { … }, writable: true }` inside Object.defineProperties.
		const src = [
			"export function copyResponseMetadata(response, originalResponse) {",
			"  Object.defineProperty(response, type, {",
			"    async value() {",
			"      try {",
			"        return await nativeMethod();",
			"      } catch (error) {",
			"        throw getError() ?? error;",
			"      }",
			"    },",
			"    writable: true,",
			"  });",
			"  Object.defineProperties(response, {",
			"    url: {value: originalResponse.url},",
			"    clone: {",
			"      value() {",
			"        const clone = nativeClone();",
			"        return copyResponseMetadata(clone, response);",
			"      },",
			"      writable: true,",
			"      configurable: true,",
			"    },",
			"  });",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "source/utils/body.ts")).toEqual([]);
	});

	it("N3: ky source/utils/timeout.ts:33 — multi-line `.then(cb => {\\n…\\n}).catch(reject)` is handled on the close line", () => {
		// ky source/utils/timeout.ts — inside a Promise executor; the chain closes
		// with `}).catch(reject);` and the outer promise is awaited by timeout().
		const src = [
			"export default async function timeout(request, init, abortController, options) {",
			"  let timeoutId;",
			"  try {",
			"    return await new Promise((resolve, reject) => {",
			"      let timedOut = false;",
			"      timeoutId = setTimeout(() => {",
			"        timedOut = true;",
			"        reject(new TimeoutError(request));",
			"      }, options.timeout);",
			"      const {fetch} = options;",
			"      fetch(request, init).then(response => {",
			"        if (timedOut) {",
			"          cancelBody(response);",
			"          return;",
			"        }",
			"        resolve(response);",
			"      }).catch(reject);",
			"    });",
			"  } finally {",
			"    clearTimeout(timeoutId);",
			"  }",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "source/utils/timeout.ts")).toEqual([]);
	});

	it("N4: ky test/fetch.ts:418 — shorthand `cancel() {` in a ReadableStream source; also a top-level `test/` directory", () => {
		// ky test/fetch.ts — `new ReadableStream({ cancel() { cancelled = true; } })` (418)
		// and an unrelated `async cancel()` in a later test (452).
		const src = [
			"test('a response returned after fetch timeout', async t => {",
			"  let cancelled = false;",
			"  const response = new Response(new ReadableStream({",
			"    cancel() {",
			"      cancelled = true;",
			"    },",
			"  }));",
			"  t.true(cancelled);",
			"});",
			"test('cancellation rejects', async t => {",
			"  let cancellations = 0;",
			"  const response = new Response(new ReadableStream({",
			"    async cancel() {",
			"      cancellations++;",
			"      throw new Error('cancellation failed');",
			"    },",
			"  }));",
			"});",
		].join("\n");
		expect(checkFloatingPromises(src, "test/fetch.ts")).toEqual([]);
		// The shape itself is a declaration, so it is silent outside test/ as well.
		expect(checkFloatingPromises(src, "source/fetch.ts")).toEqual([]);
	});

	it("N5: ky test/hooks.ts:1002 — sync shorthand `parseJson(text) {` option beside an `async parseJson` in another test", () => {
		// ky test/hooks.ts — ky.get(url, { parseJson(text) { … } }) (1002); other
		// tests in the file declare `async parseJson(text)` (1468, 1512).
		const src = [
			"const json = await ky",
			"  .get(server.url, {",
			"    parseJson(text) {",
			"      t.is(text, 'text');",
			"      return {awesome: true};",
			"    },",
			"  })",
			"  .json();",
			"const other = await ky.get(server.url, {",
			"  async parseJson(text) {",
			"    return JSON.parse(text);",
			"  },",
			"});",
		].join("\n");
		expect(checkFloatingPromises(src, "test/hooks.ts")).toEqual([]);
		expect(checkFloatingPromises(src, "source/hooks.ts")).toEqual([]);
	});

	it("N6: ky test/http-error.ts:160 — sync shorthand `parseJson(text) {` whose body mutates and returns", () => {
		// ky test/http-error.ts — ky.get(url, { parseJson(text) { … } }) (160);
		// `async parseJson` declared at 198, 220, 238.
		const src = [
			"const error = await t.throwsAsync(ky.get(server.url, {",
			"  parseJson(text) {",
			"    const data = JSON.parse(text);",
			"    data.custom = true;",
			"    return data;",
			"  },",
			"}));",
			"const instance = ky.create({",
			"  async parseJson(text) {",
			"    return JSON.parse(text);",
			"  },",
			"});",
		].join("\n");
		expect(checkFloatingPromises(src, "test/http-error.ts")).toEqual([]);
		expect(checkFloatingPromises(src, "source/http-error.ts")).toEqual([]);
	});

	it("N7: ky test/main.ts:490 — sync shorthand `parseJson() {` whose body only throws", () => {
		// ky test/main.ts — ky.create({ parseJson() { throw … }, stringifyJson() { … } })
		// (490); async parseJson declared at 1412, 4086, 4146, 4178.
		const src = [
			"const instance = ky.create({",
			"  parseJson() {",
			"    throw new Error('Inherited parseJson must not run');",
			"  },",
			"  stringifyJson() {",
			"    throw new Error('Inherited stringifyJson must not run');",
			"  },",
			"}).extend({parseJson: undefined, stringifyJson: undefined});",
			"const withAsync = ky.create({",
			"  async parseJson(text) {",
			"    return JSON.parse(text);",
			"  },",
			"});",
		].join("\n");
		expect(checkFloatingPromises(src, "test/main.ts")).toEqual([]);
		expect(checkFloatingPromises(src, "source/main.ts")).toEqual([]);
	});

	// zod packages/zod/src/v4/classic/schemas.ts — `export interface ZodType` (34)
	// holds multi-line method signatures; the class impl declares the async
	// methods (`async safeParseAsync(data, params)` 306, `async safeEncodeAsync`
	// 340, `async safeDecodeAsync` 343).
	const ZOD_INTERFACE = [
		"export interface ZodType<out Output = unknown, out Input = unknown> extends core.$ZodType<Output, Input> {",
		"  def: Internals['def'];",
		"  parseAsync(data: unknown, params?: core.ParseContext<core.$ZodIssue>): Promise<core.output<this>>;",
		"  safeParseAsync(",
		"    data: unknown,",
		"    params?: core.ParseContext<core.$ZodIssue>",
		"  ): Promise<parse.ZodSafeParseResult<core.output<this>>>;",
		"  safeEncodeAsync(",
		"    data: core.output<this>,",
		"    params?: core.ParseContext<core.$ZodIssue>",
		"  ): Promise<parse.ZodSafeParseResult<core.input<this>>>;",
		"  safeDecodeAsync(",
		"    data: core.input<this>,",
		"    params?: core.ParseContext<core.$ZodIssue>",
		"  ): Promise<parse.ZodSafeParseResult<core.output<this>>>;",
		"}",
		"export const ZodType = core.$constructor('ZodType', (inst, def) => {",
		"    inst.safeParse = (data, params) => {",
		"      return parse.safeParse(this, data, params);",
		"    },",
		"    async safeParseAsync(data, params) {",
		"      return parse.safeParseAsync(this, data, params);",
		"    },",
		"    async safeEncodeAsync(data, params) {",
		"      return parse.safeEncodeAsync(this, data, params);",
		"    },",
		"    async safeDecodeAsync(data, params) {",
		"      return parse.safeDecodeAsync(this, data, params);",
		"    },",
		"});",
	].join("\n");

	it("N8: zod schemas.ts:74 — multi-line interface signature `safeParseAsync(\\n…\\n): Promise<…>;`", () => {
		const out = checkFloatingPromises(ZOD_INTERFACE, "packages/zod/src/v4/classic/schemas.ts");
		expect(out.filter((m) => m.text.startsWith("safeParseAsync"))).toEqual([]);
	});

	it("N9: zod schemas.ts:98 — multi-line interface signature `safeEncodeAsync(\\n…\\n): Promise<…>;`", () => {
		const out = checkFloatingPromises(ZOD_INTERFACE, "packages/zod/src/v4/classic/schemas.ts");
		expect(out.filter((m) => m.text.startsWith("safeEncodeAsync"))).toEqual([]);
	});

	it("N10: zod schemas.ts:102 — multi-line interface signature `safeDecodeAsync(\\n…\\n): Promise<…>;` (whole fixture silent)", () => {
		expect(checkFloatingPromises(ZOD_INTERFACE, "packages/zod/src/v4/classic/schemas.ts")).toEqual(
			[],
		);
	});
});

describe("floating_promises — positive (must fire)", () => {
	it("P1: a multi-line `.then(cb => {\\n…\\n})` chain with NO handler on its own chain still fires", () => {
		const src = [
			"async function load() { return 1; }",
			"function start() {",
			"  load().then(result => {",
			"    console.log(result);",
			"  });",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/start.ts")).toEqual([
			{ line: 3, text: "load().then(result => {" },
		]);
	});

	it("P2: a `.catch` nested INSIDE the then-callback does not handle the outer chain", () => {
		const src = [
			"async function load() { return 1; }",
			"async function other() { return 2; }",
			"function start() {",
			"  load().then(() => {",
			"    other().catch(console.error);",
			"  });",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/nested.ts")).toEqual([
			{ line: 4, text: "load().then(() => {" },
		]);
	});

	it("P3: a multi-line argument list is a call, not a signature — it still fires", () => {
		const src = [
			"async function sync(a: number, b: number) { return a + b; }",
			"function start() {",
			"  sync(",
			"    1,",
			"    2,",
			"  );",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/multi.ts")).toEqual([{ line: 3, text: "sync(" }]);
	});

	it("P4: an id declared async only is still flagged when a DIFFERENT name has a sync shorthand definition", () => {
		const src = [
			"const options = {",
			"  parseJson(text) {",
			"    return JSON.parse(text);",
			"  },",
			"  async fetchJson(url) {",
			"    return fetch(url);",
			"  },",
			"};",
			"function warm() {",
			"  options.fetchJson('/x');",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/warm.ts")).toEqual([
			{ line: 10, text: "options.fetchJson('/x');" },
		]);
	});

	it("P5: a directory merely CONTAINING 'test' (contest/, testutil/) is not a test directory", () => {
		const src = ["async function main() { return; }", "main();"].join("\n");
		expect(checkFloatingPromises(src, "contest/main.ts")).toHaveLength(1);
		expect(checkFloatingPromises(src, "src/testutil/main.ts")).toHaveLength(1);
	});

	it("P6: an interface signature for an async method does not shadow the async declaration", () => {
		const src = [
			"interface Api {",
			"  save(data: unknown): Promise<void>;",
			"}",
			"class Impl implements Api {",
			"  async save(data: unknown) { return; }",
			"  run() {",
			"    this.save(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/api.ts")).toEqual([
			{ line: 7, text: "this.save(1);" },
		]);
	});

	// Repairs: shapes the previous refinement exempted although they are not in
	// the blind spot (independent verifier, refine-result.json rescan evidence).
	it("P7: repair — a TS overload row `function load(x): Promise<…>;` is not a sync declaration", () => {
		const src = [
			"export function load(x: string): Promise<string>;",
			"export function load(x: number): Promise<number>;",
			"export async function load(x: any) { return x; }",
			"function start() {",
			'  load("a");',
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/load.ts")).toEqual([{ line: 5, text: 'load("a");' }]);
	});

	it("P8: repair — a call whose statement does not close within the span bound still fires", () => {
		const body = Array.from({ length: 65 }, (_, k) => `    console.log(${k});`);
		const src = [
			"async function save(n: number, cb: () => void) { cb(); return n; }",
			"function start() {",
			"  save(1, () => {",
			...body,
			"  });",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/save.ts")).toEqual([
			{ line: 3, text: "save(1, () => {" },
		]);
	});

	it("P9: repair — a sync local named like a built-in in ANOTHER function does not hide the built-in", () => {
		const src = [
			"function a() {",
			'  fetch("/x");',
			"}",
			"function b() {",
			"  const fetch = (u: string) => u;",
			'  return fetch("y");',
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/net.ts")).toEqual([{ line: 2, text: 'fetch("/x");' }]);
	});

	it("P10: repair — an unrelated sync object-literal method `start() {}` does not hide a class `async start()`", () => {
		const src = [
			"class Runner {",
			"  async start() {",
			"    return;",
			"  }",
			"}",
			"const hooks = {",
			"  start() {",
			"    return 1;",
			"  },",
			"};",
			"function go(a: Runner) {",
			"  a.start();",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/runner.ts")).toEqual([{ line: 12, text: "a.start();" }]);
	});
});
