import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMPLEXITY_METRICS,
	computeOverCap,
	FUNCTION_COMPLEXITY_BASELINE_REL,
	FUNCTION_COMPLEXITY_PREVIOUS_REL,
	type FunctionComplexityLedger,
	fileGrandfather,
	grandfatheredCeiling,
	grandfatherVerdict,
	isComplexityMetric,
	ledgerNote,
	ledgerOverCapViolation,
	loadFunctionComplexityBaseline,
	loadPreviousFunctionComplexityBaseline,
	lookupGrandfathered,
	makeGrandfatherResolver,
	mergeShrinkOnly,
	resetFunctionComplexityBaselineCache,
	saveFunctionComplexityBaseline,
	snapshotPreviousFunctionComplexityBaseline,
	toLedgerRelPath,
} from "./function-complexity-baseline.js";

/** A function body with `branches` if-statements → cyclomatic = branches + 1. */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

/** A `depth`-deep nested if chain → cognitive = 1 + 2 + … + depth. */
function nestedFn(name: string, depth: number): string {
	let body = "\treturn a;\n";
	for (let d = depth; d >= 1; d--) {
		body = `\tif (a > ${d}) {\n${body.replace(/^/gm, "\t")}\t}\n`;
	}
	return `export function ${name}(a: number): number {\n${body}\treturn 0;\n}\n`;
}

function ledgerWith(entries: FunctionComplexityLedger["metrics"]): FunctionComplexityLedger {
	return { version: 1, metrics: entries };
}

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fn-cx-baseline-"));
	resetFunctionComplexityBaselineCache();
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("metric names", () => {
	it("pins the two metrics the ledger tracks", () => {
		expect([...COMPLEXITY_METRICS]).toEqual(["cyclomatic", "cognitive"]);
		expect(isComplexityMetric("cyclomatic")).toBe(true);
		expect(isComplexityMetric("cognitive")).toBe(true);
		expect(isComplexityMetric("crap")).toBe(false);
	});
});

describe("loadFunctionComplexityBaseline / saveFunctionComplexityBaseline", () => {
	it("returns null when no ledger exists", () => {
		expect(loadFunctionComplexityBaseline(cwd)).toBeNull();
	});

	it("returns null on malformed JSON or a wrong shape", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const path = join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL);
		writeFileSync(path, "{not json");
		expect(loadFunctionComplexityBaseline(cwd)).toBeNull();
		resetFunctionComplexityBaselineCache();
		writeFileSync(path, JSON.stringify([1, 2]));
		expect(loadFunctionComplexityBaseline(cwd)).toBeNull();
		resetFunctionComplexityBaselineCache();
		writeFileSync(path, JSON.stringify({ version: 2, metrics: {} }));
		expect(loadFunctionComplexityBaseline(cwd)).toBeNull();
	});

	it("round-trips a ledger through save → load and creates .interlinked/", () => {
		const ledger = ledgerWith({
			cyclomatic: { cap: 16, entries: [{ file: "src/a.ts", name: "big", line: 3, value: 20 }] },
		});
		saveFunctionComplexityBaseline(cwd, ledger);
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL))).toBe(true);
		expect(loadFunctionComplexityBaseline(cwd)).toEqual(ledger);
		expect(readFileSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL), "utf8").endsWith("\n")).toBe(true);
	});

	it("drops malformed entries and unknown metric sections but keeps the valid ones", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL),
			JSON.stringify({
				version: 1,
				metrics: {
					cyclomatic: {
						cap: 16,
						entries: [
							{ file: "src/a.ts", name: "big", line: 3, value: 20 },
							{ file: "src/a.ts", name: "bad", line: "x", value: 20 },
							"junk",
						],
					},
					cognitive: { cap: "30", entries: [] },
					halstead: { cap: 5, entries: [] },
				},
			}),
		);
		const loaded = loadFunctionComplexityBaseline(cwd);
		expect(loaded?.metrics.cyclomatic?.entries).toEqual([
			{ file: "src/a.ts", name: "big", line: 3, value: 20 },
		]);
		expect(loaded?.metrics.cognitive).toBeUndefined();
		expect(Object.keys(loaded?.metrics ?? {})).toEqual(["cyclomatic"]);
	});

	it("snapshotPrevious copies the current ledger to the .previous sibling; loadPrevious reads it back", () => {
		expect(loadPreviousFunctionComplexityBaseline(cwd)).toBeNull();
		expect(snapshotPreviousFunctionComplexityBaseline(cwd)).toBe(false); // nothing to snapshot yet
		const ledger = ledgerWith({ cyclomatic: { cap: 16, entries: [] } });
		saveFunctionComplexityBaseline(cwd, ledger);
		expect(snapshotPreviousFunctionComplexityBaseline(cwd)).toBe(true);
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_PREVIOUS_REL))).toBe(true);
		expect(loadPreviousFunctionComplexityBaseline(cwd)).toEqual(ledger);
	});

	it("picks up a rewrite on disk (mtime-aware cache)", () => {
		saveFunctionComplexityBaseline(cwd, ledgerWith({ cyclomatic: { cap: 16, entries: [] } }));
		expect(loadFunctionComplexityBaseline(cwd)?.metrics.cyclomatic?.cap).toBe(16);
		saveFunctionComplexityBaseline(cwd, ledgerWith({ cyclomatic: { cap: 12, entries: [] } }));
		expect(loadFunctionComplexityBaseline(cwd)?.metrics.cyclomatic?.cap).toBe(12);
	});
});

