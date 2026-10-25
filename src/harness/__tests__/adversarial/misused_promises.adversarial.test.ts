// Independent adversarial false-positive review of `misused_promises`
// (pre_block). Each negative case is idiomatic code a reviewer accepts; it
// fired before the 2026-10-21 refinement. Probe:
// scratch/2026-10-21-adversarial/misused_promises.probe.mts
import { describe, expect, it } from "vitest";
import { checkMisusedPromises } from "../../checks/agent-safety-async.js";

describe("misused_promises — negative (must not fire)", () => {
	it("N1: sequential promise-chain reduce seeded with Promise.resolve()", () => {
		const src = [
			"export function runSequentially(tasks: Array<() => Promise<void>>) {",
			"  return tasks.reduce(async (prev, task) => {",
			"    await prev;",
			"    await task();",
			"  }, Promise.resolve());",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/pipeline.ts")).toEqual([]);
	});

	it("N2: promise-chain reduce whose accumulator is awaited, seed on a later line", () => {
		const src = [
			"const result = migrations.reduce(async (acc, m) => {",
			"  const state = await acc;",
			"  return m.apply(state);",
			"},",
			"Promise.resolve(initialState));",
		].join("\n");
		expect(checkMisusedPromises(src, "src/migrate.ts")).toEqual([]);
	});

	it("N3: promise-chain reduce chaining the accumulator with .then", () => {
		const src = [
			"export const chain = (steps) =>",
			"  steps.reduce(async (prev, step) => prev.then(() => step()), Promise.resolve());",
		].join("\n");
		expect(checkMisusedPromises(src, "src/chain.ts")).toEqual([]);
	});

	it("N4: awaited stream/promises forEach with an async callback and concurrency", () => {
		const src = [
			"import { Readable } from 'node:stream';",
			"export async function ingest(readable: Readable) {",
			"  await readable.forEach(async (chunk) => {",
			"    await store(chunk);",
			"  }, { concurrency: 4 });",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/ingest.ts")).toEqual([]);
	});

	it("N5: awaited forEach on a receiver reached through a closed call in the chain", () => {
		const src = "await getStream(path).forEach(async (chunk) => { await store(chunk); });";
		expect(checkMisusedPromises(src, "src/ingest2.ts")).toEqual([]);
	});

	it("N6: the pattern inside a template literal with interpolation is not code", () => {
		const src = [
			"export function emit(body: string) {",
			"  return `items.forEach(async (i) => { ${body} })`;",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/codegen.ts")).toEqual([]);
	});

	it("N7: a regex literal matching the anti-pattern is not code", () => {
		const src = "const RULE = /\\.(forEach|reduce)\\s*\\(\\s*async\\b/;";
		expect(checkMisusedPromises(src, "src/lint.ts")).toEqual([]);
	});

	// Round 2 (same day, against the round-1 refinement).
	it("N8: an awaited multi-line node:stream chain ending in .forEach(async)", () => {
		const src = [
			"export async function ingest(readable) {",
			"  await readable",
			"    .filter((chunk) => chunk.length > 0)",
			"    .forEach(async (chunk) => {",
			"      await store(chunk);",
			"    });",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/ingest3.ts")).toEqual([]);
	});

	it("N9: an awaited stream chain whose earlier call has a nested-paren callback", () => {
		const src = "await readable.map((x) => transform(x)).forEach(async (y) => { await store(y); });";
		expect(checkMisusedPromises(src, "src/ingest4.ts")).toEqual([]);
	});

	it("N10: JSX text in a docs page that names the anti-pattern is prose", () => {
		const src = [
			"export function Rule() {",
			"  return <li>Avoid xs.forEach(async fn) in request handlers.</li>;",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/docs/Rule.tsx")).toEqual([]);
	});
});

describe("misused_promises — positive (must fire)", () => {
	it("P1: Array.prototype.forEach(async …) at statement position", () => {
		const src = ["const xs = [1];", "xs.forEach(async (x) => {", "  await x;", "});"].join("\n");
		expect(checkMisusedPromises(src, "src/bad.ts")).toEqual([
			{ line: 2, text: "xs.forEach(async (x) => {" },
		]);
	});

	it("P2: reduce(async …) seeded with a non-promise is not the chain idiom", () => {
		const src = "xs.reduce(async (acc, x) => acc, []);";
		expect(checkMisusedPromises(src, "src/bad2.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P3: reduce(async …) that awaits something other than the accumulator still fires", () => {
		const src = "const n = xs.reduce(async (acc, x) => acc + (await fetchCount(x)), 0);";
		expect(checkMisusedPromises(src, "src/bad3.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P4: an `await` wrapping a different call does not exempt an inner forEach(async)", () => {
		const src = "await Promise.all(xs.forEach(async (x) => { await x; }));";
		expect(checkMisusedPromises(src, "src/bad4.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P5: a bare forEach(async) that is merely returned still fires", () => {
		const src = "return xs.forEach(async (x) => { await x; });";
		expect(checkMisusedPromises(src, "src/bad5.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P6: a multi-line chain with no await still fires on the .forEach line", () => {
		const src = ["xs", "  .filter(Boolean)", "  .forEach(async (x) => {", "    await x;", "  });"].join("\n");
		expect(checkMisusedPromises(src, "src/bad6.ts")).toEqual([
			{ line: 3, text: ".forEach(async (x) => {" },
		]);
	});

	it("P7: an await on an enclosing call does not exempt a chain inside its arguments", () => {
		const src = "await Promise.all(xs.filter(Boolean).forEach(async (x) => { await x; }));";
		expect(checkMisusedPromises(src, "src/bad7.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P8: JSX blanking does not hide a real forEach(async) in a component's code", () => {
		const src = [
			"export function List({ xs }) {",
			"  xs.forEach(async (x) => { await save(x); });",
			"  return <ul />;",
			"}",
		].join("\n");
		expect(checkMisusedPromises(src, "src/List.tsx")).toEqual([
			{ line: 2, text: "xs.forEach(async (x) => { await save(x); });" },
		]);
	});
});
