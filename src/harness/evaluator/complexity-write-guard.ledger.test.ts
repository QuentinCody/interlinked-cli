// Ledger-mode evidence for the two per-function metric gates: with a
// `.interlinked/function-complexity-baseline.json` present, the ledger — not
// the on-disk before-state — is the explicit source of the "hold or shrink"
// allowance. Legacy (no-ledger) behavior is pinned in the sibling test files.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FUNCTION_COMPLEXITY_BASELINE_REL,
	type FunctionComplexityLedger,
	resetFunctionComplexityBaselineCache,
	saveFunctionComplexityBaseline,
} from "../function-complexity-baseline.js";
import { resetMetricCapsCache } from "../metric-caps.js";
import { checkCognitiveComplexityWrite } from "./cognitive-write-guard.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";

/** `branches` if-statements → cyclomatic = branches + 1, cognitive = branches. */
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

let tmp: string;
let file: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cyc-ledger-"));
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmp, ".interlinked", "metric-caps.json"),
		JSON.stringify({ version: 1, max_cyclomatic: 10, max_cognitive: 10 }),
	);
	resetMetricCapsCache();
	resetFunctionComplexityBaselineCache();
	file = join(tmp, "src", "a.ts");
	mkdirSync(join(tmp, "src"), { recursive: true });
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function ledger(metrics: FunctionComplexityLedger["metrics"]): void {
	saveFunctionComplexityBaseline(tmp, { version: 1, metrics });
}

/** Two functions: `big` over the cap (cyclomatic 21), `tiny` under it. */
const BIG = fnWith("big", 20);
const TINY = fnWith("tiny", 1);

describe("checkFunctionComplexityWrite — ledger mode, positive (must fire)", () => {
	it("blocks a listed function that grows past its grandfathered value and names the burn-down", () => {
		ledger({
			cyclomatic: {
				cap: 10,
				entries: [
					{ file: "src/a.ts", name: "big", line: 1, value: 21 },
					{ file: "src/b.ts", name: "other", line: 1, value: 30 },
				],
			},
		});
		writeFileSync(file, BIG + TINY);
		const out = checkFunctionComplexityWrite({ file_path: file, content: fnWith("big", 21) + TINY }, tmp);
		expect(out?.block).toContain("big (cyclomatic 22, grandfathered at 21");
		expect(out?.block).toContain("1 of 2 grandfathered over the 10 cap");
		expect(out?.block).toContain("never grow");
		expect(out?.block).toContain(FUNCTION_COMPLEXITY_BASELINE_REL);
		expect(out?.block).toContain("lists 2 cyclomatic function(s)");
	});

	it("blocks an UNLISTED over-cap function even when the edit only holds it (unrelated edit elsewhere)", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/b.ts", name: "other", line: 1, value: 30 }] } });
		writeFileSync(file, BIG + TINY);
		const out = checkFunctionComplexityWrite({ file_path: file, content: BIG + fnWith("tiny", 2) }, tmp);
		expect(out?.block).toContain("big (cyclomatic 21, over the 10 cap and not grandfathered");
		expect(out?.block).toContain("the ledger lists 1 function(s)");
	});

	it("blocks a listed function held ABOVE its recorded value (a stale ledger must be met)", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 18 }] } });
		writeFileSync(file, BIG + TINY);
		const out = checkFunctionComplexityWrite({ file_path: file, content: BIG + fnWith("tiny", 2) }, tmp);
		expect(out?.block).toContain("grandfathered at 18, was 21");
	});

	it("blocks a new anonymous over-cap callback whose rank the ledger's pooled entries do not cover", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 21 }] } });
		writeFileSync(file, BIG);
		let body = "\tlet r = 0;\n";
		for (let i = 0; i < 12; i++) body += `\tif (a === ${i}) r += ${i};\n`;
		const anon = `export const wired = register((a: number): number => {\n${body}\treturn r;\n});\n`;
		const out = checkFunctionComplexityWrite({ file_path: file, content: BIG + anon }, tmp);
		expect(out?.block).toContain("(callback) (cyclomatic 13, new anonymous function over cap)");
	});
});

describe("checkFunctionComplexityWrite — ledger mode, negative (must not fire)", () => {
	it("allows a listed function held at its grandfathered value", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 21 }] } });
		writeFileSync(file, BIG + TINY);
		expect(checkFunctionComplexityWrite({ file_path: file, content: BIG + fnWith("tiny", 2) }, tmp)).toBeNull();
	});

	it("allows a listed function that shrinks (still over the cap)", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 21 }] } });
		writeFileSync(file, BIG + TINY);
		expect(checkFunctionComplexityWrite({ file_path: file, content: fnWith("big", 15) + TINY }, tmp)).toBeNull();
	});

	it("allows a listed function that drops under the cap entirely", () => {
		ledger({ cyclomatic: { cap: 10, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 21 }] } });
		writeFileSync(file, BIG + TINY);
		expect(checkFunctionComplexityWrite({ file_path: file, content: fnWith("big", 3) + TINY }, tmp)).toBeNull();
	});

	it("allows an anonymous over-cap callback whose rank the ledger's pooled entries cover", () => {
		ledger({
			cyclomatic: {
				cap: 10,
				entries: [{ file: "src/a.ts", name: "(callback)", line: 1, value: 13 }],
			},
		});
		let body = "\tlet r = 0;\n";
		for (let i = 0; i < 12; i++) body += `\tif (a === ${i}) r += ${i};\n`;
		const anon = `export const wired = register((a: number): number => {\n${body}\treturn r;\n});\n`;
		writeFileSync(file, anon);
		expect(checkFunctionComplexityWrite({ file_path: file, content: `${anon}\n${TINY}` }, tmp)).toBeNull();
	});

	it("falls back to legacy delta semantics when the ledger has no cyclomatic section", () => {
		ledger({ cognitive: { cap: 10, entries: [] } });
		writeFileSync(file, BIG + TINY);
		// Unlisted over-cap function merely held → legacy allows it.
		expect(checkFunctionComplexityWrite({ file_path: file, content: BIG + fnWith("tiny", 2) }, tmp)).toBeNull();
	});
});