describe("computeOverCap — walks the git-visible cappable product files", () => {
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
		writeFileSync(join(cwd, "src", "a.ts"), `${fnWith("small", 2)}\n${fnWith("big", 9)}`);
		writeFileSync(join(cwd, "src", "b.ts"), fnWith("medium", 5));
		writeFileSync(join(cwd, "src", "a.test.ts"), fnWith("testBig", 20));
		mkdirSync(join(cwd, "ignored"), { recursive: true });
		writeFileSync(join(cwd, "ignored", "c.ts"), fnWith("ignoredBig", 20));
		writeFileSync(join(cwd, "src", "nested.ts"), nestedFn("deep", 4));
	});

	it("lists only functions over the cap, in file/line order, with repo-relative paths", () => {
		const out = computeOverCap(cwd, "cyclomatic", 5);
		expect(out).toEqual([
			{ file: "src/a.ts", name: "big", line: 8, value: 10 },
			{ file: "src/b.ts", name: "medium", line: 1, value: 6 },
		]);
	});

	it("excludes test files and gitignored files even when they are over the cap", () => {
		const names = (computeOverCap(cwd, "cyclomatic", 5) ?? []).map((e) => e.name);
		expect(names).not.toContain("testBig");
		expect(names).not.toContain("ignoredBig");
	});

	it("computes the cognitive metric with the cognitive analyzer", () => {
		// `big` has 9 sequential ifs → cognitive 9 (no nesting); `deep` nests 4 → 1+2+3+4 = 10.
		const out = computeOverCap(cwd, "cognitive", 9);
		expect(out).toEqual([{ file: "src/nested.ts", name: "deep", line: 1, value: 10 }]);
	});

	it("returns an empty list when nothing is over the cap", () => {
		expect(computeOverCap(cwd, "cyclomatic", 50)).toEqual([]);
	});

	it("P: scans .mts/.cts — every extension the write gates put into ledger mode can be listed", () => {
		// Before the scan covered them, a .mts with an over-cap function could never
		// be listed, so once a ledger existed EVERY edit to that file false-blocked.
		writeFileSync(join(cwd, "src", "esm.mts"), fnWith("esmBig", 9));
		writeFileSync(join(cwd, "src", "cjs.cts"), fnWith("cjsBig", 9));
		const names = (computeOverCap(cwd, "cyclomatic", 5) ?? []).map((e) => e.name);
		expect(names).toContain("esmBig");
		expect(names).toContain("cjsBig");
	});
});

describe("lookupGrandfathered", () => {
	const ledger = ledgerWith({
		cyclomatic: {
			cap: 16,
			entries: [
				{ file: "src/a.ts", name: "big", line: 3, value: 20 },
				{ file: "src/a.ts", name: "dup", line: 30, value: 18 },
				{ file: "src/a.ts", name: "dup", line: 60, value: 24 },
			],
		},
	});

	it("returns the grandfathered value for a listed (file, name)", () => {
		expect(lookupGrandfathered(ledger, "cyclomatic", "src/a.ts", "big")).toBe(20);
	});

	it("returns the max among same-named entries", () => {
		expect(lookupGrandfathered(ledger, "cyclomatic", "src/a.ts", "dup")).toBe(24);
	});

	it("returns null for an unlisted function, another file, another metric, or no ledger", () => {
		expect(lookupGrandfathered(ledger, "cyclomatic", "src/a.ts", "small")).toBeNull();
		expect(lookupGrandfathered(ledger, "cyclomatic", "src/b.ts", "big")).toBeNull();
		expect(lookupGrandfathered(ledger, "cognitive", "src/a.ts", "big")).toBeNull();
		expect(lookupGrandfathered(null, "cyclomatic", "src/a.ts", "big")).toBeNull();
	});
});

