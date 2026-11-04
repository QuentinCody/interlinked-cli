import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFastCheck, loadTsModule } from "./differential-fuzz-deps.js";
import { buildFuzzTarget, runDifferentialFuzz } from "./differential-fuzz.js";
import type { FuzzKillOutcome, FuzzOutcome } from "./differential-fuzz-types.js";

vi.mock("./differential-fuzz-deps.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./differential-fuzz-deps.js")>();
	return { ...actual, loadFastCheck: vi.fn(actual.loadFastCheck), loadTsModule: vi.fn(actual.loadTsModule) };
});

const dirs: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
	file: string;
	content: string;
}

function fixture(content: string, name = "subject.ts"): Fixture & { dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "il-fuzz-test-"));
	dirs.push(dir);
	const file = join(dir, name);
	writeFileSync(file, content);
	return { dir, file, content };
}

/** Build a target for the FIRST occurrence of `lexeme` in `content`. */
function targetOf(fx: Fixture, lexeme: string, replacement: string) {
	const startOffset = fx.content.indexOf(lexeme);
	if (startOffset === -1) throw new Error(`lexeme ${lexeme} not in fixture`);
	return buildFuzzTarget(fx.file, fx.content, {
		file: fx.file,
		mutator: "TestMutator",
		originalLexeme: lexeme,
		replacement,
		startOffset,
	});
}

async function fuzz(content: string, lexeme: string, replacement: string, config = {}): Promise<FuzzOutcome> {
	const fx = fixture(content);
	return runDifferentialFuzz(targetOf(fx, lexeme, replacement), { seed: 42, callTimeoutMs: 40, ...config });
}

function asKill(outcome: FuzzOutcome): FuzzKillOutcome {
	if (outcome.kind !== "kill") throw new Error(`expected kill, got ${outcome.kind}: ${JSON.stringify(outcome).slice(0, 300)}`);
	return outcome;
}

describe("differential-fuzz — positive (must fire)", () => {
	it("P1: a boundary mutant (< to <=) is killed with the exact boundary input as counterexample", async () => {
		const out = asKill(await fuzz("export function isSmall(n: number): boolean { return n < 10; }", "n < 10", "n <= 10"));
		expect(out.counterexample).toEqual([10]);
		expect(out.originalOutcome).toMatchObject({ threw: false, valueJson: "false" });
		expect(out.mutantOutcome).toMatchObject({ threw: false, valueJson: "true" });
	});

	it("P2: an arithmetic mutant (+ to -) is killed and the counterexample really diverges when replayed", async () => {
		const src = "export function add(a: number, b: number): number { return a + b; }";
		const out = asKill(await fuzz(src, "a + b", "a - b"));
		const [a = 0, b = 0] = out.counterexample as number[];
		expect(a + b).not.toBe(a - b);
		expect(out.params.map((p) => p.name)).toEqual(["a", "b"]);
		expect(out.regressionFixture).toContain("add(");
	});

	it("P3: the same seed reproduces the same counterexample and outcomes", async () => {
		const src = "export function add(a: number, b: number): number { return a + b; }";
		const first = asKill(await fuzz(src, "a + b", "a - b", { seed: 1234 }));
		const second = asKill(await fuzz(src, "a + b", "a - b", { seed: 1234 }));
		expect(second.counterexample).toEqual(first.counterexample);
		expect(second.originalOutcome).toEqual(first.originalOutcome);
		expect(second.mutantOutcome).toEqual(first.mutantOutcome);
		expect(first.seed).toBe(1234);
	});

	it("P4: a divergence in the thrown error message alone is a kill", async () => {
		const src = 'export function pos(n: number): number { if (n < 0) { throw new RangeError("negative"); } return n; }';
		const out = asKill(await fuzz(src, '"negative"', '""'));
		expect(out.originalOutcome).toMatchObject({ threw: true, errorName: "RangeError", errorMessage: "negative" });
		expect(out.mutantOutcome).toMatchObject({ threw: true, errorName: "RangeError", errorMessage: "" });
		expect(out.regressionFixture).toContain('toThrow("negative")');
	});

	it("P5: a mutant that loops forever is killed as a timeout instead of hanging the search", async () => {
		const src = "export function total(n: number): number { let t = 0; for (let i = 0; i < n; i++) { t += i; } return t; }";
		const out = asKill(await fuzz(src, "i++", "i--"));
		expect(out.mutantOutcome).toMatchObject({ threw: true, errorName: "ExecutionTimeout" });
		expect(out.originalOutcome.threw).toBe(false);
	});

	it("P6: a string-parameter mutant is killed using literals mined from the function body", async () => {
		const src = 'export function isAdmin(role: string): boolean { return role === "administrator"; }';
		const out = asKill(await fuzz(src, 'role === "administrator"', 'role !== "administrator"'));
		expect(out.params[0]?.typeText).toBe("string");
	});

	it("P7: a mutant behind an async function is killed by comparing the awaited value", async () => {
		const src = "export async function twice(n: number): Promise<number> { return n * 2; }";
		const out = asKill(await fuzz(src, "n * 2", "n * 3"));
		const [n] = out.counterexample as number[];
		expect(n).not.toBe(0);
	});

	it("P8: a function that mutates its argument is killed through the argument state", async () => {
		const src = "export function fill(xs: number[]): number { xs.push(1); return xs.length; }";
		const out = asKill(await fuzz(src, "xs.push(1)", "xs.push(2)"));
		expect(out.originalOutcome.argsAfterJson).not.toBe(out.mutantOutcome.argsAfterJson);
	});

	it("P9: relative imports are rewritten, so a target that imports a sibling module still runs", async () => {
		const fx = fixture('import { limit } from "./limits.mjs";\nexport function under(n: number): boolean { return n < limit; }');
		writeFileSync(join(fx.dir, "limits.mjs"), "export const limit = 3;\n");
		const out = await runDifferentialFuzz(targetOf(fx, "n < limit", "n <= limit"), { seed: 5, callTimeoutMs: 40 });
		expect(asKill(out).counterexample).toEqual([3]);
	});

	it("P10: buildFuzzTarget locates the enclosing exported function and carries identity fields", () => {
		const fx = fixture("export function add(a: number, b: number): number { return a + b; }");
		const target = targetOf(fx, "a + b", "a - b");
		expect(target.qualifiedName).toBe("add");
		expect(target.mutantId).toMatch(/^[0-9a-f]{16}$/);
		expect(target.startOffset).toBe(fx.content.indexOf("a + b"));
	});

	it("P11: a manifest-style target (no startOffset, only mutantId and ordinal) is re-located and killed", async () => {
		const fx = fixture("export function add(a: number, b: number): number { return a + b; }");
		const full = targetOf(fx, "a + b", "a - b");
		const { startOffset: _o, source: _s, ...manifestOnly } = full;
		const out = await runDifferentialFuzz(manifestOnly, { seed: 3, callTimeoutMs: 40 });
		expect(out.kind).toBe("kill");
	});
});

