// Mutation-kill companion for env-extractor.ts (W6 residue contract,
// scratch/fleet-r3/CONTRACT-W6.md). Every fixture here was verified against
// the ACTUAL surviving mutant text via
// scratch/fleet-r3/env-extractor-shadow-verify.mts (esbuild/applyReplacement
// shadow build, byte-exact occurrence resolved from
// .interlinked/mutation-manifest.json's `ordinalWithinSymbol` — never
// assumed). Receipts: scratch/fleet-r3/receipts/
// src_harness_structure_extractors_env-extractor.ts.jsonl
//
// 16 survivors are NOT covered here: they are `equivalent_candidate`
// (fuzz_no_divergence, 320 generated `.env.example` lines each, zero
// divergence) — see the receipts file for the full list + reasoning. Most
// are the blank/comment-skip and eqIdx>=0 boundary in the two near-duplicate
// `.env.example` parsers (classifyFile's inline copy and scanEnvExample),
// which the trailing `/^[A-Z][A-Z0-9_]*$/` regex gate makes structurally
// unobservable (a skipped-vs-not-skipped line can never itself become a
// validly-shaped key). Two are Buffer-coercion equivalences: reading with an
// empty encoding still auto-stringifies correctly through `RegExp.exec`.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WALK_ENTRIES } from "./bounded-walk.js";
import { classifyFile, extract, metadata } from "./env-extractor.js";

describe("metadata (module) — content survives intact", () => {
	// test-contract: public-api — `metadata` is the extractor-registry surface
	// (structure build, doc generation); every field value must survive intact,
	// not just its shape. Kills 9 StringLiteral/ArrayDeclaration survivors in
	// one whole-object assertion (any single emptied value breaks toEqual).
	it("P1: metadata equals the full declared object", () => {
		expect(metadata).toEqual({
			name: "env-extractor",
			supported_patterns: [
				"process.env.*",
				"import.meta.env.*",
				"os.Getenv()",
				"os.environ[]",
				"getenv()",
				"std::env::var()",
			],
			output_kinds: ["env_key"],
			provenance: "extracted",
			max_determinism: "partially_deterministic",
			version: 1,
		});
	});
});

describe("SOURCE_EXTENSIONS (module) — every declared extension is scanned", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-sourceext-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// P1-P6: each extension's StringLiteral survivor (".tsx"/".jsx"/".java"/
	// ".c"/".cpp"/".h" -> "") drops that entry from the shared Set, so a file
	// with that extension stops being walked at all.
	it("P1-P6: .tsx/.jsx/.java/.c/.cpp/.h files are each discovered", () => {
		writeFileSync(join(tmp, "a.tsx"), "process.env.EXT_TSX_KEY;");
		writeFileSync(join(tmp, "a.jsx"), "process.env.EXT_JSX_KEY;");
		writeFileSync(join(tmp, "a.java"), "process.env.EXT_JAVA_KEY;");
		writeFileSync(join(tmp, "a.c"), "process.env.EXT_C_KEY;");
		writeFileSync(join(tmp, "a.cpp"), "process.env.EXT_CPP_KEY;");
		writeFileSync(join(tmp, "a.h"), "process.env.EXT_H_KEY;");
		const labels = extract(tmp).nodes.map((n) => n.label).sort();
		expect(labels).toEqual(
			["EXT_C_KEY", "EXT_CPP_KEY", "EXT_H_KEY", "EXT_JAVA_KEY", "EXT_JSX_KEY", "EXT_TSX_KEY"].sort(),
		);
	});
});

describe("ENV_PATTERNS (module) — import.meta.env and bare getenv() capture the FULL key", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-patterns-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// P1: kills the three import.meta.env Regex survivors at once — dropping
	// `^`'s char-class negation, dropping the `*` quantifier (2-char capture),
	// or negating the tail class (1-char capture) would each truncate this
	// long, underscore-bearing key instead of matching it in full.
	it("P1: import.meta.env.<KEY> extracts the exact full key", () => {
		writeFileSync(join(tmp, "a.ts"), "import.meta.env.LONG_ENV_KEY_NAME_XYZ;");
		const labels = extract(tmp).nodes.map((n) => n.label);
		expect(labels).toContain("LONG_ENV_KEY_NAME_XYZ");
		expect(labels).not.toContain("LO");
		expect(labels).not.toContain("L");
	});

	// P2: same shape, kills the three bare getenv() Regex survivors.
	it("P2: getenv(\"KEY\") extracts the exact full key", () => {
		writeFileSync(join(tmp, "a.c"), 'getenv("LONG_C_ENV_KEY_NAME_XYZ")');
		const labels = extract(tmp).nodes.map((n) => n.label);
		expect(labels).toContain("LONG_C_ENV_KEY_NAME_XYZ");
		expect(labels).not.toContain("LO");
		expect(labels).not.toContain("L");
	});
});

