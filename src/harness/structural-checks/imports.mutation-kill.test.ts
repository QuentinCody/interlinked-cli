// Mutation-kill regression tests for imports.ts survivors (pass1_w15).
//
// These target specific surviving mutants from `interlinked mutation survivors`
// that the existing imports.test.ts suite did not distinguish. Each case names
// the exact behavioral divergence it depends on; see the sibling receipts file
// (scratch/fleet-r3/receipts/src_harness_structural-checks_imports.ts.jsonl)
// for the full mutant-id -> test mapping, including mutants classified
// suspected_equivalent (not represented here because no test can distinguish
// them from pristine behavior).

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportGraph } from "./imports.js";
import type { ImportEdge } from "../types/graph.js";
import { checkCrossPackageImports, checkDeadImports, checkHallucinatedImports } from "./imports.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

afterEach(() => vi.resetAllMocks());

function edge(over: Partial<ImportEdge> = {}): ImportEdge {
	return {
		fromFile: "/proj/src/a.ts",
		toFile: "/proj/src/b.ts",
		specifier: "./b",
		symbols: [],
		isTypeOnly: false,
		...over,
	};
}

function makeGraph(
	opts: {
		dependencies?: ImportEdge[];
	} = {},
): ImportGraph {
	return {
		getDependencies: vi.fn().mockReturnValue(opts.dependencies ?? []),
		getExports: vi.fn().mockReturnValue([]),
		findDuplicateExports: vi.fn().mockReturnValue([]),
		toRelative: vi.fn((p: string) => p.replace(/^\/proj\//, "")),
	};
}

const FILE = "/proj/src/a.ts";
const REL = "src/a.ts";

// =============================================================================
// checkCrossPackageImports — the top-of-loop skip guard and the root-dirname
// early-break guard
// =============================================================================

describe("checkCrossPackageImports mutant-kill", () => {
	// test-contract: boundary — a falsy toFile must skip the walk even when the
	// specifier itself carries ".." segments; skipping is what keeps a genuinely
	// unresolved edge from ever reaching the package.json boundary walk.
	it("mutant-kill: skips an edge with a falsy toFile even when the specifier has '..' segments", () => {
		mockFs.existsSync.mockImplementation((p) => p === "/proj/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "lib" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	// test-contract: boundary — a bare (non-relative) specifier must never enter
	// the boundary walk, even if it happens to contain literal '..' segments.
	it("mutant-kill: skips a bare specifier even if it happens to contain '..' segments", () => {
		mockFs.existsSync.mockImplementation((p) => p === "/proj/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "lib" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "pkg/../other", toFile: "/other/dir/x.ts" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	// test-contract: boundary — when the importing file itself lives at the
	// filesystem root, dirname(dir) === dirname(filePath) on the very first walk
	// step; the loop must stop there instead of treating the root's own
	// package.json as a crossed boundary.
	it("mutant-kill: does not treat the root directory as a package boundary when the importer lives at the root", () => {
		mockFs.existsSync.mockImplementation((p) => p === "/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "root-pkg" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../sub/x", toFile: "/sub/x.ts" })],
		});
		expect(checkCrossPackageImports("/a.ts", "a.ts", graph)).toEqual([]);
	});
});

// =============================================================================
// checkHallucinatedImports — the ancestor-walk termination guard
// =============================================================================

describe("checkHallucinatedImports mutant-kill", () => {
	// test-contract: public-api — the package.json ancestor search must walk
	// PAST the file's own directory to find one declared one level up; breaking
	// after only the first (non-root) directory would silently disable
	// dependency-declaration checking for every file whose own directory lacks
	// a package.json.
	it("mutant-kill: walks past the file's own directory to find an ancestor package.json", () => {
		mockFs.existsSync.mockImplementation((p) => p === "/proj/src/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "totally-made-up", toFile: "" })],
		});
		const res = checkHallucinatedImports("/proj/src/deep/file.ts", "src/deep/file.ts", graph);
		expect(res).toHaveLength(1);
		expect(res[0]?.check).toBe("hallucinated_imports");
	});
});

// =============================================================================
// checkDeadImports -> collectImportBindings — the multiline-import buffer
// state machine's regex-driven branch decisions
// =============================================================================

describe("checkDeadImports mutant-kill (collectImportBindings internals)", () => {
	// test-contract: boundary — the FIRST /^import\s/ check (multiline-open
	// detector) must be anchored: a line that merely CONTAINS "import " without
	// starting with it must end the import section, not be mistaken for the
	// start of a new multiline import.
	it("mutant-kill: a line only containing 'import ' (not starting with it) ends the import section, not opens a new one", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { target } from './m';", "xx import { yy", "target"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	// test-contract: boundary — the SECOND /^import\s/ check (the direct
	// processImportLine dispatch) must also be anchored: a line that merely
	// contains "import " must not be dispatched as an import line, or the
	// import section is kept artificially open past real usage code.
	it("mutant-kill: a line only containing 'import ' does not get dispatched as an import statement", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { target } from './m';", "xx import yy", "zz import target"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	// test-contract: boundary — the buffer-close condition is an OR of "looks
	// like a 'from' clause" and "contains any quote"; a bare quote with no
	// 'from' keyword (e.g. a stray side-effect-shaped continuation) must still
	// close the buffer, not require BOTH conditions.
	it("mutant-kill: a bare quote (no 'from' keyword) still closes an open multiline buffer", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { target } from './m';", "import {", "'x'", "target"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	// test-contract: boundary — the buffer-close condition's "from" branch
	// requires an actual quote character right after "from"+whitespace; "from"
	// followed by an ordinary (non-quote) word must NOT be treated as a real
	// `from '...'` clause, or a plain continuation line closes prematurely and
	// a later real named-import statement never gets parsed on its own.
	it("mutant-kill: 'from' followed by a non-quote word does not close the multiline buffer", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import {",
				"real",
				"} from x",
				"import { second } from './s';",
				"void 0;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `real`. Remove them to reduce dependencies.",
		);
	});
});

// =============================================================================
// checkDeadImports -> processImportLine — the four anchored dispatch regexes
// (side-effect quote guard, namespace guard, named-import match, default
// match) and the comment guard's own string method
// =============================================================================

describe("checkDeadImports mutant-kill (processImportLine internals)", () => {
	// test-contract: boundary — the leading-comment guard checks startsWith,
	// not endsWith; a legitimate import line whose module specifier happens to
	// end with "//" must still be parsed as an import, not silently discarded
	// as if it were a comment.
	it("mutant-kill: an import line ending in '//' is still parsed as an import, not treated as a comment", () => {
		mockFs.readFileSync.mockReturnValue(["import zz from a//", "", "const w = 1;"].join("\n"));
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `zz`. Remove them to reduce dependencies.",
		);
	});

	// test-contract: boundary — the side-effect-import quote guard is anchored
	// to the start of the line; a quote appearing later (e.g. inside the module
	// specifier string itself) must not trigger the side-effect early return.
	it("mutant-kill: a quote inside the module specifier does not trigger the side-effect-import guard", () => {
		mockFs.readFileSync.mockReturnValue(
			["import aa from 'import \"z\"'", "", "const w = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `aa`. Remove them to reduce dependencies.",
		);
	});

	// test-contract: boundary — the namespace-import guard is anchored to the
	// start of the line; a `* as` sequence appearing later (e.g. inside the
	// module specifier string) must not trigger the namespace-import early
	// return.
	it("mutant-kill: a '* as' sequence inside the module specifier does not trigger the namespace-import guard", () => {
		mockFs.readFileSync.mockReturnValue(
			["import xx from 'import * as y'", "", "const w = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `xx`. Remove them to reduce dependencies.",
		);
	});

	// test-contract: boundary — the named-import match is anchored to the
	// start of the line; a `{...}` sequence appearing later (inside the module
	// specifier string) must not be mistaken for the real named-import clause.
	it("mutant-kill: braces inside the module specifier are not mistaken for the real named-import clause", () => {
		mockFs.readFileSync.mockReturnValue(
			["import Name from 'import {ghost}'", "", "const w = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `Name`. Remove them to reduce dependencies.",
		);
	});

	// test-contract: boundary — the default-import match is anchored to the
	// start of the line; an `import WORD from` sequence appearing later
	// (inside the module specifier string) must not be mistaken for a real
	// default-import clause.
	it("mutant-kill: an 'import word from' sequence inside the module specifier is not mistaken for a real default import", () => {
		mockFs.readFileSync.mockReturnValue(
			["import - from 'import z from \"y\"'", "", "const w = 1;"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});
});

// =============================================================================
// checkDeadImports -> processImportLine's named-binding map callback — the
// per-specifier `type` modifier strip
// =============================================================================

describe("checkDeadImports mutant-kill (named-binding type-modifier strip)", () => {
	// test-contract: boundary — the per-specifier `type` prefix strip is
	// anchored to the start of the (trimmed) specifier text; a binding name
	// that merely CONTAINS the substring "type " (not as a leading modifier)
	// must be captured verbatim, not have that substring silently deleted.
	it("mutant-kill: a binding name containing 'type ' as a substring keeps it (anchored strip, not a search-anywhere)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { xtype foo } from './m';", "", "const w = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toBe(
			"Unused imports in src/a.ts: `xtype foo`. Remove them to reduce dependencies.",
		);
	});
});
