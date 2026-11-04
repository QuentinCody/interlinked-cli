import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTsModule } from "./differential-fuzz-deps.js";
import {
	UnsupportedOutputError,
	loadModulePair,
	outcomesEqual,
	renderValue,
	rewriteImports,
	summarizeCall,
} from "./differential-fuzz-execute.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "il-fuzz-exec-test-"));
	dirs.push(d);
	return d;
}

describe("differential-fuzz-execute — positive (must fire)", () => {
	it("P1: renderValue is structural: key order does not matter, NaN renders, -0 equals 0", () => {
		expect(renderValue({ b: 1, a: 2 })).toBe(renderValue({ a: 2, b: 1 }));
		expect(renderValue(Number.NaN)).toBe("NaN");
		expect(renderValue(-0)).toBe(renderValue(0));
		expect(renderValue([undefined, null, 5n, "x"])).toBe('[undefined,null,5n,"x"]');
	});

	it("P2: renderValue throws UnsupportedOutputError for a function nested in the output", () => {
		expect(() => renderValue({ cb: () => 1 })).toThrow(UnsupportedOutputError);
	});

	it("P3: summarizeCall records the thrown error's constructor name and message", async () => {
		const out = await summarizeCall(
			() => {
				throw new RangeError("too big");
			},
			[],
			200,
		);
		expect(out).toMatchObject({ threw: true, errorName: "RangeError", errorMessage: "too big" });
	});

	it("P4: summarizeCall awaits an async function's resolved value", async () => {
		const out = await summarizeCall(async (n: number) => n + 1, [4], 200);
		expect(out).toMatchObject({ threw: false, valueJson: "5" });
	});

	it("P5: summarizeCall turns a synchronous infinite loop into a timeout outcome instead of hanging", async () => {
		const out = await summarizeCall(
			() => {
				for (;;) {
					/* spin */
				}
			},
			[],
			50,
		);
		expect(out).toMatchObject({ threw: true, errorName: "ExecutionTimeout" });
	});

	it("P6: summarizeCall exposes argument mutation through argsAfterJson", async () => {
		const out = await summarizeCall((xs: number[]) => xs.push(9), [[1]], 200);
		expect(out.argsAfterJson).toBe("[[1,9]]");
	});

	it("P7: outcomesEqual separates a different value, a different error message, and a different arg state", async () => {
		const a = await summarizeCall(() => 1, [], 100);
		const b = await summarizeCall(() => 2, [], 100);
		expect(outcomesEqual(a, b)).toBe(false);
		const e1 = await summarizeCall(() => { throw new Error("a"); }, [], 100);
		const e2 = await summarizeCall(() => { throw new Error("b"); }, [], 100);
		expect(outcomesEqual(e1, e2)).toBe(false);
		const m1 = await summarizeCall((x: number[]) => x.length, [[1]], 100);
		const m2 = await summarizeCall((x: number[]) => { x.pop(); return 1; }, [[1]], 100);
		expect(outcomesEqual(m1, m2)).toBe(false);
	});

	it("P8: loadModulePair imports both modules under distinct names and dispose removes the temp dir", async () => {
		const pair = await loadModulePair("export const v = 1;", "export const v = 2;");
		expect([pair.pristine.v, pair.mutant.v]).toEqual([1, 2]);
		pair.dispose();
		expect(existsSync(pair.dir)).toBe(false);
	});

	it("P9: rewriteImports makes relative specifiers absolute so the temp-dir copy resolves them", () => {
		const ts = loadTsModule();
		if (ts === null) throw new Error("typescript required");
		const out = rewriteImports(ts, 'import { x } from "./helper.mjs";\nexport const y = x;', "/repo/src/mod.ts");
		expect(out).toContain('"/repo/src/helper.mjs"');
	});

	it("P10: a module with a relative import loads from the temp dir after the rewrite", async () => {
		const ts = loadTsModule();
		if (ts === null) throw new Error("typescript required");
		const dir = tmp();
		writeFileSync(join(dir, "helper.mjs"), "export const x = 41;\n");
		const src = rewriteImports(ts, 'import { x } from "./helper.mjs";\nexport const y = x + 1;', join(dir, "mod.ts"));
		const pair = await loadModulePair(src, src);
		expect(pair.pristine.y).toBe(42);
		pair.dispose();
	});
});

describe("differential-fuzz-execute — negative (must not fire)", () => {
	it("N1: identical behaviour compares equal even when the objects are distinct", async () => {
		const a = await summarizeCall((n: number) => ({ n, list: [n] }), [3], 100);
		const b = await summarizeCall((n: number) => ({ list: [n], n }), [3], 100);
		expect(outcomesEqual(a, b)).toBe(true);
	});

	it("N2: NaN results compare equal to NaN results", async () => {
		const a = await summarizeCall(() => Number.NaN, [], 100);
		const b = await summarizeCall(() => 0 / 0, [], 100);
		expect(outcomesEqual(a, b)).toBe(true);
	});

	it("N3: two timeouts are the same observable", async () => {
		const spin = () => {
			for (;;) {
				/* spin */
			}
		};
		const a = await summarizeCall(spin, [], 30);
		const b = await summarizeCall(spin, [], 30);
		expect(outcomesEqual(a, b)).toBe(true);
	});

	it("N4: rewriteImports leaves type-only imports and node builtins untouched", () => {
		const ts = loadTsModule();
		if (ts === null) throw new Error("typescript required");
		const src = 'import type { T } from "./types.js";\nimport { join } from "node:path";\nexport const j = join;';
		expect(rewriteImports(ts, src, "/repo/src/mod.ts")).toBe(src);
	});

	it("N5: a stack trace never leaks into the summary", async () => {
		const out = await summarizeCall(() => { throw new Error("boom"); }, [], 100);
		expect(JSON.stringify(out)).not.toContain(" at ");
	});
});