// Shared `.env.example` content exercising both `.env.example` parsers
// (classifyFile's own inline copy, and scanEnvExample reached via extract()).
// Each line targets one distinguishing case; see inline comments.
const ENV_EXAMPLE_CASES = [
	"  CF_LEADING_WS_KEY", // leading whitespace, no "=" — needs line.trim()
	"CF_ENDSWITH_KEY=VAL#", // ends with "#" but does not START with it
	"CF_TRIM_SLICE_KEY =value", // space before "=" — needs slice(...).trim()
	"1CF_ANCHOR_START=x", // digit-first — must be rejected (^ anchor)
	"CF_ANCHOR_END_JUNK!!!=x", // trailing junk — must be rejected ($ anchor)
	"CF_NOEQ_KEY", // no "=" at all — full text must survive untruncated
	"cf_lower_invalid=val", // lowercase — must be rejected by the regex gate
	"CF_NORMAL_DECLARED=ok", // plain baseline case
	"",
].join("\n");

describe("classifyFile — .env.example parsing", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-cf-example-"));
		writeFileSync(join(tmp, ".env.example"), ENV_EXAMPLE_CASES);
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function labelsOf(): Map<string, { provenance: string; file: string }> {
		return new Map(classifyFile(tmp, ".env.example").nodes.map((n) => [n.label, n]));
	}

	// P1: kills MethodExpression `line.trim()` -> `line` — an untrimmed line
	// keeps its leading space, which the trailing-space-tolerant slice/trim
	// on the key branch cannot repair since eqIdx is -1 (whole-line branch).
	it("P1: leading-whitespace key with no '=' is declared", () => {
		expect(labelsOf().has("CF_LEADING_WS_KEY")).toBe(true);
	});

	// P2: kills MethodExpression `startsWith("#")` -> `endsWith("#")` — a line
	// ending in "#" (but not starting with it) is wrongly treated as a
	// comment and skipped under the mutant.
	it("P2: a line ending in '#' that is not a comment is still declared", () => {
		expect(labelsOf().has("CF_ENDSWITH_KEY")).toBe(true);
	});

	// P3: kills MethodExpression `.slice(0, eqIdx).trim()` -> `.slice(0, eqIdx)`
	// — without the second trim, trailing space before "=" survives into the
	// key, which then fails the `$`-anchored regex and never gets declared.
	it("P3: trailing space before '=' is trimmed off the key", () => {
		const n = labelsOf().get("CF_TRIM_SLICE_KEY");
		expect(n).toBeDefined();
		expect(n?.provenance).toBe("declared");
	});

	// P4/P5: kill the two Regex survivors (^ removed, $ removed).
	it("P4: a digit-first key is rejected (regex ^ anchor)", () => {
		expect(labelsOf().has("1CF_ANCHOR_START")).toBe(false);
	});
	it("P5: a key with trailing junk is rejected (regex $ anchor)", () => {
		expect(labelsOf().has("CF_ANCHOR_END_JUNK!!!")).toBe(false);
	});

	// N1: sanity baseline — a well-formed line is declared normally.
	it("N1: a normal KEY=value line is declared", () => {
		expect(labelsOf().has("CF_NORMAL_DECLARED")).toBe(true);
	});

	// P6/P7: kill the classifyFile "env_key"/"partially_deterministic"
	// StringLiteral survivors — asserted via the FULL node shape so an
	// emptied field cannot slip through a partial check.
	it("P6-P7: the declared node carries its full field set", () => {
		const nodes = classifyFile(tmp, ".env.example").nodes;
		const n = nodes.find((node) => node.label === "CF_NORMAL_DECLARED");
		expect(n).toMatchObject({
			kind: "env_key",
			label: "CF_NORMAL_DECLARED",
			provenance: "declared",
			determinism_ceiling: "partially_deterministic",
		});
	});
});

describe("classifyFile — SOURCE_EXTENSIONS gate", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-cf-gate-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// P1: kills ConditionalExpression `SOURCE_EXTENSIONS.has(...)` -> `true`.
	// A real, readable file with a NON-source extension must be skipped
	// entirely — under the mutant it would be read and scanned regardless.
	it("P1: a readable .md file with env content is never scanned", () => {
		writeFileSync(join(tmp, "notes.md"), "process.env.MD_SHOULD_NOT_EXTRACT_XYZ;");
		expect(classifyFile(tmp, "notes.md")).toEqual({ nodes: [], edges: [] });
	});
});

