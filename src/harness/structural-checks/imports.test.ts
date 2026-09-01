// Behavioral unit tests for the import-relationship structural checks.
//
// The five exported functions are pure given (a) a ProjectGraph and (b) the
// filesystem. We stub the graph with the `as unknown as ProjectGraph` idiom
// used across this repo (see dead-exports.test.ts / impact-analysis.test.ts)
// and automock `node:fs` (the writer.test.ts pattern) so existsSync /
// readFileSync are fully controlled — no real disk, network, or time access.
// `node:path` (dirname / join) is left real: it is pure, and the fs mock's
// implementation inspects the joined paths to decide what "exists".
//
// Coverage intent: exercise every export and every branch (if/else, ternary,
// &&/||/??, try/catch, the multiline-import buffer state machine, and the
// private processImportLine helper transitively through checkDeadImports).

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, ImportEdge } from "../types/graph.js";
import {
	checkCrossPackageImports,
	checkDeadImports,
	checkDuplicateSymbols,
	checkHallucinatedImports,
	checkImportResolution,
} from "./imports.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

// vitest 4: resetAllMocks keeps the automock in place (restoreAllMocks would
// un-mock node:fs, leaking the real fs into later tests) while clearing call
// history + per-test implementations.
afterEach(() => vi.resetAllMocks());

// --- fixture helpers ---------------------------------------------------------

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

function exp(name: string, over: Partial<ExportedSymbol> = {}): ExportedSymbol {
	return { name, kind: "function", isTypeOnly: false, line: 1, ...over };
}

/** Stub graph exposing only the methods the imports checks consume. */
function makeGraph(opts: {
	dependencies?: ImportEdge[];
	exports?: ExportedSymbol[];
	duplicates?: string[];
} = {}): ProjectGraph {
	return {
		getDependencies: vi.fn().mockReturnValue(opts.dependencies ?? []),
		getExports: vi.fn().mockReturnValue(opts.exports ?? []),
		findDuplicateExports: vi.fn().mockReturnValue(opts.duplicates ?? []),
		// toRelative: deterministic, strips a leading /proj/ for readability.
		toRelative: vi.fn((p: string) => p.replace(/^\/proj\//, "")),
	} as unknown as ProjectGraph;
}

const FILE = "/proj/src/a.ts";
const REL = "src/a.ts";

// =============================================================================
// checkImportResolution
// =============================================================================

describe("checkImportResolution", () => {
	it("returns [] when there are no dependencies", () => {
		const graph = makeGraph({ dependencies: [] });
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
	});

	it("skips bare specifiers with no toFile (L29 !edge.toFile)", () => {
		// toFile must be falsy; the ImportEdge type says string, so cast through.
		const graph = makeGraph({
			dependencies: [edge({ toFile: "" as unknown as string, specifier: "lodash" })],
		});
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
		expect(mockFs.existsSync).not.toHaveBeenCalled();
	});

	it("skips .json imports (L32)", () => {
		const graph = makeGraph({
			dependencies: [edge({ specifier: "./data.json", toFile: "/proj/src/data.json" })],
		});
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
		expect(mockFs.existsSync).not.toHaveBeenCalled();
	});

	it("skips deep node_modules paths (L35)", () => {
		const graph = makeGraph({
			dependencies: [edge({ toFile: "/proj/node_modules/@scope/pkg/dist/file.js" })],
		});
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
		expect(mockFs.existsSync).not.toHaveBeenCalled();
	});

	it("flags an error when the resolved file does not exist (L38 true)", () => {
		mockFs.existsSync.mockReturnValue(false);
		const graph = makeGraph({
			dependencies: [edge({ toFile: "/proj/src/missing.ts", specifier: "./missing" })],
		});
		const res = checkImportResolution(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "import_resolution",
			severity: "error",
			file: FILE,
			affectedFiles: ["/proj/src/missing.ts"],
		});
		expect(res[0]?.message).toContain("Broken import in src/a.ts");
		expect(res[0]?.message).toContain("`./missing`");
		expect(res[0]?.message).toContain("src/missing.ts");
		expect(res[0]?.message).toContain("does not exist");
	});

	it("does not check symbols when the file is missing (continue after error)", () => {
		mockFs.existsSync.mockReturnValue(false);
		const graph = makeGraph({
			dependencies: [edge({ symbols: ["foo"], toFile: "/proj/src/missing.ts" })],
		});
		checkImportResolution(FILE, REL, graph);
		// getExports must never run — we continued past the symbol check.
		expect(graph.getExports).not.toHaveBeenCalled();
	});

	it("does nothing when file exists and the edge imports no named symbols (L50 false)", () => {
		mockFs.existsSync.mockReturnValue(true);
		const graph = makeGraph({ dependencies: [edge({ symbols: [] })] });
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
		expect(graph.getExports).not.toHaveBeenCalled();
	});

	it("passes when every imported symbol is exported by the target (L57 false)", () => {
		mockFs.existsSync.mockReturnValue(true);
		const graph = makeGraph({
			dependencies: [edge({ symbols: ["foo", "bar"] })],
			exports: [exp("foo"), exp("bar")],
		});
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
	});

	it("always allows the synthetic `default` import even when not in exports (L54)", () => {
		mockFs.existsSync.mockReturnValue(true);
		const graph = makeGraph({
			dependencies: [edge({ symbols: ["default"] })],
			exports: [], // target exports nothing, yet `default` is tolerated
		});
		expect(checkImportResolution(FILE, REL, graph)).toEqual([]);
	});

	it("warns when an imported symbol is missing from the target's exports (L57 true)", () => {
		mockFs.existsSync.mockReturnValue(true);
		const graph = makeGraph({
			dependencies: [edge({ symbols: ["present", "absent"], specifier: "./b" })],
			exports: [exp("present")],
		});
		const res = checkImportResolution(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "import_resolution",
			severity: "warning",
			file: FILE,
			affectedFiles: ["/proj/src/b.ts"],
		});
		expect(res[0]?.message).toContain("imports `absent`");
		expect(res[0]?.message).toContain("does not export it");
		expect(res[0]?.message).not.toContain("`present`");
	});
});

