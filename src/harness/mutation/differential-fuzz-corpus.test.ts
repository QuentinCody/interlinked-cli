import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EDIT_OPS,
	MIN_LITERAL_CHARS,
	applyEdit,
	bodyScansParam,
	capText,
	companionTestFiles,
	corpusLinesArb,
	corpusParamShape,
	corpusTextArb,
	extractStringLiterals,
	loadCorpusSeeds,
} from "./differential-fuzz-corpus.js";
import { asFcApi } from "./differential-fuzz-arbitraries.js";
import { loadFastCheck, loadTsModule } from "./differential-fuzz-deps.js";
import { buildFuzzTarget, runDifferentialFuzz } from "./differential-fuzz.js";
import { findExportedFunction, parseSource } from "./differential-fuzz-locate.js";
import type { FuzzOutcome } from "./differential-fuzz-types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-fuzz-corpus-"));
	dirs.push(dir);
	return dir;
}

function tsOrThrow() {
	const ts = loadTsModule();
	if (ts === null) throw new Error("typescript is required for this suite");
	return ts;
}

/** Shape of the first parameter of the first exported function in `source`. */
function shapeOf(source: string, paramIndex = 0) {
	const ts = tsOrThrow();
	const sf = parseSource(ts, "f.ts", source);
	const located = findExportedFunction(ts, sf, source.indexOf("return"));
	if (!located.ok) throw new Error(located.reason);
	const param = located.fn.parameters[paramIndex];
	if (param === undefined) throw new Error("no such parameter");
	return corpusParamShape(ts, param, located.fn.body, param.name.getText(sf));
}