describe("extract — .env.example via scanEnvExample", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-scanexample-"));
		writeFileSync(join(tmp, ".env.example"), ENV_EXAMPLE_CASES);
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function labelsOf(): Map<string, { provenance: string; file: string }> {
		return new Map(extract(tmp).nodes.map((n) => [n.label, n]));
	}

	// P1-P5 mirror classifyFile's cases above, but through scanEnvExample
	// (a separately-mutated near-duplicate — see CLAUDE.md code_clones note).
	it("P1: leading-whitespace key with no '=' is declared", () => {
		expect(labelsOf().has("CF_LEADING_WS_KEY")).toBe(true);
	});
	it("P2: a line ending in '#' that is not a comment is still declared", () => {
		expect(labelsOf().has("CF_ENDSWITH_KEY")).toBe(true);
	});
	it("P3: trailing space before '=' is trimmed off the key", () => {
		expect(labelsOf().get("CF_TRIM_SLICE_KEY")?.provenance).toBe("declared");
	});
	it("P4: a digit-first key is rejected (regex ^ anchor)", () => {
		expect(labelsOf().has("1CF_ANCHOR_START")).toBe(false);
	});
	it("P5: a key with trailing junk is rejected (regex $ anchor)", () => {
		expect(labelsOf().has("CF_ANCHOR_END_JUNK!!!")).toBe(false);
	});

	// P6: kills ConditionalExpression `eqIdx >= 0` -> `true` (scanEnvExample
	// only — classifyFile's twin is already killed by pre-existing coverage).
	// Forcing the "found '='" branch on a no-"=" line slices one character
	// off the key via `.slice(0, -1)`, truncating it.
	it("P6: a no-'=' line's full key survives untruncated", () => {
		const l = labelsOf();
		expect(l.has("CF_NOEQ_KEY")).toBe(true);
		expect(l.has("CF_NOEQ_KE")).toBe(false);
	});

	// P7: kills ConditionalExpression `/^[A-Z][A-Z0-9_]*$/.test(key)` -> `true`
	// (scanEnvExample only). An obviously-invalid lowercase key must still be
	// rejected regardless of what the regex would otherwise decide.
	it("P7: a lowercase key is rejected regardless of the regex gate", () => {
		expect(labelsOf().has("cf_lower_invalid")).toBe(false);
	});

	// P8/P9: Regex ^/$ anchor removal (scanEnvExample's own copy).
	// (covered by P4/P5 above via the shared regex; scanEnvExample's own
	// Regex-mutator survivors target the identical pattern text.)

	// P10: kills StringLiteral `".env.example"` -> `""` at the declared-key
	// `file` field (a THIRD occurrence in this symbol, distinct from the path
	// construction) — asserted via the exact `file` value, not just presence.
	it("P10: a declared key's file field is exactly '.env.example'", () => {
		expect(labelsOf().get("CF_NORMAL_DECLARED")?.file).toBe(".env.example");
	});
});

describe("extract — walkDir traversal edge cases", () => {
	let tmp: string;
	let external: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-walk-"));
		external = mkdtempSync(join(tmpdir(), "env-ext-walk-external-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(external, { recursive: true, force: true });
	});

	// P1: kills ConditionalExpression `!SOURCE_EXTENSIONS.has(ext)` -> `false`
	// inside walkDir specifically (classifyFile's parallel gate is a
	// different AST site, covered above).
	it("P1: a readable .md file with env content is never scanned", () => {
		writeFileSync(join(tmp, "notes.md"), "process.env.MD_WALK_KEY_XYZ;");
		expect(extract(tmp).nodes.some((n) => n.label === "MD_WALK_KEY_XYZ")).toBe(false);
	});

	// P2: kills ConditionalExpression `entry.isFile()` -> `true`. A symlink
	// entry reports isFile()=false/isDirectory()=false from readdirSync, so
	// under the mutant it gets treated as a file and its target followed —
	// the target lives OUTSIDE the walked tree so only a followed symlink can
	// surface its key (co-locating the target would let it be discovered
	// directly, which would mask this mutant entirely).
	it("P2: a symlink entry is never followed", () => {
		writeFileSync(join(external, "external_target.ts"), "process.env.SYMLINK_TARGET_KEY_XYZ;");
		symlinkSync(join(external, "external_target.ts"), join(tmp, "link_to_target.ts"));
		expect(extract(tmp).nodes.some((n) => n.label === "SYMLINK_TARGET_KEY_XYZ")).toBe(false);
	});
});