describe("differential-fuzz — non-exported top-level targets (synthetic export)", () => {
	const HIDDEN = "function isSmall(n: number): boolean { return n < 10; }\nexport const unrelated = 1;";

	it("P12: a non-exported boundary function (< to <=) is killed with a reproducible counterexample", async () => {
		const first = asKill(await fuzz(HIDDEN, "n < 10", "n <= 10", { seed: 7 }));
		const second = asKill(await fuzz(HIDDEN, "n < 10", "n <= 10", { seed: 7 }));
		expect(first.counterexample).toEqual([10]);
		expect(second.counterexample).toEqual(first.counterexample);
		expect(first.targetExported).toBe(false);
		expect(first.originalOutcome).toMatchObject({ valueJson: "false" });
		expect(first.regressionFixture).toContain("isSmall(10)");
		expect(first.regressionFixture).toContain("not exported");
	});

	it("P13: a non-exported module-level arrow const is killed", async () => {
		const src = "const add = (a: number, b: number): number => a + b;\nexport const unrelated = 1;";
		const out = asKill(await fuzz(src, "a + b", "a - b"));
		expect(out.targetExported).toBe(false);
		expect(out.params.map((p) => p.name)).toEqual(["a", "b"]);
	});

	it("P14: a non-exported function with a trailing line comment and no final newline still builds", async () => {
		const out = asKill(await fuzz("function isSmall(n: number): boolean { return n < 10; } // no newline", "n < 10", "n <= 10"));
		expect(out.counterexample).toEqual([10]);
	});

	it("N6: an equivalent mutant of a non-exported function stays no_divergence", async () => {
		const out = await fuzz("function same(x: number): number { return x * 1; }\nexport const unrelated = 1;", "x * 1", "x", { runs: 150 });
		expect(out).toMatchObject({ kind: "no_divergence", numRuns: 150, targetExported: false });
	});

	it("N7: an exported function reports targetExported true and its fixture carries no export note", async () => {
		const out = asKill(await fuzz("export function isSmall(n: number): boolean { return n < 10; }", "n < 10", "n <= 10"));
		expect(out.targetExported).toBe(true);
		expect(out.regressionFixture).not.toContain("not exported");
	});

	it("N8: an `export { fn as alias }` function is called through its alias, not the synthetic export", async () => {
		const out = asKill(await fuzz("function isSmall(n: number): boolean { return n < 10; }\nexport { isSmall as small };", "n < 10", "n <= 10"));
		expect(out.targetExported).toBe(true);
	});
});