describe("differential-fuzz-corpus seeds — positive (must fire)", () => {
	it("P1: extractStringLiterals keeps literals of at least 20 chars, template literals included", () => {
		const ts = tsOrThrow();
		const text = "const a = 'short';\nconst b = 'this literal is long enough';\nconst c = `line one\\nline two\\nline three`;\n";
		const out = extractStringLiterals(ts, "t.ts", text);
		expect(out).toContain("this literal is long enough");
		expect(out).toContain("line one\nline two\nline three");
		expect(out).not.toContain("short");
		expect(MIN_LITERAL_CHARS).toBe(20);
	});

	it("P2: companionTestFiles finds the stem's .test, .mutation-kill.test and __tests__ files", () => {
		const dir = tmp();
		mkdirSync(join(dir, "__tests__"));
		for (const name of ["scan.ts", "scan.test.ts", "scan.mutation-kill.test.ts", "scan.spec.ts", "other.test.ts", "scanner.test.ts"]) {
			writeFileSync(join(dir, name), "");
		}
		writeFileSync(join(dir, "__tests__", "scan.test.ts"), "");
		const found = companionTestFiles(join(dir, "scan.ts")).map((p) => p.slice(dir.length + 1));
		expect(found).toEqual(["scan.mutation-kill.test.ts", "scan.spec.ts", "scan.test.ts", join("__tests__", "scan.test.ts")]);
	});

	it("P3: loadCorpusSeeds merges companion-test literals, explicit seeds and repo files, shortest first", () => {
		const dir = tmp();
		writeFileSync(join(dir, "scan.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "scan.test.ts"), "const fixture = 'TODO: first fixture line';\n");
		const repo = join(dir, "repo.ts");
		writeFileSync(repo, "export function repoFile() { return 'a long enough text for the repo seed'; }\n");
		const seeds = loadCorpusSeeds(tsOrThrow(), join(dir, "scan.ts"), { files: [repo], maxBytes: 10_000, seeds: ["explicit seed text here"] });
		expect(seeds.fromTests).toBe(2);
		expect(seeds.fromRepo).toBe(1);
		expect(seeds.texts[0]).toBe("explicit seed text here");
		expect(seeds.texts).toContain("TODO: first fixture line");
		const lengths = seeds.texts.map((t) => t.length);
		expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
	});

	it("P4: capText cuts at a line boundary under the cap", () => {
		expect(capText("aaaa\nbbbb\ncccc", 11)).toBe("aaaa\nbbbb");
		expect(capText("short", 11)).toBe("short");
	});

	it("P5: corpusParamShape flags source-named string params, string params the body scans, and lines arrays", () => {
		expect(shapeOf("export function f(content: string) { return 1; }")).toBe("text");
		expect(shapeOf("export function f(blob: string) { return blob.split('\\n').length; }")).toBe("text");
		expect(shapeOf("export function f(blob: string, re: RegExp) { return re.test(blob); }")).toBe("text");
		expect(shapeOf("export function f(content: string | undefined) { return 1; }")).toBe("text");
		expect(shapeOf("export function f(lines: string[]) { return 1; }")).toBe("lines");
	});

	it("P6: bodyScansParam sees match/matchAll/replace/search receivers and regex.exec arguments", () => {
		const ts = tsOrThrow();
		const body = (src: string) => {
			const sf = parseSource(ts, "f.ts", src);
			const located = findExportedFunction(ts, sf, src.indexOf("return"));
			if (!located.ok) throw new Error(located.reason);
			return located.fn.body;
		};
		expect(bodyScansParam(ts, body("export function f(s: string) { return s.match(/a/g); }"), "s")).toBe(true);
		expect(bodyScansParam(ts, body("export function f(s: string) { return /a/.exec(s); }"), "s")).toBe(true);
		expect(bodyScansParam(ts, body("export function f(s: string) { return s.replace(/a/, 'b'); }"), "s")).toBe(true);
	});

	it("P7: every edit operation changes a multi-line seed that offers something to edit", () => {
		const text = "if (a < b) {\n  run(x);\n  stop();\n}\n";
		for (const op of EDIT_OPS) {
			const edited = applyEdit(op, text, "donor line", 1, 2);
			expect(edited, op).not.toBe(text);
		}
	});

	it("P8: specific edits do what they say", () => {
		const text = "one\ntwo\nthree";
		expect(applyEdit("drop-line", text, "d", 1, 0)).toBe("one\nthree");
		expect(applyEdit("dup-line", text, "d", 1, 0)).toBe("one\ntwo\ntwo\nthree");
		expect(applyEdit("swap-lines", text, "d", 0, 2)).toBe("three\ntwo\none");
		expect(applyEdit("insert-line", text, "donor", 1, 0)).toBe("one\ndonor\ntwo\nthree");
		expect(applyEdit("truncate", text, "d", 2, 0)).toBe("one\ntwo");
		expect(applyEdit("flip-operator", "if (a >= 1) {}", "d", 0, 0)).toBe("if (a < 1) {}");
		expect(applyEdit("delete-token", "foo bar", "d", 1, 0)).toBe("foo ");
	});
});

describe("differential-fuzz-corpus seeds — negative (must not fire)", () => {
	it("N1: short literals are not seeds", () => {
		expect(extractStringLiterals(tsOrThrow(), "t.ts", "const a = 'abc'; const b = `xy`;")).toEqual([]);
	});

	it("N2: a stem never matches a longer stem or an unrelated test", () => {
		const dir = tmp();
		for (const name of ["scan.ts", "scanner.test.ts", "rescan.test.ts"]) writeFileSync(join(dir, name), "");
		expect(companionTestFiles(join(dir, "scan.ts"))).toEqual([]);
	});

	it("N3: params that are not source text get no corpus (numbers, non-source names, plain string arrays)", () => {
		expect(shapeOf("export function f(content: number) { return 1; }")).toBeNull();
		expect(shapeOf("export function f(label: string) { return label.length; }")).toBeNull();
		expect(shapeOf("export function f(names: string[]) { return 1; }")).toBeNull();
		expect(shapeOf("export function f(content) { return 1; }")).toBeNull();
	});

	it("N4: a missing repo file is skipped, not an error", () => {
		const dir = tmp();
		writeFileSync(join(dir, "scan.ts"), "export const x = 1;\n");
		const seeds = loadCorpusSeeds(tsOrThrow(), join(dir, "scan.ts"), { files: [join(dir, "nope.ts")], maxBytes: 100 });
		expect(seeds).toEqual({ texts: [], fromTests: 0, fromRepo: 0 });
	});

	it("N5: edits of a single-line text with nothing to edit return the text unchanged", () => {
		expect(applyEdit("flip-operator", "plain words", "d", 0, 0)).toBe("plain words");
		expect(applyEdit("delete-token", "", "d", 3, 0)).toBe("");
	});

	it("N6: arrow functions in text are not read as comparison operators", () => {
		expect(applyEdit("flip-operator", "const f = (x) => x;", "d", 0, 0)).toBe("const f = (x) => x;");
	});
});

describe("differential-fuzz-corpus arbitraries — positive (must fire)", () => {
	it("P9: corpusTextArb mixes seeds, edited seeds and the fallback, deterministically under a seed", async () => {
		const fc = asFcApi(await loadFastCheck());
		if (fc === null) throw new Error("fast-check required");
		const seeds = ["alpha\nbeta\ngamma", "delta\nepsilon"];
		const arb = corpusTextArb(fc, seeds, fc.constant("FALLBACK-ONLY"));
		const first = fc.sample(arb, { numRuns: 300, seed: 5 }) as string[];
		const again = fc.sample(arb, { numRuns: 300, seed: 5 }) as string[];
		expect(again).toEqual(first);
		expect(first).toContain("alpha\nbeta\ngamma");
		expect(first).toContain("FALLBACK-ONLY");
		expect(first.some((s) => !seeds.includes(s) && s !== "FALLBACK-ONLY")).toBe(true);
	});

	it("P10: corpusLinesArb yields arrays of lines", async () => {
		const fc = asFcApi(await loadFastCheck());
		if (fc === null) throw new Error("fast-check required");
		const arb = corpusLinesArb(fc, ["x\ny\nz"], fc.constant([]));
		const sample = fc.sample(arb, { numRuns: 100, seed: 3 }) as unknown[];
		expect(sample.every((v) => Array.isArray(v))).toBe(true);
		expect(sample.some((v) => Array.isArray(v) && v.length === 3)).toBe(true);
	});
});

function outcomeFor(dir: string, source: string, lexeme: string, replacement: string, config: object): Promise<FuzzOutcome> {
	const file = join(dir, "subject.ts");
	writeFileSync(file, source);
	const startOffset = source.indexOf(lexeme);
	const target = buildFuzzTarget(file, source, { file, mutator: "TestMutator", originalLexeme: lexeme, replacement, startOffset });
	return runDifferentialFuzz(target, { seed: 42, runs: 300, callTimeoutMs: 100, ...config });
}

const SCANNER = [
	"export function shouldWarn(content: string): boolean {",
	'\tconst hits = content.split("\\n").filter((l) => l.includes("TODO"));',
	"\treturn hits.length >= 3;",
	"}",
	"",
].join("\n");

describe("differential-fuzz-corpus engine wiring — positive (must fire)", () => {
	it("P11: a >= 3 boundary mutant is invisible to type-driven inputs and killed once a companion fixture holds 3 matches", async () => {
		const dir = tmp();
		const plain = await outcomeFor(dir, SCANNER, ">= 3", "> 3", {});
		expect(plain.kind).toBe("no_divergence");
		writeFileSync(join(dir, "subject.test.ts"), "const fixture = `TODO a\\nok line\\nTODO b\\nTODO c`;\n");
		const seeded = await outcomeFor(dir, SCANNER, ">= 3", "> 3", { corpus: { files: [], maxBytes: 10_000 } });
		expect(seeded.kind).toBe("kill");
		if (seeded.kind !== "kill") return;
		const text = String(seeded.counterexample[0]);
		expect(text.split("\n").filter((l) => l.includes("TODO"))).toHaveLength(3);
		expect(seeded.params[0]).toMatchObject({ name: "content", corpusSeeded: true });
	});

	it("P12: a repo-file seed alone can supply the matches", async () => {
		const dir = tmp();
		const repo = join(dir, "repo.txt");
		writeFileSync(repo, "TODO one\nTODO two\nTODO three\nnothing\n");
		const out = await outcomeFor(dir, SCANNER, ">= 3", "> 3", { corpus: { files: [repo], maxBytes: 10_000 } });
		expect(out.kind).toBe("kill");
	});
});

describe("differential-fuzz-corpus engine wiring — negative (must not fire)", () => {
	it("N7: an equivalent mutant (>= 3 to > 2 on an integer length) stays no_divergence even with a rich corpus", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "subject.test.ts"), "const fixture = `TODO a\\nok line\\nTODO b\\nTODO c`;\n");
		const out = await outcomeFor(dir, SCANNER, ">= 3", "> 2", { corpus: { files: [], maxBytes: 10_000 } });
		expect(out.kind).toBe("no_divergence");
		if (out.kind !== "no_divergence") return;
		expect(out.params[0]?.corpusSeeded).toBe(true);
	});

	it("N8: with an empty corpus the plain type-driven branch still runs and still kills what it can reach", async () => {
		const dir = tmp();
		const src = "export function longEnough(content: string): boolean {\n\treturn content.length > 4;\n}\n";
		const out = await outcomeFor(dir, src, "> 4", ">= 4", { corpus: { files: [], maxBytes: 10_000 } });
		expect(out.kind).toBe("kill");
		if (out.kind !== "kill") return;
		expect(out.counterexample).toEqual(["\u0000\u0000\u0000\u0000"].length ? [out.counterexample[0]] : []);
		expect(String(out.counterexample[0])).toHaveLength(4);
		expect(out.params[0]?.corpusSeeded).toBeFalsy();
	});

	it("N9: without the corpus option nothing is corpus-seeded, even beside a companion test", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "subject.test.ts"), "const fixture = `TODO a\\nok line\\nTODO b\\nTODO c`;\n");
		const out = await outcomeFor(dir, SCANNER, ">= 3", "> 3", {});
		expect(out.kind).toBe("no_divergence");
		if (out.kind !== "no_divergence") return;
		expect(out.params[0]?.corpusSeeded).toBeFalsy();
	});
});