describe("grandfatherVerdict — hold or shrink, never grow", () => {
	const entry = { file: "src/a.ts", name: "big", line: 3, value: 20 };

	it("allows a hold at the grandfathered value", () => {
		expect(grandfatherVerdict(entry, 20, 20)).toBe("allowed");
	});

	it("allows a shrink", () => {
		expect(grandfatherVerdict(entry, 20, 17)).toBe("allowed");
	});

	it("blocks growth past the grandfathered value", () => {
		expect(grandfatherVerdict(entry, 20, 21)).toBe("grow");
	});

	it("blocks growth even when the result stays at or under the grandfathered value", () => {
		expect(grandfatherVerdict(entry, 17, 19)).toBe("grow");
		expect(grandfatherVerdict(entry, 17, 20)).toBe("grow");
	});

	it("blocks a hold above the grandfathered value (a stale ledger must be met, not held)", () => {
		expect(grandfatherVerdict(entry, 23, 23)).toBe("grow");
	});

	it("compares against the grandfathered value alone when no before-value exists", () => {
		expect(grandfatherVerdict(entry, undefined, 20)).toBe("allowed");
		expect(grandfatherVerdict(entry, undefined, 21)).toBe("grow");
	});

	it("grandfatheredCeiling is the min of the ledger value and the before-value", () => {
		expect(grandfatheredCeiling(20, undefined)).toBe(20);
		expect(grandfatheredCeiling(20, 17)).toBe(17);
		expect(grandfatheredCeiling(20, 25)).toBe(20);
	});
});

describe("toLedgerRelPath", () => {
	it("makes an absolute path repo-relative with forward slashes", () => {
		expect(toLedgerRelPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
	});

	it("leaves a relative path as-is (normalized)", () => {
		expect(toLedgerRelPath("/repo", "src\\a.ts")).toBe("src/a.ts");
	});
});

describe("fileGrandfather — the per-file view the write gates consult", () => {
	const ledger = ledgerWith({
		cyclomatic: {
			cap: 16,
			entries: [
				{ file: "src/a.ts", name: "big", line: 3, value: 20 },
				{ file: "src/a.ts", name: "(callback)", line: 40, value: 18 },
				{ file: "src/a.ts", name: "(callback)", line: 80, value: 25 },
				{ file: "src/a.ts", name: "dup", line: 100, value: 17 },
				{ file: "src/a.ts", name: "dup", line: 120, value: 19 },
				{ file: "src/b.ts", name: "other", line: 1, value: 30 },
			],
		},
	});

	it("splits uniquely-named entries from anonymous/colliding ones and counts the burn-down", () => {
		const gf = fileGrandfather(ledger, "cyclomatic", "(callback)", "src/a.ts");
		expect(gf?.byName.get("big")).toBe(20);
		expect(gf?.byName.has("dup")).toBe(false);
		expect(gf?.pooled).toEqual([25, 19, 18, 17]);
		expect(gf?.total).toBe(6);
		expect(gf?.cap).toBe(16);
	});

	it("returns an empty (but authoritative) view for a file with no entries", () => {
		const gf = fileGrandfather(ledger, "cyclomatic", "(callback)", "src/zzz.ts");
		expect(gf?.byName.size).toBe(0);
		expect(gf?.pooled).toEqual([]);
		expect(gf?.total).toBe(6);
	});

	it("returns null when the ledger or the metric section is absent (legacy delta mode)", () => {
		expect(fileGrandfather(null, "cyclomatic", "(callback)", "src/a.ts")).toBeNull();
		expect(fileGrandfather(ledger, "cognitive", "(callback)", "src/a.ts")).toBeNull();
	});

	it("makeGrandfatherResolver returns null (legacy delta) for files the scan cannot ledger, e.g. Python", () => {
		saveFunctionComplexityBaseline(cwd, ledger);
		const resolver = makeGrandfatherResolver("cyclomatic", "(callback)");
		expect(resolver(cwd, "src/tool.py")).toBeNull();
		expect(resolver(cwd, "src/a.ts")).not.toBeNull();
	});

	it("makeGrandfatherResolver reads the ledger for cwd and resolves absolute paths", () => {
		saveFunctionComplexityBaseline(cwd, ledger);
		const resolver = makeGrandfatherResolver("cyclomatic", "(callback)");
		expect(resolver(cwd, join(cwd, "src", "a.ts"))?.byName.get("big")).toBe(20);
		expect(resolver(cwd, "src/b.ts")?.byName.get("other")).toBe(30);
		rmSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL));
		expect(resolver(cwd, "src/a.ts")).toBeNull();
	});
});