describe("differential-fuzz — negative (must not fire)", () => {
	it("N1: x * 1 to x is equivalent: no divergence, with the budget and seed reported", async () => {
		const out = await fuzz("export function same(x: number): number { return x * 1; }", "x * 1", "x", { runs: 150 });
		expect(out).toMatchObject({ kind: "no_divergence", numRuns: 150, seed: 42, weakGeneration: false, dispositionWritten: false });
		expect(out.kind === "no_divergence" && out.dispositionNote).toContain("not proof");
	});

	it("N2: a mutant in a dead branch yields no_divergence", async () => {
		const src = "export function pick(x: number): number { if (x > 5 && x < 3) { return 1; } return 2; }";
		const out = await fuzz(src, "x > 5", "x >= 5");
		expect(out.kind).toBe("no_divergence");
	});

	it("N3: an equivalent string mutant (+ versus concat on a constant prefix) yields no_divergence", async () => {
		const src = 'export function tag(s: string): string { return "id:" + s; }';
		const out = await fuzz(src, '"id:" + s', '"id:".concat(s)');
		expect(out.kind).toBe("no_divergence");
	});

	it("N4: a time budget stops the search early without claiming divergence", async () => {
		const out = await fuzz("export function same(x: number): number { return x * 1; }", "x * 1", "x", {
			runs: 100000,
			timeBudgetMs: 150,
		});
		expect(out.kind).toBe("no_divergence");
		expect(out.kind === "no_divergence" && out.numRuns).toBeLessThan(100000);
		expect(out.kind === "no_divergence" && out.dispositionNote).toContain("time budget");
	});

	it("N5: -0 versus 0 is not a divergence (structural JSON semantics)", async () => {
		const out = await fuzz("export function zero(x: number): number { return x + 0; }", "x + 0", "x");
		expect(out.kind).toBe("no_divergence");
	});
});

describe("differential-fuzz — unsupported_target", () => {
	it("U1: a callback parameter is unsupported and the reason names the parameter", async () => {
		const out = await fuzz("export function run(cb: () => number): number { return cb() + 1; }", "cb() + 1", "cb() - 1");
		expect(out.kind).toBe("unsupported_target");
		expect(out.kind === "unsupported_target" && out.reason).toContain('"cb"');
	});

	it("U2: a class-instance parameter is unsupported and names the parameter", async () => {
		const out = await fuzz("export function year(d: Date): number { return d.getFullYear() + 1; }", "d.getFullYear() + 1", "d.getFullYear() - 1");
		expect(out.kind === "unsupported_target" && out.reason).toContain('"d"');
	});

	it("U3: a method of a non-exported class is still unsupported, with the original reason", async () => {
		const out = await fuzz("class Hidden { go(n: number): number { return n + 1; } }\nexport const k = 1;", "n + 1", "n - 1");
		expect(out.kind === "unsupported_target" && out.reason).toContain("not inside a named top-level function");
	});

	it("U3b: a file that already exports __fuzz_target__ is unsupported for a non-exported function", async () => {
		const src = "function hidden(n: number): number { return n + 1; }\nexport const __fuzz_target__ = 1;";
		const out = await fuzz(src, "n + 1", "n - 1");
		expect(out.kind === "unsupported_target" && out.reason).toContain("__fuzz_target__");
	});

	it("U4: a mutant in a class method is unsupported", async () => {
		const out = await fuzz("export class K { go(n: number): number { return n + 1; } }", "n + 1", "n - 1");
		expect(out.kind).toBe("unsupported_target");
	});

	it("U5: a function in the output is unsupported", async () => {
		const out = await fuzz("export function mk(n: number) { return () => n + 1; }", "n + 1", "n - 1");
		expect(out.kind === "unsupported_target" && out.reason).toContain("function");
	});

	it("U6: a non-deterministic pristine function is unsupported instead of a false kill", async () => {
		const out = await fuzz("export function jitter(x: number): number { return x + Math.random(); }", "x + Math.random()", "x - Math.random()");
		expect(out.kind === "unsupported_target" && out.reason).toContain("non-deterministic");
	});

	it("U7: source drift (the lexeme is no longer at the offset) is unsupported", async () => {
		const fx = fixture("export function add(a: number, b: number): number { return a + b; }");
		const target = { ...targetOf(fx, "a + b", "a - b"), startOffset: 2 };
		const out = await runDifferentialFuzz(target, { seed: 1 });
		expect(out.kind === "unsupported_target" && out.reason).toContain("source drift");
	});
});

describe("differential-fuzz — unavailable", () => {
	it("A1: fast-check missing reports unavailable naming fast-check", async () => {
		vi.mocked(loadFastCheck).mockResolvedValueOnce(null);
		const out = await fuzz("export function isSmall(n: number): boolean { return n < 10; }", "n < 10", "n <= 10");
		expect(out.kind === "unavailable" && out.reason).toContain("fast-check");
	});

	it("A2: typescript missing reports unavailable naming typescript", async () => {
		const fx = fixture("export function isSmall(n: number): boolean { return n < 10; }");
		const target = targetOf(fx, "n < 10", "n <= 10");
		vi.mocked(loadTsModule).mockReturnValueOnce(null);
		const out = await runDifferentialFuzz(target, { seed: 42 });
		expect(out.kind === "unavailable" && out.reason).toContain("typescript");
	});

	it("A3: a mutant whose source no longer parses is unavailable, not a crash", async () => {
		const out = await fuzz("export function isSmall(n: number): boolean { return n < 10; }", "n < 10", "n <<< ((");
		expect(out.kind === "unavailable" && out.reason).toContain("mutant");
	});
});