// =============================================================================
// checkDuplicateSymbols
// =============================================================================

describe("checkDuplicateSymbols", () => {
	it("ignores exports that already existed in oldExports (L91 oldNames)", () => {
		const graph = makeGraph({ exports: [exp("kept")] });
		const res = checkDuplicateSymbols(FILE, REL, [exp("kept")], graph);
		expect(res).toEqual([]);
		expect(graph.findDuplicateExports).not.toHaveBeenCalled();
	});

	it("ignores default / * / type-only newly-added exports (L91 filter)", () => {
		const graph = makeGraph({
			exports: [
				exp("default", { kind: "default" }),
				exp("*", { kind: "namespace" }),
				exp("OnlyType", { isTypeOnly: true }),
			],
		});
		const res = checkDuplicateSymbols(FILE, REL, [], graph);
		expect(res).toEqual([]);
		expect(graph.findDuplicateExports).not.toHaveBeenCalled();
	});

	it("returns [] when a new export has no duplicates (L96 false)", () => {
		const graph = makeGraph({ exports: [exp("brandNew")], duplicates: [] });
		expect(checkDuplicateSymbols(FILE, REL, [], graph)).toEqual([]);
		expect(graph.findDuplicateExports).toHaveBeenCalledWith("brandNew", FILE, undefined);
	});

	it("warns when a new export collides with existing ones (L96 true)", () => {
		const graph = makeGraph({
			exports: [exp("dup")],
			duplicates: ["/proj/src/x.ts", "/proj/src/y.ts"],
		});
		const res = checkDuplicateSymbols(FILE, REL, [], graph);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "duplicate_symbols",
			severity: "warning",
			file: FILE,
			affectedFiles: ["/proj/src/x.ts", "/proj/src/y.ts"],
		});
		expect(res[0]?.message).toContain("New export `dup`");
		expect(res[0]?.message).toContain("src/x.ts, src/y.ts");
	});

	it("truncates the duplicate list to the first 3 (L98 slice)", () => {
		const dups = ["/proj/1.ts", "/proj/2.ts", "/proj/3.ts", "/proj/4.ts"];
		const graph = makeGraph({ exports: [exp("dup")], duplicates: dups });
		const res = checkDuplicateSymbols(FILE, REL, [], graph);
		expect(res[0]?.message).toContain("1.ts, 2.ts, 3.ts");
		expect(res[0]?.message).not.toContain("4.ts");
		// affectedFiles still carries the full list (not sliced).
		expect(res[0]?.affectedFiles).toEqual(dups);
	});

	it("forwards the boundary argument to findDuplicateExports (L95)", () => {
		const graph = makeGraph({ exports: [exp("dup")], duplicates: [] });
		checkDuplicateSymbols(FILE, REL, [], graph, "/proj/pkg-a");
		expect(graph.findDuplicateExports).toHaveBeenCalledWith("dup", FILE, "/proj/pkg-a");
	});
});