describe("ledgerOverCapViolation — the identity rule in ledger mode", () => {
	const ledger = ledgerWith({
		cyclomatic: {
			cap: 16,
			entries: [
				{ file: "src/a.ts", name: "big", line: 3, value: 20 },
				{ file: "src/b.ts", name: "other", line: 1, value: 30 },
			],
		},
	});
	const gf = () => {
		const view = fileGrandfather(ledger, "cyclomatic", "(callback)", "src/a.ts");
		if (!view) throw new Error("view");
		return view;
	};

	it("N1: a listed function held at its grandfathered value is allowed", () => {
		expect(ledgerOverCapViolation("cyclomatic", "big", 20, 20, gf())).toBeNull();
	});

	it("N2: a listed function shrunk below its grandfathered value is allowed", () => {
		expect(ledgerOverCapViolation("cyclomatic", "big", 18, 20, gf())).toBeNull();
	});

	it("P1: a listed function that grows is blocked and the text names the grandfathered value and burn-down", () => {
		const text = ledgerOverCapViolation("cyclomatic", "big", 21, 20, gf());
		expect(text).toContain("big (cyclomatic 21");
		expect(text).toContain("grandfathered at 20");
		expect(text).toContain("1 of 2");
		expect(text).toContain("never grow");
	});

	it("P2: an unlisted over-cap function is blocked even when it is merely held", () => {
		const text = ledgerOverCapViolation("cyclomatic", "small", 17, 17, gf());
		expect(text).toContain("small (cyclomatic 17");
		expect(text).toContain("not grandfathered");
		expect(text).toContain("16");
	});

	it("P3: a listed function held ABOVE its grandfathered value is blocked and the text says what it was", () => {
		const text = ledgerOverCapViolation("cyclomatic", "big", 23, 23, gf());
		expect(text).toContain("grandfathered at 20");
		expect(text).toContain("was 23");
	});

	it("ledgerNote points at the ledger and the burn-down command", () => {
		const note = ledgerNote("cyclomatic", gf());
		expect(note).toContain(FUNCTION_COMPLEXITY_BASELINE_REL);
		expect(note).toContain("2 cyclomatic");
		expect(note).toContain("interlinked caps status");
	});
});

describe("mergeShrinkOnly — regenerating entries never launders growth", () => {
	const prev = [
		{ file: "src/a.ts", name: "big", line: 3, value: 20 },
		{ file: "src/a.ts", name: "gone", line: 50, value: 19 },
		{ file: "src/b.ts", name: "grew", line: 1, value: 18 },
	];
	const live = [
		{ file: "src/a.ts", name: "big", line: 5, value: 17 },
		{ file: "src/b.ts", name: "grew", line: 1, value: 22 },
		{ file: "src/c.ts", name: "fresh", line: 1, value: 25 },
	];

	it("keeps the smaller of the previous and live values, drops resolved entries, adds new ones", () => {
		const merged = mergeShrinkOnly(prev, live);
		expect(merged.entries).toEqual([
			{ file: "src/a.ts", name: "big", line: 5, value: 17 },
			{ file: "src/b.ts", name: "grew", line: 1, value: 18 },
			{ file: "src/c.ts", name: "fresh", line: 1, value: 25 },
		]);
	});

	it("reports the functions that regressed past their recorded value", () => {
		expect(mergeShrinkOnly(prev, live).regressed).toEqual([
			{ file: "src/b.ts", name: "grew", line: 1, value: 22 },
		]);
	});

	it("is the identity over an empty previous list", () => {
		expect(mergeShrinkOnly([], live)).toEqual({ entries: live, regressed: [] });
	});
});
