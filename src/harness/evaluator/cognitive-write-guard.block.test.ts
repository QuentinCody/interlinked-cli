// Block-contract tests for the PROMOTED cognitive-complexity gate
// (`checkCognitiveComplexityWrite`) — mirrors complexity-write-guard.test.ts's
// coverage of the cyclomatic gate's over-cap / sub-cap-slew / delta-semantics
// contract, plus one case unique to cognitive's hybrid identity-based +
// pooled-rank over-cap comparison (see the doc comment on `cognitiveViolations`
// in cognitive-write-guard.ts): a decomposition that relocates complexity into
// a newly-named over-cap helper must still block.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMetricCapsCache } from "../metric-caps.js";
import {
	checkCognitiveComplexityWrite,
	SUB_CAP_COGNITIVE_RATCHET_TOLERANCE,
} from "./cognitive-write-guard.js";

/** `n` sequential, NON-nested top-level `if` statements → cognitive === n
 *  exactly (each adds its base +1 increment with zero nesting penalty). */
function flat(name: string, n: number): string {
	let body = "";
	for (let i = 0; i < n; i++) body += `\tif (a === ${i}) r += ${i};\n`;
	return `export function ${name}(a: number): number {\n\tlet r = 0;\n${body}\treturn r;\n}\n`;
}

/** An anonymous arrow callback (named "(callback)" by the AST pass) with `n`
 *  flat top-level ifs → cognitive === n. */
function anonFlat(n: number): string {
	let body = "";
	for (let i = 0; i < n; i++) body += `\tif (a === ${i}) r += ${i};\n`;
	return `export const wired = register((a: number): number => {\n${body}\treturn r;\n});\n`;
}

const CAP = 30; // DEFAULT_MAX_COGNITIVE_CAP (metric-caps.ts) — pinned via the "exposes the cap" test below

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cog-block-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkCognitiveComplexityWrite — over-cap end state", () => {
	it("pins the shipped default cap (30) and slew tolerance (4)", () => {
		expect(SUB_CAP_COGNITIVE_RATCHET_TOLERANCE).toBe(4);
	});

	it("honors a per-repo configured cap from .interlinked/metric-caps.json", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "metric-caps.json"), JSON.stringify({ max_cognitive: 10 }));
		resetMetricCapsCache();
		const out = checkCognitiveComplexityWrite({ file_path: join(tmp, "big.ts"), content: flat("big", 15) }, tmp);
		expect(out?.block).toContain("big");
		expect(out?.block).toContain("10-point cap");
		resetMetricCapsCache();
	});

	// --- MUST fire: an edit pushing a function over the cap ---
	it("BLOCKS a Write that adds a NEW over-cap function", () => {
		const out = checkCognitiveComplexityWrite({ file_path: join(tmp, "big.ts"), content: flat("big", 40) }, tmp);
		expect(out?.block).toContain("[interlinked:cognitive]");
		expect(out?.block).toContain("big");
		expect(out?.block).toContain("new over-cap function");
	});

	it("BLOCKS an Edit that RAISES a function past the cap", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, flat("grow", 5)); // under cap
		const out = checkCognitiveComplexityWrite(
			{ file_path: file, old_string: "\treturn r;", new_string: `${"\tif (a === 99) r += 1;\n".repeat(30)}\treturn r;` },
			tmp,
		);
		expect(out?.block).toContain("grow");
		expect(out?.block).toContain("raised from");
	});

	// --- MUST NOT fire: pre-existing over-cap function unchanged or improved ---
	it("ALLOWS holding an already-over-cap function (refactor-down path)", () => {
		const file = join(tmp, "huge.ts");
		writeFileSync(file, flat("huge", 40)); // already over cap
		const out = checkCognitiveComplexityWrite({ file_path: file, content: flat("huge", 40) }, tmp);
		expect(out).toBeNull();
	});

	it("ALLOWS shrinking an already-over-cap function (still over cap, but improved)", () => {
		const file = join(tmp, "shrink.ts");
		writeFileSync(file, flat("g", 45));
		const out = checkCognitiveComplexityWrite({ file_path: file, content: flat("g", 35) }, tmp);
		expect(out).toBeNull();
	});

	// --- MUST fire: new/anonymous function over the cap ---
	it("BLOCKS a NEW anonymous callback landing over the cap", () => {
		const out = checkCognitiveComplexityWrite({ file_path: join(tmp, "anon.ts"), content: anonFlat(40) }, tmp);
		expect(out?.block).toContain("[interlinked:cognitive]");
		expect(out?.block).toContain("anonymous");
	});

	// --- MUST fire: decomposition that relocates complexity into a new
	// over-cap helper (the identity-free rank comparison alone would miss
	// this — see cognitiveViolations's doc comment). ---
	it("BLOCKS a decomposition that shrinks the target but creates a NEW over-cap helper", () => {
		const file = join(tmp, "decompose.ts");
		writeFileSync(file, flat("main", 40)); // one over-cap function, 40
		// After: `main` drops to 5 (well under cap) but a brand-new `helper`
		// absorbs the excess at 32 (still over the 30 cap). Total over-cap COUNT
		// is unchanged (1 -> 1), so a pure pooled-rank comparison would read this
		// as "the worst offender improved" and allow it.
		const after = flat("main", 5) + flat("helper", 32);
		const out = checkCognitiveComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out?.block).toContain("helper");
		expect(out?.block).toContain("new over-cap function");
	});

	it("ALLOWS a decomposition where every resulting piece is under cap", () => {
		const file = join(tmp, "split.ts");
		writeFileSync(file, flat("big", 40));
		const after = flat("a", 8) + flat("b", 8) + flat("c", 8);
		const out = checkCognitiveComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out).toBeNull();
	});

	// --- collision-named (ambiguous) functions: pooled-rank comparison path ---
	// Two functions sharing the SAME name have no reliable per-name identity
	// (isAmbiguousName's `counts > 1` branch), so they fall back to the
	// cyclomatic gate's pooled sorted-multiset comparison (cognitiveViolations
	// (1b)) — exercised here with 2 elements on each side so the sort
	// comparator and the beforeAmbiguousVals filter/map/sort are all actually
	// invoked (they never run on a length-0/1 array).
	it("BLOCKS collision-named (same-name) functions that RISE via the pooled-rank path", () => {
		const file = join(tmp, "dup-rise.ts");
		writeFileSync(file, `${flat("dup", 32)}${flat("dup", 33)}`); // both over cap 30
		const after = `${flat("dup", 45)}${flat("dup", 50)}`; // both over cap, both risen
		const out = checkCognitiveComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out?.block).toContain("dup");
		expect(out?.block).toContain("new over-cap function");
	});

	it("ALLOWS collision-named functions that hold/shrink via the pooled-rank path", () => {
		const file = join(tmp, "dup-shrink.ts");
		writeFileSync(file, `${flat("dup", 35)}${flat("dup", 36)}`); // both over cap
		const after = `${flat("dup", 33)}${flat("dup", 34)}`; // still over cap, but reduced
		const out = checkCognitiveComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out).toBeNull();
	});
});

