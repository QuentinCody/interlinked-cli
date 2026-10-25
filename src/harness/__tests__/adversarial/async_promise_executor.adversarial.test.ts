// Independent adversarial review of the `async_promise_executor` pre_block
// check (2026-10-21). Eighteen candidate false positives were probed
// (scratch/2026-10-21-adversarial/async_promise_executor.probe.mts); none
// that fired was legitimate code, so the detector is unchanged. These cases
// pin the quiet candidates so a later "simplification" of the regex or of
// the shared literal stripper cannot reopen them.
import { describe, expect, it } from "vitest";
import { checkAsyncPromiseExecutor } from "../../checks/agent-safety-async.js";

describe("async_promise_executor — negative (must not fire)", () => {
	it("N1: an executor identifier that merely starts with `async`", () => {
		expect(checkAsyncPromiseExecutor("const p = new Promise(asyncHandler);", "src/x.ts")).toEqual([]);
		expect(checkAsyncPromiseExecutor("const p = new Promise(async_executor);", "src/x.ts")).toEqual([]);
	});

	it("N2: the pattern inside a template literal", () => {
		const src = "const doc = `avoid new Promise(async (r) => {})`;";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([]);
	});

	it("N3: the pattern inside a JSDoc @example", () => {
		const src = "/**\n * @example\n * new Promise(async (resolve) => {})\n */\nexport const x = 1;";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([]);
	});

	it("N4: a regex literal that itself matches the pattern (a lint rule's source)", () => {
		const src = "const RE = /new Promise\\(async/;\nexport const y = RE;";
		expect(checkAsyncPromiseExecutor(src, "src/lint.ts")).toEqual([]);
	});

	it("N5: a string that follows a regex containing a quote", () => {
		const src = 'const re = /"/;\nconst s = "new Promise(async (r) => r())";';
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([]);
	});

	it("N6: a JSX attribute string and a tagged template", () => {
		expect(checkAsyncPromiseExecutor('<Code title="new Promise(async (r) => {})" />', "src/x.tsx")).toEqual([]);
		expect(checkAsyncPromiseExecutor("const q = sql`select 'new Promise(async (r) => {})'`;", "src/x.ts")).toEqual([]);
	});

	it("N7: a look-alike constructor (`new MyPromise(async …)`)", () => {
		expect(checkAsyncPromiseExecutor("const p = new MyPromise(async (r) => r());", "src/x.ts")).toEqual([]);
	});
});

describe("async_promise_executor — positive (must fire)", () => {
	it("P1: an async arrow executor after a line comment on the previous line", () => {
		const src = "// build it\nconst p = new Promise(async (resolve) => { resolve(1); });";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([
			{ line: 2, text: "const p = new Promise(async (resolve) => { resolve(1); });" },
		]);
	});
});