describe("checkFunctionComplexityWrite — ledger/effective-cap drift, positive (must fire)", () => {
	beforeEach(() => {
		// Effective cap tightened to 6 (a harness-permitted Edit or a checked-out
		// value below the ledger's own generation cap of 8) — the drift the fix
		// targets: `caps set`, not `caps ratchet`, produced this state.
		writeFileSync(
			join(tmp, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_cyclomatic: 6, max_cognitive: 10 }),
		);
		resetMetricCapsCache();
	});

	it("P1: blocks an unlisted function once it crosses the ledger's own cap (7 -> 9, ledger cap 8)", () => {
		ledger({ cyclomatic: { cap: 8, entries: [] } });
		const MID7 = fnWith("mid7", 6); // cyclomatic 7
		writeFileSync(file, MID7 + TINY);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("mid7", 8) + TINY }, // cyclomatic 9
			tmp,
		);
		expect(out?.block).toContain("mid7 (cyclomatic 9, over the 8 cap and not grandfathered");
	});

	it("P2: blocks an unlisted function above the ledger's cap even when merely held", () => {
		ledger({ cyclomatic: { cap: 8, entries: [] } });
		const LOUD = fnWith("loud", 8); // cyclomatic 9, above the ledger's own cap of 8
		writeFileSync(file, LOUD + TINY);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: LOUD + fnWith("tiny", 2) },
			tmp,
		);
		expect(out?.block).toContain("loud (cyclomatic 9, over the 8 cap and not grandfathered");
	});

	it("P3: block message names the drift and points at the ratchet verb", () => {
		ledger({ cyclomatic: { cap: 8, entries: [] } });
		const LOUD = fnWith("loud", 8);
		writeFileSync(file, LOUD + TINY);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: LOUD + fnWith("tiny", 2) },
			tmp,
		);
		expect(out?.block).toContain("interlinked caps ratchet cyclomatic --to 6");
	});
});

describe("checkFunctionComplexityWrite — ledger/effective-cap drift, negative (must not fire)", () => {
	beforeEach(() => {
		writeFileSync(
			join(tmp, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_cyclomatic: 6, max_cognitive: 10 }),
		);
		resetMetricCapsCache();
	});

	it("N1: allows holding an unlisted function under the ledger's own cap while an unrelated edit lands", () => {
		ledger({ cyclomatic: { cap: 8, entries: [] } });
		const MID7 = fnWith("mid7", 6); // cyclomatic 7, over the effective cap (6) but under the ledger's (8)
		writeFileSync(file, MID7 + TINY);
		expect(
			checkFunctionComplexityWrite({ file_path: file, content: MID7 + fnWith("tiny", 2) }, tmp),
		).toBeNull();
	});

	it("N2: no drift line in the message when the ledger's cap equals the effective cap", () => {
		ledger({ cyclomatic: { cap: 6, entries: [] } });
		const LOUD = fnWith("loud", 8); // cyclomatic 9, over cap 6 with no drift
		writeFileSync(file, LOUD + TINY);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: LOUD + fnWith("tiny", 2) },
			tmp,
		);
		expect(out?.block).not.toContain("caps ratchet cyclomatic --to");
	});
});

describe("checkCognitiveComplexityWrite — ledger mode", () => {
	const DEEP = nestedFn("deep", 5); // cognitive 15

	it("P1: blocks a listed function that grows past its grandfathered cognitive value", () => {
		ledger({ cognitive: { cap: 10, entries: [{ file: "src/a.ts", name: "deep", line: 1, value: 15 }] } });
		writeFileSync(file, DEEP);
		const out = checkCognitiveComplexityWrite({ file_path: file, content: nestedFn("deep", 6) }, tmp);
		expect(out?.block).toContain("deep (cognitive 21, grandfathered at 15");
		expect(out?.block).toContain("1 of 1 grandfathered over the 10 cap");
	});

	it("P2: blocks an unlisted over-cap function that is merely held", () => {
		ledger({ cognitive: { cap: 10, entries: [] } });
		writeFileSync(file, DEEP + TINY);
		const out = checkCognitiveComplexityWrite({ file_path: file, content: DEEP + fnWith("tiny", 2) }, tmp);
		expect(out?.block).toContain("deep (cognitive 15, over the 10 cap and not grandfathered");
	});

	it("N1: allows a listed function held at its grandfathered value", () => {
		ledger({ cognitive: { cap: 10, entries: [{ file: "src/a.ts", name: "deep", line: 1, value: 15 }] } });
		writeFileSync(file, DEEP + TINY);
		expect(checkCognitiveComplexityWrite({ file_path: file, content: DEEP + fnWith("tiny", 2) }, tmp)).toBeNull();
	});

	it("N2: allows a listed function that shrinks", () => {
		ledger({ cognitive: { cap: 10, entries: [{ file: "src/a.ts", name: "deep", line: 1, value: 15 }] } });
		writeFileSync(file, DEEP);
		expect(checkCognitiveComplexityWrite({ file_path: file, content: nestedFn("deep", 4) }, tmp)).toBeNull();
	});
});
