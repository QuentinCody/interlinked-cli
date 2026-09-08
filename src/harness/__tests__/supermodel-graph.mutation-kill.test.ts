// Mutation-kill companion for supermodel-graph.ts (fleet W5, round 3).
// Every case here was shadow-verified to KILL a specific surviving mutant —
// see scratch/fleet-r3/receipts/src_harness_supermodel-graph.ts.jsonl and
// scratch/fleet-r3/src_harness_supermodel-graph.ts-shadow-verify.mts.
//
// Labeling: P<n> = the parse must produce this positive result; N<n> = the
// parse must NOT do the wrong (mutant) thing — usually "must still null out"
// or "must not let a later line clobber an earlier one".

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGraphForFile, parseGraphFile } from "../supermodel-graph.js";

const HEADER = "// @generated supermodel-shard — do not edit";

describe("parseGraphFile — [impact] required-field guard (mutation-kill)", () => {
	it("N1: a garbage risk value alone nulls the whole impact section", () => {
		const content = [HEADER, "// [impact]", "// risk        BANANA", "// direct      1", "// transitive  1"].join(
			"\n",
		);
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N2: a garbage risk line followed by a later VALID risk line still nulls (valid latches false)", () => {
		const content = [
			HEADER,
			"// [impact]",
			"// risk        BANANA",
			"// risk        HIGH",
			"// direct      1",
			"// transitive  1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N3: a garbage direct value followed by a later VALID direct line still nulls", () => {
		const content = [
			HEADER,
			"// [impact]",
			"// risk        HIGH",
			"// direct      BANANA",
			"// direct      5",
			"// transitive  3",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N4: a garbage transitive value followed by a later VALID transitive line still nulls", () => {
		const content = [
			HEADER,
			"// [impact]",
			"// risk        HIGH",
			"// direct      2",
			"// transitive  BANANA",
			"// transitive  3",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N5: direct+transitive present but the risk line is entirely absent nulls the section", () => {
		const content = [HEADER, "// [impact]", "// direct      1", "// transitive  1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N6: risk+transitive present but the direct line is entirely absent nulls the section", () => {
		const content = [HEADER, "// [impact]", "// risk        HIGH", "// transitive  1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("N7: risk+direct present but the transitive line is entirely absent nulls the section", () => {
		const content = [HEADER, "// [impact]", "// risk        HIGH", "// direct      1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toBeNull();
	});

	it("P1: all three required fields present and valid parses cleanly", () => {
		const content = [HEADER, "// [impact]", "// risk        MEDIUM", "// direct      4", "// transitive  9"].join(
			"\n",
		);
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact).toEqual({
			risk: "MEDIUM",
			domains: [],
			direct: 4,
			transitive: 9,
			affects: [],
		});
	});

	it("N8: a later empty-valued domains line must not overwrite an earlier populated one", () => {
		const content = [
			HEADER,
			"// [impact]",
			"// risk        HIGH",
			"// domains     API · Auth",
			"// domains",
			"// direct      1",
			"// transitive  1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.domains).toEqual(["API", "Auth"]);
	});

	it("N9: a later empty-valued affects line must not overwrite an earlier populated one", () => {
		const content = [
			HEADER,
			"// [impact]",
			"// risk        HIGH",
			"// direct      1",
			"// transitive  1",
			"// affects     src/a.ts · src/b.ts",
			"// affects",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.affects).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("parseGraphFile — bucketSections unknown-header bracket detection (mutation-kill)", () => {
	it("N10: a well-formed unknown header ([futuristic]) resets the section, dropping the next real line", () => {
		const content = [
			HEADER,
			"// [deps]",
			"// [futuristic]",
			"// imports real.ts",
			"// [impact]",
			"// risk HIGH",
			"// direct 1",
			"// transitive 1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toBeNull();
	});

	it("N11: a line starting with [ but NOT ending with ] must not reset — the next real line survives", () => {
		const content = [
			HEADER,
			"// [deps]",
			"// [weird-key value",
			"// imports after.ts",
			"// [impact]",
			"// risk HIGH",
			"// direct 1",
			"// transitive 1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toEqual({
			imports: ["after.ts"],
			importedBy: [],
		});
	});

	it("P2: a line ending with ] but NOT starting with [ is real deps content, not a header reset", () => {
		const content = [
			HEADER,
			"// [deps]",
			"// imported-by weird]",
			"// [impact]",
			"// risk HIGH",
			"// direct 1",
			"// transitive 1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toEqual({
			imports: [],
			importedBy: ["weird]"],
		});
	});

	it("N12: content before any section header (currentSection===null) must be dropped, not swept into [impact]", () => {
		const content = [HEADER, "// risk HIGH", "// direct 1", "// transitive 1", "// [deps]", "// imports a.ts"].join(
			"\n",
		);
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toBeNull();
		expect(graph?.deps).toEqual({ imports: ["a.ts"], importedBy: [] });
	});
});

describe("parseGraphFile — findShardBody preamble/boundary handling (mutation-kill)", () => {
	it("P3: a leading blank line before the real header must be skipped, not treated as the body", () => {
		const content = ["", HEADER, "// [impact]", "// risk HIGH", "// direct 1", "// transitive 1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.risk).toBe("HIGH");
	});

	it("P4: a leading whitespace-only (padded) line before the header must be skipped", () => {
		const content = ["   ", HEADER, "// [impact]", "// risk HIGH", "// direct 1", "// transitive 1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.risk).toBe("HIGH");
	});

	it("N13: a go:build-ignore preamble with nothing substantive after it finds no body", () => {
		expect(parseGraphFile("//go:build ignore", "x.ts", "x.graph.ts")).toBeNull();
	});

	it("N14: go:build-ignore then package-ignore with nothing after must not over-read past the array", () => {
		expect(parseGraphFile("//go:build ignore\npackage ignore", "x.ts", "x.graph.ts")).toBeNull();
	});

	it("N15: a header line with leading whitespace before the comment marker must still be recognized", () => {
		const content = ["   " + HEADER, "// [impact]", "// risk HIGH", "// direct 1", "// transitive 1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.risk).toBe("HIGH");
	});
});

describe("parseGraphFile — stripCommentPrefix mid-body handling (mutation-kill)", () => {
	it("P5: a mid-body line with leading whitespace before // must still be recognized as a section header", () => {
		const content = [HEADER, "   // [impact]", "// risk HIGH", "// direct 1", "// transitive 1"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.impact?.risk).toBe("HIGH");
	});

	it("N16: a 2-char rogue prefix must not be sliced off as if it matched the real // comment prefix", () => {
		const content = [
			HEADER,
			"// [deps]",
			"XXimports real.ts",
			"// [impact]",
			"// risk HIGH",
			"// direct 1",
			"// transitive 1",
		].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toBeNull();
	});
});

describe("parseGraphFile — [calls] fn/rest inner-whitespace trim (mutation-kill)", () => {
	it("N17: extra spaces between the fn name and the arrow must be trimmed off fn", () => {
		const content = [HEADER, "// [calls]", "// myFunc   ← caller1"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls?.callers[0]?.fn).toBe("myFunc");
	});

	it("N18: extra spaces between the arrow and the target must be trimmed off rest", () => {
		const content = [HEADER, "// [calls]", "// myFunc ←    caller1"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls?.callers[0]?.caller).toBe("caller1");
	});

	it("N19: a [calls] section with only a non-arrow junk line nulls the whole section", () => {
		const content = [HEADER, "// [calls]", "// not an arrow line at all"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.calls).toBeNull();
	});

	// test-contract: public-api — parseCalls's final guard is
	// `callers.length === 0 && callees.length === 0`; a section with ONLY
	// callee (→) entries and zero caller (←) entries must still return a
	// non-null CallsSection with an empty callers array, not null.
	it("N29: a [calls] section with only callee (→) entries and no caller entries is non-null", () => {
		const content = [HEADER, "// [calls]", "// myFunc → calleeFn"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls).toEqual({
			callers: [],
			callees: [{ fn: "myFunc", callee: "calleeFn", file: "", line: 0 }],
		});
	});
});

describe("parseGraphFile — parseCallTarget single-token-with-colon and multi-token join (mutation-kill)", () => {
	it("N20: a single token containing a colon is the caller NAME, not a file:line split", () => {
		const content = [HEADER, "// [calls]", "// myFunc ← file.ts:42"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls?.callers[0]).toEqual({ fn: "myFunc", caller: "file.ts:42", file: "", line: 0 });
	});

	it("P6: a multi-token name before a bare ? joins with a space and keeps every token", () => {
		const content = [HEADER, "// [calls]", "// myFunc ← First Last    ?"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls?.callers[0]?.caller).toBe("First Last");
	});

	it("P7: a multi-token name before a file:line suffix joins with a space and keeps every token", () => {
		const content = [HEADER, "// [calls]", "// myFunc ← First Last    src/file.ts:10"].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls?.callers[0]).toEqual({
			fn: "myFunc",
			caller: "First Last",
			file: "src/file.ts",
			line: 10,
		});
	});
});

describe("parseGraphFile — parseDeps value-join and all-junk-section handling (mutation-kill)", () => {
	it("P8: a multi-token imported-by value must be space-joined, not concatenated", () => {
		const content = [HEADER, "// [deps]", "// imported-by alpha beta"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toEqual({
			imports: [],
			importedBy: ["alpha beta"],
		});
	});

	it("N21: a [deps] section with only an unrecognized key nulls the whole section", () => {
		const content = [HEADER, "// [deps]", "// unknown-key somevalue"].join("\n");
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")?.deps).toBeNull();
	});
});

describe("loadGraphForFile — sourcePath-emptiness and cwd-traversal guards must not be defeatable (mutation-kill)", () => {
	const ASCII_SHARD = ["// header", "// [impact]", "// risk HIGH", "// direct 1", "// transitive 1"].join("\n");

	it("N24: an empty sourcePath must null out even when cwd itself has a real .graph sibling", () => {
		const dir = mkdtempSync(join(tmpdir(), "smg-mk-emptysrc-"));
		try {
			writeFileSync(dir + ".graph", ASCII_SHARD);
			expect(loadGraphForFile("", dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(dir + ".graph", { force: true });
		}
	});

	it("N25: a whitespace-only sourcePath must null out even when a real '   .graph' sibling exists inside cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "smg-mk-wssrc-"));
		try {
			writeFileSync(join(dir, "   .graph"), ASCII_SHARD);
			expect(loadGraphForFile("   ", dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("N26: a ../ escape to a real, readable shard outside cwd must still be blocked", () => {
		const outerDir = mkdtempSync(join(tmpdir(), "smg-mk-outer-"));
		const innerDir = join(outerDir, "inner");
		try {
			mkdirSync(innerDir, { recursive: true });
			writeFileSync(join(outerDir, "evil.graph.ts"), ASCII_SHARD);
			expect(loadGraphForFile("../evil.ts", innerDir)).toBeNull();
		} finally {
			rmSync(outerDir, { recursive: true, force: true });
		}
	});

	it("N27: a sibling directory sharing a string prefix with cwd must not be treated as nested inside it", () => {
		const root = mkdtempSync(join(tmpdir(), "smg-mk-prefix-"));
		try {
			const cwdDir = mkdtempSync(join(root, "cwdtest-"));
			const siblingDir = cwdDir + "-evil";
			mkdirSync(siblingDir, { recursive: true });
			const evilSource = join(siblingDir, "x.ts");
			writeFileSync(join(siblingDir, "x.graph.ts"), ASCII_SHARD);
			expect(loadGraphForFile(evilSource, cwdDir)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P9: sourcePath '.' resolving exactly to cwd itself is the one allowed self-reference case", () => {
		const dir = mkdtempSync(join(tmpdir(), "smg-mk-selfdot-"));
		try {
			writeFileSync(dir + ".graph", ASCII_SHARD);
			const graph = loadGraphForFile(".", dir);
			expect(graph).not.toBeNull();
			expect(graph?.impact?.risk).toBe("HIGH");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(dir + ".graph", { force: true });
		}
	});

	it("P10: a shard exactly at the 1MB cap must not be rejected (strictly-greater-than, not >=)", () => {
		const dir = mkdtempSync(join(tmpdir(), "smg-mk-boundary-"));
		try {
			const MAX_SHARD_SIZE = 1024 * 1024;
			const base = ASCII_SHARD + "\n";
			const padded = base + "/".repeat(Math.max(0, MAX_SHARD_SIZE - Buffer.byteLength(base, "utf8")));
			const finalContent = padded.slice(0, MAX_SHARD_SIZE);
			expect(Buffer.byteLength(finalContent, "utf8")).toBe(MAX_SHARD_SIZE);
			writeFileSync(join(dir, "x.graph.ts"), finalContent);
			const graph = loadGraphForFile(join(dir, "x.ts"));
			expect(graph).not.toBeNull();
			expect(graph?.impact?.risk).toBe("HIGH");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("N28: a genuinely missing shard file must hit the statSync-catch return null, not leave stats unassigned", () => {
		const dir = mkdtempSync(join(tmpdir(), "smg-mk-missing-"));
		try {
			expect(loadGraphForFile(join(dir, "does-not-exist.ts"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