// =============================================================================
// checkDeadImports  (+ the private processImportLine, exercised transitively)
// =============================================================================

describe("checkDeadImports", () => {
	// test-contract: behavior — dead_code_action "delete" (operator request
	// 2026-08-17) turns the flag into an in-edit delete instruction
	it("P: appends the delete instruction when dead_code_action is 'delete'", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { unused } from './m';", "", "const n = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL, "delete");
		expect(res[0]?.message).toContain("`unused`");
		expect(res[0]?.message).toContain('dead_code_action is "delete"');
		expect(res[0]?.message).toContain("remove the unused binding(s) in this edit");
	});

	it("N: default action ('flag' / omitted) carries no delete instruction", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { unused } from './m';", "", "const n = 1;"].join("\n"),
		);
		for (const res of [checkDeadImports(FILE, REL), checkDeadImports(FILE, REL, "flag")]) {
			expect(res[0]?.message).toContain("`unused`");
			expect(res[0]?.message).not.toContain("dead_code_action");
		}
	});

	it("reads source as UTF-8 before scanning it", () => {
		mockFs.readFileSync.mockImplementation((_path, encoding) => {
			if (encoding !== "utf-8") return Buffer.from("not text");
			return ["import { encoded } from './m';", "", "const n = 1;"].join("\n");
		});
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`encoded`");
	});

	it("returns [] when the file cannot be read (catch L123)", () => {
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("returns [] when there are no import bindings (L174)", () => {
		mockFs.readFileSync.mockReturnValue("export const x = 1;\nconsole.log(x);\n");
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("returns [] when every imported binding is used (L188)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { used } from './m';", "", "used();"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("flags a single unused named import (L183 regex miss)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { dead } from './m';", "", "const y = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "dead_imports",
			severity: "warning",
			file: FILE,
		});
		expect(res[0]?.message).toContain("Unused imports in src/a.ts");
		expect(res[0]?.message).toContain("`dead`");
	});

	it("renders multiple dead bindings joined with backticks", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { aa, bb } from './m';", "", "const z = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`aa`, `bb`");
	});

	it("renames via `as` and tracks the local binding, not the source name (processImportLine)", () => {
		// `orig as local` — only `local` is the binding. It is unused => flagged,
		// and the message must name `local`, never `orig`.
		mockFs.readFileSync.mockReturnValue(
			["import { orig as local } from './m';", "", "const q = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`local`");
		expect(res[0]?.message).not.toContain("`orig`");
	});

	it("treats `import type { T }` bindings like value bindings (type-prefix strip)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import type { Foo } from './m';", "", "const r = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`Foo`");
	});

	it("strips a per-specifier `type` modifier inside the braces", () => {
		// import { type Aaa, Bbb } — both are bindings; the literal "type" token
		// must not become a binding (L225 name !== 'type'). Names are >1 char so
		// they survive the L181 length filter and reach the dead-import check.
		mockFs.readFileSync.mockReturnValue(
			["import { type Aaa, Bbb } from './m';", "", "console.log('nope');"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`Aaa`");
		expect(res[0]?.message).toContain("`Bbb`");
		expect(res[0]?.message).not.toContain("`type`");
	});

	it("captures a default import binding (L233 defaultMatch)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import Thing from './m';", "", "const s = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`Thing`");
	});

	it("handles extra whitespace around default and type-only imports", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import   Thing   from './m';",
				"import type   TypeThing   from './types';",
				"import   { spacedNamed } from './named';",
				"import type   { SpacedType } from './type-named';",
				"",
				"const s = 1;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`Thing`");
		expect(res[0]?.message).toContain("`TypeThing`");
		expect(res[0]?.message).toContain("`spacedNamed`");
		expect(res[0]?.message).toContain("`SpacedType`");
	});

	it("trims leading indentation from import statements", () => {
		mockFs.readFileSync.mockReturnValue(
			["  import { indented } from './m';", "", "const s = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`indented`");
	});

	it("trims a local alias binding after the alias keyword", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { orig  as   local   } from './m';", "", "const q = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`local`");
		expect(res[0]?.message).not.toContain("`orig`");
	});

	it("does not record a binding for a lone `type` token inside braces (L225 false path)", () => {
		// `import { type } from './m';` — the only comma-part is literally "type",
		// which L225 refuses to push as a binding. No bindings => empty result.
		mockFs.readFileSync.mockReturnValue(
			["import { type } from './m';", "", "const v2 = 1;"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("does not treat `import type from '...'` as a default binding (L234 false path)", () => {
		// Regex backtracks the optional `type ` group so defaultMatch[1] === 'type';
		// the `!== 'type'` guard then refuses it => no binding => empty result.
		mockFs.readFileSync.mockReturnValue(
			["import type from './m';", "", "const v3 = 1;"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("ignores side-effect imports (L206 — no binding produced)", () => {
		// `import './styles.css';` yields zero bindings => empty result.
		mockFs.readFileSync.mockReturnValue(
			["import './styles.css';", "", "const t = 1;"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("ignores `import * as ns` namespace imports (L209)", () => {
		mockFs.readFileSync.mockReturnValue(
			["import * as ns from './m';", "", "const u = 1;"].join("\n"),
		);
		// no binding recorded => returns [] even though ns is unused.
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("skips single-character bindings (L181 name.length < 2)", () => {
		// `x` is length 1 and is skipped before the regex test, so even though it
		// is unused it never appears in deadBindings => empty result.
		mockFs.readFileSync.mockReturnValue(
			["import { x } from './m';", "", "const other = 1;"].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("skips comment / blank / jsdoc lines while scanning the import section", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"// leading comment",
				"/* block open",
				" * jsdoc star",
				"*/",
				"",
				"import { keep } from './m';",
				"",
				"keep();",
			].join("\n"),
		);
		// keep is used => no findings, and the scanner survived the comment lines.
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it.each([
		["", "blank line"],
		["// comment", "line comment"],
		["* jsdoc", "jsdoc star"],
		["/* block", "block opener"],
		["*/", "block closer"],
	])("keeps scanning after a %s in the import section", (separator) => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import { first } from './first';",
				separator,
				"import { second } from './second';",
				"",
				"const value = 1;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toContain("`first`, `second`");
	});

	it("recognizes that a non-comment prefix ends the import section", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import { first } from './first';",
				"x*/",
				"import { second } from './second';",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toContain("`first`");
		expect(res[0]?.message).not.toContain("`second`");
	});

	it("stops scanning after executable code", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import { first } from './first';",
				"const value = 1;",
				"import { later } from './later';",
				"first();",
			].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("does not mistake import-like text for a later import statement", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import { real } from './m';",
				"notimport { fake } from './fake';",
				"real();",
			].join("\n"),
		);
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});

	it("parses a normal import after the scanner's initial state", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { initial } from './m';", "", "const value = 1;"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`initial`");
	});

	it("keeps a multiline import buffer isolated from the next import", () => {
		mockFs.readFileSync.mockReturnValue(
			[
				"import {",
				"  firstMulti,",
				"} from './first';",
				"import {",
				"  secondMulti,",
				"} from './second';",
				"",
				"const value = 1;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`firstMulti`, `secondMulti`");
	});

	it("does not treat a name split across body lines as a usage", () => {
		mockFs.readFileSync.mockReturnValue(
			["import { splitName } from './m';", "", "split", "Name"].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res[0]?.message).toContain("`splitName`");
	});

	it("stops scanning at the first non-import code line (importSectionEnded L170/L150)", () => {
		// After `const a = 1;` the import section ends; a later `import { foo }`
		// (e.g. inside a generated/template string region) is NOT parsed, so foo
		// is never recorded as a binding => no dead-import finding.
		mockFs.readFileSync.mockReturnValue(
			[
				"import { real } from './m';",
				"const a = 1;",
				"const tmpl = `import { foo } from './x';`;",
				"real();",
				"void a; void tmpl;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		// `real` is used, `foo` was never scanned => empty.
		expect(res).toEqual([]);
	});

	it("parses a multiline named import that closes with `from` (buffer state machine L139-145)", () => {
		// The opening line has `{` without `}` => buffered; the continuation line
		// carries the closing brace + from-clause => processed. `deadMulti` unused.
		mockFs.readFileSync.mockReturnValue(
			[
				"import {",
				"  deadMulti,",
				"} from './m';",
				"",
				"const w = 1;",
			].join("\n"),
		);
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toContain("`deadMulti`");
	});

	it("flushes a still-open multiline buffer at EOF (L172 trailing buffer)", () => {
		// File ends while the buffer is still open AND never accumulated a quote,
		// so the in-loop close (L141 /['"]/ ) never fired. The trailing
		// `if (buffer)` flush (L172) is the only thing that parses it. With no
		// quotes anywhere the buffer holds `import { tail }` at EOF.
		mockFs.readFileSync.mockReturnValue(["import {", "  tail", "}"].join("\n"));
		const res = checkDeadImports(FILE, REL);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toContain("`tail`");
	});

	it("closes a buffered import via a bare-quote continuation (L141 second alt)", () => {
		// The continuation line contains a quote but no `from ` keyword on its own
		// after concatenation still matches /['"]/ — exercising the OR's RHS.
		mockFs.readFileSync.mockReturnValue(
			["import { onlyQuote } from", "  './m';", "", "onlyQuote();"].join("\n"),
		);
		// onlyQuote is used => no finding, but the buffer-close path ran.
		expect(checkDeadImports(FILE, REL)).toEqual([]);
	});
});

// =============================================================================
// checkHallucinatedImports
// =============================================================================

describe("checkHallucinatedImports", () => {
	it.each([
		"assert",
		"buffer",
		"child_process",
		"cluster",
		"console",
		"constants",
		"crypto",
		"dgram",
		"dns",
		"domain",
		"events",
		"fs",
		"http",
		"https",
		"module",
		"net",
		"os",
		"path",
		"perf_hooks",
		"process",
		"punycode",
		"querystring",
		"readline",
		"repl",
		"stream",
		"string_decoder",
		"sys",
		"timers",
		"tls",
		"tty",
		"url",
		"util",
		"v8",
		"vm",
		"wasi",
		"worker_threads",
		"zlib",
		"node:assert",
		"node:buffer",
		"node:child_process",
		"node:crypto",
		"node:dns",
		"node:events",
		"node:fs",
		"node:http",
		"node:https",
		"node:net",
		"node:os",
		"node:path",
		"node:perf_hooks",
		"node:process",
		"node:querystring",
		"node:readline",
		"node:stream",
		"node:timers",
		"node:tls",
		"node:url",
		"node:util",
		"node:vm",
		"node:worker_threads",
		"node:zlib",
		"node:test",
	])("recognizes every Node builtin specifier: %s", (specifier) => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier, toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("returns [] when no package.json is found within 10 ancestors (L337)", () => {
		mockFs.existsSync.mockReturnValue(false); // nothing exists anywhere
		const graph = makeGraph({ dependencies: [edge({ specifier: "left-pad", toFile: "" as unknown as string })] });
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("stops the upward walk at the filesystem root (L333 parent === dir)", () => {
		// existsSync always false. With a shallow path the walk hits root quickly.
		mockFs.existsSync.mockReturnValue(false);
		const graph = makeGraph({ dependencies: [] });
		expect(checkHallucinatedImports("/a.ts", "a.ts", graph)).toEqual([]);
		// existsSync was consulted at least once during the walk.
		expect(mockFs.existsSync).toHaveBeenCalled();
	});

	it("treats a malformed package.json as absent (L326 catch → pkgJson stays null)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue("{ not valid json");
		const graph = makeGraph({ dependencies: [edge({ specifier: "left-pad", toFile: "" as unknown as string })] });
		// parse throws, break, pkgJson null => [].
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("collects deps from all four manifest fields and ignores non-object fields (L347)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				dependencies: { "pkg-dep": "1" },
				devDependencies: { "pkg-dev": "1" },
				peerDependencies: { "pkg-peer": "1" },
				optionalDependencies: { "pkg-opt": "1" },
				scripts: "not-an-object-string", // ignored: not in the field list anyway
				dependencies2: null,
			}),
		);
		// Each declared dep is recognised => no hallucination warning for any.
		const graph = makeGraph({
			dependencies: [
				edge({ specifier: "pkg-dep", toFile: "" as unknown as string }),
				edge({ specifier: "pkg-dev", toFile: "" as unknown as string }),
				edge({ specifier: "pkg-peer", toFile: "" as unknown as string }),
				edge({ specifier: "pkg-opt", toFile: "" as unknown as string }),
			],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("skips when a dependency field is present but not an object (L347 typeof guard)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		// dependencies is a string (truthy but not object) — the `typeof === object`
		// guard must skip it without throwing, leaving allDeps empty.
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: "oops" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "ghost", toFile: "" as unknown as string })],
		});
		const res = checkHallucinatedImports(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]?.check).toBe("hallucinated_imports");
	});

	it("N1: treats a top-level non-object package.json as absent (isJsonObject guard)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		// The file parses successfully (valid JSON) but the top level is an array,
		// not a package.json object — isJsonObject rejects it, so pkgJson stays
		// null and the function bails out early instead of reading fields off an
		// array.
		mockFs.readFileSync.mockReturnValue(JSON.stringify(["not", "an", "object"]));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "left-pad", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("N2: an array-valued dependency field is never read as a dependency map (isJsonObject guard)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		// dependencies is a JSON array (truthy, typeof "object", but not a keyed
		// record). The old `deps && typeof deps === "object"` guard let this
		// through and ran `Object.keys(arr)`, which yields numeric-index strings
		// ("0", "1", ...) — so a bare specifier literally named "0" would have
		// been silently treated as declared via index collision. isJsonObject
		// rejects the array outright, so a hallucinated import named "0" is
		// correctly flagged instead of hidden.
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: ["left-pad"] }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "0", toFile: "" as unknown as string })],
		});
		const res = checkHallucinatedImports(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]?.check).toBe("hallucinated_imports");
	});

	it.each([
		[".", "relative dot"],
		["./util", "relative path"],
		["/abs/path", "absolute path"],
		["node:fs", "node-prefixed builtin"],
		["node:not-a-builtin", "unknown node-prefixed module"],
		["@/alias", "@/ alias"],
		["#internal", "# subpath alias"],
		["~/home-alias", "~/ alias"],
	])("skips spec %s (%s)", (spec) => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: spec, toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("skips specs already resolved into node_modules (L360 toFile includes)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [
				edge({ specifier: "resolved-pkg", toFile: "/proj/node_modules/resolved-pkg/index.js" }),
			],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("treats a bare builtin (no node: prefix) as known (L367 BUILTIN_MODULES.has(spec))", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "crypto", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("recognizes deep imports rooted at a builtin package", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "fs/promises", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("does not require a truthy toFile when resolving a bare package name", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		// Real edges always carry `toFile: ""` (never undefined) for an
		// unresolved specifier — see project-graph.ts's `toFile: toFile || ""`
		// — so the fixture uses the same real, per-type value here.
		const graph = makeGraph({
			dependencies: [edge({ specifier: "ghost", toFile: "" })],
		});
		const res = checkHallucinatedImports(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]?.message).toContain('"ghost" is not in package.json');
	});

	it("does not search beyond ten package.json ancestors", () => {
		const file = "/a/b/c/d/e/f/g/h/i/j/k.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "ghost", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(file, "a/b/c/d/e/f/g/h/i/j/k.ts", graph)).toEqual([]);
	});

	it("uses the UTF-8 encoding when reading package.json", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockImplementation((_path, encoding) => {
			if (encoding !== "utf-8") return Buffer.from("not text");
			return JSON.stringify({ dependencies: {} });
		});
		const graph = makeGraph({
			dependencies: [edge({ specifier: "ghost", toFile: "" as unknown as string })],
		});
		const res = checkHallucinatedImports(FILE, REL, graph);
		expect(res[0]?.message).toContain('"ghost" is not in package.json');
	});

	it("extracts the scoped package name and matches it against deps (L364 @ branch)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ dependencies: { "@scope/pkg": "1" } }),
		);
		// Deep import of a scoped dep: pkgName collapses to "@scope/pkg" => known.
		const graph = makeGraph({
			dependencies: [edge({ specifier: "@scope/pkg/sub/path", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("extracts the unscoped root package name for deep imports (L365 else branch)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: { lodash: "1" } }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "lodash/fp", toFile: "" as unknown as string })],
		});
		expect(checkHallucinatedImports(FILE, REL, graph)).toEqual([]);
	});

	it("warns on a bare specifier that is not declared anywhere (L370)", () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("package.json"));
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: { lodash: "1" } }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "totally-made-up", toFile: "" as unknown as string })],
		});
		const res = checkHallucinatedImports(FILE, REL, graph);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "hallucinated_imports",
			severity: "warning",
			file: FILE,
		});
		expect(res[0]?.message).toContain('"totally-made-up"');
		expect(res[0]?.message).toContain('"totally-made-up" is not in package.json');
	});
});