describe("extract — walk budget enforcement", () => {
	// P1: kills ConditionalExpression `!consumeWalkEntry(ctx.budget)` -> `false`
	// (the whole guarded call is dead-code-eliminated under this mutant, so
	// the budget is never consumed at all and the cap never fires). A budget
	// pre-seeded 2 below MAX_WALK_ENTRIES allows exactly 2 of 5 files through.
	it("P1: the entry cap stops the walk at exactly the right file", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-cap-"));
		try {
			for (let i = 1; i <= 5; i++) {
				writeFileSync(join(tmp, `f${i}.ts`), `process.env.CAP_KEY_${i};`);
			}
			const budget = { entriesVisited: MAX_WALK_ENTRIES - 2, deadline: performance.now() + 8000, truncated: false };
			expect(extract(tmp, budget).nodes.length).toBe(2);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// P2: kills ConditionalExpression `ctx.budget.truncated` -> `false` inside
	// the post-recursion check (`if (ctx.budget.truncated) return;`). A
	// directory that trips truncation DURING its recursive descent must stop
	// the OUTER loop immediately rather than consuming one more sibling entry
	// first — observed via the budget object's own mutated entry count
	// (`a_sub/` then its one file exhausts the cap; under the mutant the
	// outer loop's sibling `z_after.ts` gets one extra consumeWalkEntry call
	// before the top-of-loop check catches it, one entry higher than
	// original). Directory read order is verified stable on this filesystem
	// (mkdir before writeFile, alphabetical names) — see debug run in
	// scratch/fleet-r3/.
	it("P2: truncation during subdirectory recursion stops the outer loop immediately", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-boundary-"));
		try {
			mkdirSync(join(tmp, "a_sub"));
			writeFileSync(join(tmp, "a_sub", "inner.ts"), "process.env.BOUNDARY_INNER_KEY;");
			writeFileSync(join(tmp, "z_after.ts"), "process.env.BOUNDARY_AFTER_KEY;");
			const budget = { entriesVisited: MAX_WALK_ENTRIES - 1, deadline: performance.now() + 8000, truncated: false };
			extract(tmp, budget);
			expect(budget.entriesVisited).toBe(MAX_WALK_ENTRIES + 1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("extract — warnWalkTruncated observability", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	// P1: kills ConditionalExpression `budget.truncated` -> `true` — the
	// warning must NOT fire for an ordinary small walk that never truncates.
	it("P1: no warning is emitted when the walk does not truncate", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-warn-untrunc-"));
		try {
			writeFileSync(join(tmp, "a.ts"), "process.env.WARN_UNTRUNC_KEY;");
			extract(tmp, { entriesVisited: 0, deadline: performance.now() + 8000, truncated: false });
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// P2: kills ConditionalExpression `budget.truncated` -> `false` — a
	// caller-supplied already-truncated budget must still produce the
	// warning; suppressing it would hide a partial artifact graph silently.
	it("P2: a pre-truncated budget still emits the warning", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-warn-trunc-"));
		try {
			extract(tmp, { entriesVisited: 0, deadline: performance.now() + 8000, truncated: true });
			expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
				`[interlinked-harness] env-extractor walk hit the hard cap (>50000 entries or >8000ms) under ${tmp}; artifact graph is partial. This usually means repoRoot resolved to an unexpectedly large tree.`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("extract — ArtifactNode field construction", () => {
	// P1/P2: kill the extract()-level "env_key"/"partially_deterministic"
	// StringLiteral survivors (distinct AST sites from classifyFile's copy).
	it("P1-P2: an extracted node carries its full field set", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-fields-"));
		try {
			writeFileSync(join(tmp, "a.ts"), "process.env.FIELD_CHECK_KEY;");
			const n = extract(tmp).nodes.find((node) => node.label === "FIELD_CHECK_KEY");
			expect(n).toMatchObject({
				kind: "env_key",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("scanFile — first-file-wins attribution", () => {
	// P1: kills ConditionalExpression `!envKeys.has(key)` -> `true`. When the
	// SAME env key is referenced from two different files, the FIRST file
	// scanned keeps the attribution; forcing an unconditional re-set would
	// let the LAST file scanned overwrite it instead.
	it("P1: the first file to reference a shared key wins its file attribution", () => {
		const tmp = mkdtempSync(join(tmpdir(), "env-ext-attr-"));
		try {
			writeFileSync(join(tmp, "f1_first.ts"), "process.env.SHARED_ATTRIBUTION_KEY;");
			writeFileSync(join(tmp, "f2_second.ts"), "process.env.SHARED_ATTRIBUTION_KEY;");
			const n = extract(tmp).nodes.find((node) => node.label === "SHARED_ATTRIBUTION_KEY");
			expect(n?.file).toBe("f1_first.ts");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