describe("checkCognitiveComplexityWrite — sub-cap per-edit slew ratchet", () => {
	it("ALLOWS a sub-cap rise within tolerance (10 -> 14 at the default)", () => {
		const file = join(tmp, "slew-ok.ts");
		writeFileSync(file, flat("f", 10));
		const out = checkCognitiveComplexityWrite(
			{ file_path: file, content: flat("f", 10 + SUB_CAP_COGNITIVE_RATCHET_TOLERANCE) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("ALLOWS 10 -> 15 as one edit and as split edits with the same end state", () => {
		const file = join(tmp, "slew-over.ts");
		const pre = 10;
		const post = pre + SUB_CAP_COGNITIVE_RATCHET_TOLERANCE + 1;
		writeFileSync(file, flat("f", pre));
		const out = checkCognitiveComplexityWrite({ file_path: file, content: flat("f", post) }, tmp);
		expect(out).toBeNull();
		expect(checkCognitiveComplexityWrite({ file_path: file, content: flat("f", 13) }, tmp)).toBeNull();
		writeFileSync(file, flat("f", 13));
		expect(checkCognitiveComplexityWrite({ file_path: file, content: flat("f", post) }, tmp)).toBeNull();
	});

	it("still BLOCKS a within-tolerance rise that crosses the cap (cap is the backstop)", () => {
		const file = join(tmp, "cross.ts");
		const pre = CAP - 1; // 29, under cap
		const post = CAP + 1; // 31, over cap (rise 2, within the default tolerance of 4)
		writeFileSync(file, flat("f", pre));
		const out = checkCognitiveComplexityWrite({ file_path: file, content: flat("f", post) }, tmp);
		expect(out?.block).toContain("cognitive");
		expect(out?.block).toContain("raised from");
	});

	it("ALLOWS holding a sub-cap function (5 -> 5)", () => {
		const file = join(tmp, "hold.ts");
		writeFileSync(file, flat("f", 5));
		const out = checkCognitiveComplexityWrite({ file_path: file, content: flat("f", 5) }, tmp);
		expect(out).toBeNull();
	});
});

describe("checkCognitiveComplexityWrite — dispatch / exemptions", () => {
	it("is unaffected by non-JS/TS files (.py)", () => {
		const out = checkCognitiveComplexityWrite(
			{ file_path: join(tmp, "x.py"), content: "def f():\n    pass\n" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("is unaffected by non-JS/TS files (.md)", () => {
		const out = checkCognitiveComplexityWrite(
			{ file_path: join(tmp, "notes.md"), content: flat("hidden", 40) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("exempts test files via the cappable-file exemption", () => {
		const out = checkCognitiveComplexityWrite(
			{ file_path: join(tmp, "x.test.ts"), content: flat("t", 40) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("allows a small in-cap Write with no violations", () => {
		const out = checkCognitiveComplexityWrite({ file_path: join(tmp, "ok.ts"), content: flat("ok", 3) }, tmp);
		expect(out).toBeNull();
	});

	it("resolves a RELATIVE file_path against cwd (isAbsolute false branch)", () => {
		const out = checkCognitiveComplexityWrite({ file_path: "rel-big.ts", content: flat("relbig", 40) }, tmp);
		expect(out?.block).toContain("relbig");
	});

	it("returns null when the write shape is unrecognized (no content/old_string+new_string/edits)", () => {
		const out = checkCognitiveComplexityWrite({ file_path: join(tmp, "unknown-shape.ts") }, tmp);
		expect(out).toBeNull();
	});
});

// ===========================================================================
// apply_patch dispatch (Codex/Copilot payloads reconstructed before scoring).
// ===========================================================================
describe("checkCognitiveComplexityWrite — apply_patch", () => {
	function applyPatchAdd(path: string, content: string): { command: string } {
		const body = content
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n");
		return { command: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch` };
	}

	it("blocks an apply_patch Add File introducing an over-cap function", () => {
		const out = checkCognitiveComplexityWrite(applyPatchAdd(join(tmp, "gen.ts"), flat("genned", 40)), tmp);
		expect(out?.block).toContain("cognitive");
		expect(out?.block).toContain("gen.ts");
	});

	it("allows an apply_patch Add File with only under-cap functions", () => {
		const out = checkCognitiveComplexityWrite(applyPatchAdd(join(tmp, "okgen.ts"), flat("okfn", 5)), tmp);
		expect(out).toBeNull();
	});

	it("fails open on an apply_patch whose context cannot be matched", () => {
		const file = join(tmp, "nomatch.ts");
		writeFileSync(file, flat("nm", 5));
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" nonexistent context line\n" +
			"-foo\n" +
			"+bar\n" +
			"*** End Patch";
		expect(checkCognitiveComplexityWrite({ command: patch }, tmp)).toBeNull();
	});

	it("returns null when there is no file_path AND no apply_patch-shaped payload", () => {
		expect(checkCognitiveComplexityWrite({}, tmp)).toBeNull();
	});

	it("skips a non-JS/TS section in an apply_patch (README.md)", () => {
		const body = "huge unrelated markdown content\n".repeat(50);
		const patch = `*** Begin Patch\n*** Add File: README.md\n${body
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => `+${l}`)
			.join("\n")}\n*** End Patch`;
		expect(checkCognitiveComplexityWrite({ command: patch }, tmp)).toBeNull();
	});

	it("skips a non-cappable section (test file) in an apply_patch even when over cap", () => {
		const out = checkCognitiveComplexityWrite(
			applyPatchAdd(join(tmp, "gen.test.ts"), flat("gennedtest", 40)),
			tmp,
		);
		expect(out).toBeNull();
	});

	it("reads the pre-existing on-disk content for an Update File section (existsSync true branch)", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, flat("grow", 5)); // under cap on disk
		let added = "";
		for (let i = 0; i < 40; i++) added += `+\tif (a === ${100 + i}) r += ${i};\n`;
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" \tif (a === 4) r += 4;\n" + // context (space + original tab-indented line)
			added +
			" \treturn r;\n" +
			"*** End Patch";
		const out = checkCognitiveComplexityWrite({ command: patch }, tmp);
		expect(out?.block).toContain("grow");
		expect(out?.block).toContain("raised from");
	});
});