// =============================================================================
// checkCrossPackageImports
// =============================================================================

describe("checkCrossPackageImports", () => {
	it("skips both bare imports and unresolved relative imports", () => {
		const graph = makeGraph({
			dependencies: [
				edge({ specifier: "lodash", toFile: "/proj/node_modules/lodash/index.js" }),
				edge({ specifier: "../missing", toFile: "" as unknown as string }),
			],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	it("skips non-relative specifiers (L396 !startsWith('.'))", () => {
		const graph = makeGraph({
			dependencies: [edge({ specifier: "lodash", toFile: "/proj/node_modules/lodash/index.js" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
		expect(mockFs.existsSync).not.toHaveBeenCalled();
	});

	it("skips edges with no toFile (L396 !edge.toFile)", () => {
		const graph = makeGraph({
			dependencies: [edge({ specifier: "./x", toFile: "" as unknown as string })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	it("skips same-directory imports (L399 targetDir === fileDir)", () => {
		// importer /proj/src/a.ts, target /proj/src/b.ts => same dir.
		const graph = makeGraph({
			dependencies: [edge({ specifier: "./b", toFile: "/proj/src/b.ts" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
		expect(mockFs.existsSync).not.toHaveBeenCalled();
	});

	it("does not walk a same-directory target even when the specifier has ..", () => {
		mockFs.existsSync.mockImplementation((p) => p === "/proj/package.json");
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../src/b", toFile: "/proj/src/b.ts" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	it("returns [] when no package.json boundary is crossed (foundBoundary false)", () => {
		// `../sib/b` => one `..` step. existsSync false everywhere => no boundary.
		mockFs.existsSync.mockReturnValue(false);
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../sib/b", toFile: "/proj/src/sib/b.ts" })],
		});
		expect(checkCrossPackageImports(FILE, REL, graph)).toEqual([]);
	});

	it("counts only parent segments in a relative specifier", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "root-like-package" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "./../x", toFile: "/proj/pkgs/x.ts" })],
		});
		expect(checkCrossPackageImports(importer, "pkgs/app/a.ts", graph)).toEqual([]);
	});

	it("does not inspect package boundaries when there are zero parent steps", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "mid-package" }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "./sibling/x", toFile: "/proj/pkgs/other/x.ts" })],
		});
		expect(checkCrossPackageImports(importer, "pkgs/app/a.ts", graph)).toEqual([]);
	});

	it("enforces the ten-directory safety limit", () => {
		const importer = "/a/b/c/d/e/f/g/h/i/j/k/l.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "root-like-package" }));
		const graph = makeGraph({
			dependencies: [
				edge({
					specifier: "../../../../../../../../../../../x",
					toFile: "/x.ts",
				}),
			],
		});
		expect(checkCrossPackageImports(importer, "a/b/c/d/e/f/g/h/i/j/k/l.ts", graph)).toEqual([]);
	});

	it("warns when a relative import crosses a non-root package.json boundary (L431)", () => {
		// importer /proj/pkgs/app/src/a.ts importing ../../lib/x with package.json
		// at /proj/pkgs/lib-boundary... simpler: put the boundary at the dir one
		// level up from the importer and make it a *non-root* package.
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		mockFs.readFileSync.mockImplementation((_path, encoding) =>
			encoding === "utf-8"
				? JSON.stringify({ name: "@scope/pkgs-mid" })
				: JSON.stringify({ private: true }),
		);
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "/proj/lib/x.ts" })],
		});
		const res = checkCrossPackageImports(importer, "pkgs/app/a.ts", graph);
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "cross_package_imports",
			severity: "warning",
			file: importer,
		});
		expect(res[0]?.message).toContain('relative import "../../lib/x"');
		expect(res[0]?.message).toContain("crosses a package.json boundary");
		expect(res[0]?.message).toContain("boundary at pkgs");
	});

	it("does NOT flag when the boundary package.json is a project root (private:true, L417/L423)", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		// private:true marks it a project root => isProjectRoot true => skipped.
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ private: true }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "/proj/lib/x.ts" })],
		});
		expect(checkCrossPackageImports(importer, "pkgs/app/a.ts", graph)).toEqual([]);
	});

	it("does NOT flag when the boundary package.json declares workspaces (L417 second operand)", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ workspaces: ["x/*"] }));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "/proj/lib/x.ts" })],
		});
		expect(checkCrossPackageImports(importer, "pkgs/app/a.ts", graph)).toEqual([]);
	});

	it("flags despite a malformed boundary package.json (L418 catch leaves isProjectRoot false)", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		mockFs.readFileSync.mockReturnValue("{ broken json");
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "/proj/lib/x.ts" })],
		});
		const res = checkCrossPackageImports(importer, "pkgs/app/a.ts", graph);
		// parse threw => isProjectRoot stays false => boundary is flagged.
		expect(res).toHaveLength(1);
		expect(res[0]?.check).toBe("cross_package_imports");
	});

	it("N1: still flags the boundary when the package.json parses to a non-object (isJsonObject guard)", () => {
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/package.json");
		// Valid JSON, but the top level is an array — isJsonObject rejects it, so
		// `pkg.private` / `pkg.workspaces` are never read off a non-record value.
		mockFs.readFileSync.mockReturnValue(JSON.stringify(["not", "an", "object"]));
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../../lib/x", toFile: "/proj/lib/x.ts" })],
		});
		const res = checkCrossPackageImports(importer, "pkgs/app/a.ts", graph);
		expect(res).toHaveLength(1);
		expect(res[0]?.check).toBe("cross_package_imports");
	});

	it("does not treat the importer's own directory package.json as a boundary (L410 dir !== dirname(filePath))", () => {
		// existsSync true ONLY for a package.json in the importer's own dir.
		// The walk starts by going UP one dir, so it never queries the importer's
		// own dir; but to assert the guard, make the *parent* dir match the
		// importer dir test: here only /proj/pkgs/app/package.json (own dir) exists.
		const importer = "/proj/pkgs/app/a.ts";
		mockFs.existsSync.mockImplementation((p) => p === "/proj/pkgs/app/package.json");
		const graph = makeGraph({
			dependencies: [edge({ specifier: "../x", toFile: "/proj/pkgs/x.ts" })],
		});
		// The only existing package.json is the importer's own dir, which the walk
		// (dirname first) skips; nothing else exists => no boundary flagged.
		expect(checkCrossPackageImports(importer, "pkgs/app/a.ts", graph)).toEqual([]);
	});
});
