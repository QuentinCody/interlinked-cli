import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimingProjectRoot } from "./__tests__/self-import-fixture.js";
import {
	type ExistsProbe,
	resolvesToSelf,
	scanSelfImports,
	selfImportMeasurable,
	selfImportNotMeasuredWarning,
} from "./self-import-scan.js";

// Finding 4 [P2] (2026-09-05): the pre-AST detector extracted specifiers ONE
// SOURCE LINE at a time, so an ordinary multiline import returned no finding.
// The cases below pin the AST pass over every module-reference shape, in both
// directions. The "typescript absent" state has no fallback scan at all — it is
// NOT MEASURED, pinned in self-import-scan.unavailable.test.ts.

// Session review r4, finding 3 (2026-09-05): a file no project claims is NOT
// MEASURED (null / false) — never resolved under a guessed configuration — and
// a bare "widget.ts" resolves against the process cwd, where this repo's
// tsconfig includes only `src`. So every bare-name case below lives under a
// throwaway project that claims its whole root; the importer is never written.
const at = claimingProjectRoot();

const MULTILINE_IMPORT = 'import {\n\tx\n} from "./widget.js";\n';

describe("scanSelfImports — positive (must fire)", () => {
	it("P1: flags the reviewer's exact multiline self-import and reports the START line", () => {
		expect(scanSelfImports(MULTILINE_IMPORT, at("widget.ts"))).toEqual([
			{ line: 1, text: "import {" },
		]);
	});

	it("P2: flags a single-line named self-import", () => {
		expect(scanSelfImports('import { x } from "./widget.js";\n', at("widget.ts"))).toEqual([
			{ line: 1, text: 'import { x } from "./widget.js";' },
		]);
	});

	it("P3: flags a side-effect self-import (no `from` clause)", () => {
		expect(scanSelfImports('import "./widget.js";\n', at("widget.ts"))).toEqual([
			{ line: 1, text: 'import "./widget.js";' },
		]);
	});

	it("P4: flags `export { x } from` naming the file itself", () => {
		expect(scanSelfImports('export { x } from "./widget.js";\n', at("widget.ts"))).toEqual([
			{ line: 1, text: 'export { x } from "./widget.js";' },
		]);
	});

	it("P5: flags `export * from` naming the file itself", () => {
		expect(scanSelfImports('export * from "./widget";\n', at("widget.ts"))).toEqual([
			{ line: 1, text: 'export * from "./widget";' },
		]);
	});

	it("P6: flags `export * as ns from` naming the file itself", () => {
		expect(scanSelfImports('export * as ns from "./widget.js";\n', at("widget.ts"))).toEqual([
			{ line: 1, text: 'export * as ns from "./widget.js";' },
		]);
	});

	it("P7: flags a multiline `export … from` and reports the START line", () => {
		const src = 'const a = 1;\nexport {\n\tx,\n} from "./widget.js";\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([{ line: 2, text: "export {" }]);
	});

	it("P8: flags `import x = require(\"./x\")`", () => {
		const src = 'import x = require("./widget.js");\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([
			{ line: 1, text: 'import x = require("./widget.js");' },
		]);
	});

	it("P9: flags a dynamic `import(\"./x.js\")` with a string-literal argument", () => {
		const src = 'async function load() {\n\treturn await import("./widget.js");\n}\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([
			{ line: 2, text: 'return await import("./widget.js");' },
		]);
	});

	// The fixture directory must EXIST (it moved from the fictional `src/foo` to
	// this real one on 2026-09-05): resolution now runs the compiler against the
	// real tree, and the compiler refuses to look inside a directory that is not
	// there. Same verdict, same contract — a `..` round trip back into the
	// importer's own directory is still a self-import.
	it("P10: flags a self-import written as a round trip through the parent", () => {
		const src = 'import { x } from "../checks/canonical.js";\n';
		expect(scanSelfImports(src, "src/harness/checks/canonical.ts")).toEqual([
			{ line: 1, text: 'import { x } from "../checks/canonical.js";' },
		]);
	});

	it("P11: caps the report at five findings", () => {
		const src = Array.from({ length: 9 }, () => 'import "./widget.js";').join("\n");
		expect(scanSelfImports(src, at("widget.ts"))).toHaveLength(5);
	});

	it("P12: reports findings in source order across mixed shapes", () => {
		const src = ['import "./widget.js";', 'export * from "./widget.js";'].join("\n");
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([
			{ line: 1, text: 'import "./widget.js";' },
			{ line: 2, text: 'export * from "./widget.js";' },
		]);
	});

	it("P13: is measurable while the optional typescript dep resolves, so no NOT MEASURED warning is emitted", () => {
		expect(selfImportMeasurable()).toBe(true);
		expect(selfImportNotMeasuredWarning(at("widget.ts"))).toBeNull();
	});
});

describe("scanSelfImports — negative (must not fire)", () => {
	it("N1: does NOT flag a same-BASENAME module in another directory", () => {
		const src = 'import { canonicalJson } from "../../mutation/protocol-v3/canonical.js";\n';
		expect(scanSelfImports(src, "src/harness/shadow/protocol/canonical.ts")).toEqual([]);
	});

	it("N2: does NOT flag `../` above a bare root", () => {
		expect(scanSelfImports('import { x } from "../canonical.js";\n', at("canonical.ts"))).toEqual([]);
	});

	it("N3: does NOT flag a multiline import of a DIFFERENT module", () => {
		const src = 'import {\n\tx\n} from "./other.js";\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([]);
	});

	it("N4: does NOT flag a bare (non-relative) specifier", () => {
		expect(scanSelfImports('import x from "widget";\n', at("widget.ts"))).toEqual([]);
	});

	it("N5: does NOT flag a self-path that only appears in a comment or string", () => {
		const src = '// import { x } from "./widget.js";\nconst s = \'from "./widget.js"\';\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([]);
	});

	it("N6: does NOT flag a dynamic import whose argument is not a string literal", () => {
		const src = 'const p = "./widget.js";\nasync function f() {\n\treturn import(p);\n}\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([]);
	});

	it("N7: does NOT flag `import x = require(\"pkg\")` for a bare specifier", () => {
		expect(scanSelfImports('import x = require("widget");\n', at("widget.ts"))).toEqual([]);
	});

	it("N8: does NOT flag a subdirectory module sharing the file's basename", () => {
		expect(scanSelfImports('import { x } from "./sub/widget.js";\n', at("widget.ts"))).toEqual([]);
	});

	it("N9: returns [] for source with no module references at all", () => {
		expect(scanSelfImports("const x = 1;\n", at("widget.ts"))).toEqual([]);
	});

	it("N10: does NOT flag a namespace alias whose TRAILING COMMENT mentions the file (the retired line scanner did)", () => {
		// `import x = Existing.Namespace` is an entity-name alias, not a module
		// reference; the `from "./widget.js"` lives in a comment. The old
		// line-oriented fallback matched that comment and produced a false
		// positive on a pre_block check (sixth review pass, finding 1).
		const src = 'import alias = Existing.Namespace; // from "./widget.js"\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([]);
	});

	it("N11: does NOT flag a self-path inside a template literal or a regex literal", () => {
		const src = 'const t = `from "./widget.js"`;\nconst r = /from ".\\/widget.js"/;\n';
		expect(scanSelfImports(src, at("widget.ts"))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Finding 4 [P1] (2026-09-05): extension FAMILIES.
//
// The stem comparison this replaced stripped every TS/JS-family extension and
// compared what was left, so `export { x } from "./widget.mjs";` inside
// `widget.ts` was called a self-import — but TypeScript resolves `"./widget.mjs"`
// to sibling `widget.mts` / `widget.mjs`, a DIFFERENT module. `self_import` is a
// severity-error `pre_block` rail, so that is a refused edit with no recourse.
//
// The resolver now walks TypeScript's own candidate list in TypeScript's own
// order and answers "self" only when the importer IS a candidate and no
// higher-priority sibling exists. `self-import-scan.resolution.test.ts` proves
// the table against `ts.resolveModuleName` itself; the cases here pin the
// individual verdicts that matter to the check's contract.
// ---------------------------------------------------------------------------

/** An empty tree: the importer is the only file that exists. */
const noSiblings: ExistsProbe = () => false;

/** A tree holding exactly the named siblings, spelled relative to the fixture
 *  root (the resolver probes them by the importer's own directory). */
function siblings(...present: string[]): ExistsProbe {
	return (path) => present.some((name) => resolve(path) === at(name));
}

describe("resolvesToSelf — extension families, negative (must not fire)", () => {
	it("N12: does NOT flag `./widget.mjs` from widget.ts — it names widget.mts/.mjs", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.mjs", noSiblings)).toBe(false);
	});

	it("N13: does NOT flag `./widget.cjs` from widget.ts — it names widget.cts/.cjs", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.cjs", noSiblings)).toBe(false);
	});

	it("N14: does NOT flag `./widget.mts` from widget.ts", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.mts", noSiblings)).toBe(false);
	});

	it("N15: does NOT flag `./widget.cts` from widget.ts", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.cts", noSiblings)).toBe(false);
	});

	it("N16: does NOT flag `./widget.js` from widget.mts — .js never reaches the .mts family", () => {
		expect(resolvesToSelf(at("widget.mts"), "./widget.js", noSiblings)).toBe(false);
	});

	it("N17: does NOT flag an extensionless `./widget` from widget.mts", () => {
		expect(resolvesToSelf(at("widget.mts"), "./widget", noSiblings)).toBe(false);
	});

	it("N18: does NOT flag `./widget.js` from widget.cts", () => {
		expect(resolvesToSelf(at("widget.cts"), "./widget.js", noSiblings)).toBe(false);
	});

	it("N19: does NOT flag `./widget` from widget.tsx when sibling widget.ts exists", () => {
		expect(resolvesToSelf(at("widget.tsx"), "./widget", siblings("widget.ts"))).toBe(false);
	});

	it("N20: does NOT flag `./widget.js` from widget.tsx when sibling widget.ts exists", () => {
		expect(resolvesToSelf(at("widget.tsx"), "./widget.js", siblings("widget.ts"))).toBe(false);
	});

	it("N21: does NOT flag `./widget.js` from widget.js when sibling widget.ts exists", () => {
		expect(resolvesToSelf(at("widget.js"), "./widget.js", siblings("widget.ts"))).toBe(false);
		// A MEASURED false: the .js importer is a member of the fixture project
		// by pattern although the project never enables `allowJs`.
		expect(selfImportNotMeasuredWarning(at("widget.js"))).toBeNull();
	});

	it("N22: does NOT flag `./widget.jsx` from widget.ts when sibling widget.tsx exists", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.jsx", siblings("widget.tsx"))).toBe(false);
	});

	it("N23: does NOT flag `./widget.tsx` from widget.ts when sibling widget.tsx exists", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.tsx", siblings("widget.tsx"))).toBe(false);
	});

	it("N24: does NOT flag the same-directory sibling that shadows a .d.ts importer", () => {
		expect(resolvesToSelf(at("widget.d.ts"), "./widget.js", siblings("widget.ts"))).toBe(false);
	});

	// Fixture directory moved from the fictional `src/foo` to a real one on
	// 2026-09-05 for the same reason as P10 above: the compiler will not probe
	// inside a directory that does not exist.
	it("N25: reads the tree at the importer's OWN directory, not the process cwd", () => {
		const probe = vi.fn<ExistsProbe>(() => true);
		expect(resolvesToSelf("src/harness/checks/widget.tsx", "./widget.js", probe)).toBe(false);
		expect(probe).toHaveBeenCalledWith("src/harness/checks/widget.ts");
	});

	it("N26: does NOT flag the reviewer's `export … from \"./widget.mjs\"` through the AST pass", () => {
		const src = 'export { x } from "./widget.mjs";\n';
		expect(scanSelfImports(src, at("widget.ts"), noSiblings)).toEqual([]);
	});

	it("N27: does NOT flag `import … from \"./widget.cjs\"` through the AST pass", () => {
		const src = 'import { x } from "./widget.cjs";\n';
		expect(scanSelfImports(src, at("widget.ts"), noSiblings)).toEqual([]);
	});

	it("N28: does NOT flag `./widget.js` from widget.js.ts when widget.ts shadows the append pass", () => {
		expect(resolvesToSelf(at("widget.js.ts"), "./widget.js", siblings("widget.ts"))).toBe(false);
	});
});

describe("resolvesToSelf — extension families, positive (must fire)", () => {
	it("P14: flags `./widget.js` from widget.ts without touching the filesystem", () => {
		const probe = vi.fn<ExistsProbe>(() => false);
		expect(resolvesToSelf(at("widget.ts"), "./widget.js", probe)).toBe(true);
		expect(probe).not.toHaveBeenCalled();
	});

	it("P15: flags an extensionless `./widget` from widget.ts", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget", noSiblings)).toBe(true);
	});

	it("P16: flags `./widget.ts` from widget.ts", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.ts", noSiblings)).toBe(true);
	});

	it("P17: flags `./widget.mjs` from widget.mts — the .mts family's own spelling", () => {
		expect(resolvesToSelf(at("widget.mts"), "./widget.mjs", noSiblings)).toBe(true);
	});

	it("P18: flags `./widget.mts` from widget.mts", () => {
		expect(resolvesToSelf(at("widget.mts"), "./widget.mts", noSiblings)).toBe(true);
	});

	it("P19: flags `./widget.cjs` from widget.cts", () => {
		expect(resolvesToSelf(at("widget.cts"), "./widget.cjs", noSiblings)).toBe(true);
	});

	it("P20: flags `./widget.cts` from widget.cts", () => {
		expect(resolvesToSelf(at("widget.cts"), "./widget.cts", noSiblings)).toBe(true);
	});

	it("P21: flags `./widget` from widget.tsx when NO widget.ts sibling exists", () => {
		expect(resolvesToSelf(at("widget.tsx"), "./widget", noSiblings)).toBe(true);
	});

	it("P22: flags `./widget.js` from widget.d.ts when no widget.ts/.tsx sibling exists", () => {
		expect(resolvesToSelf(at("widget.d.ts"), "./widget.js", noSiblings)).toBe(true);
	});

	// TypeScript tries `.tsx` then `.ts` for a `.tsx`/`.jsx` specifier (measured,
	// see the resolution test), so with no `.tsx` sibling on disk BOTH of these
	// really do resolve back to widget.ts — they are self-imports, not the
	// cross-family case N22/N23 pins.
	it("P23: flags `./widget.tsx` from widget.ts when no widget.tsx sibling exists", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.tsx", noSiblings)).toBe(true);
	});

	it("P24: flags `./widget.jsx` from widget.ts when no widget.tsx/.jsx sibling exists", () => {
		expect(resolvesToSelf(at("widget.ts"), "./widget.jsx", noSiblings)).toBe(true);
	});

	it("P25: treats a probe that throws as an absent sibling rather than crashing", () => {
		const throwing: ExistsProbe = () => {
			throw new Error("EACCES");
		};
		expect(resolvesToSelf(at("widget.tsx"), "./widget", throwing)).toBe(true);
	});

	// TypeScript falls back to appending extensions to the FULL specifier once
	// every substitution misses, so `"./widget.js"` inside `widget.js.ts` really
	// does resolve to the importer — but only while no widget.ts/.tsx/.d.ts/.js
	// sibling shadows it. Both halves are proven against the compiler in
	// self-import-scan.resolution.test.ts (D3).
	it("P27: flags `./widget.js` from widget.js.ts when nothing shadows the append pass", () => {
		expect(resolvesToSelf(at("widget.js.ts"), "./widget.js", noSiblings)).toBe(true);
	});

});

// ---------------------------------------------------------------------------
// Review finding 1 [P1] (2026-09-05, seventh pass): resolution runs the
// PROJECT's compiler, so it now has two more ways to be honestly unavailable —
// a tsconfig it cannot parse, and a directory that is not on disk. Both are NOT
// MEASURED (null, plus a disclosure), never a guess and never a block.
// `self-import-resolve.test.ts` owns the discovery matrix; these pin what the
// SCAN does with each answer.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

/** A throwaway project on the real filesystem. */
function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "self-import-scan-"));
	tempRoots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SELF_IMPORT = 'import { x } from "./widget.js";\n';

describe("scanSelfImports — NOT MEASURED, disclosed rather than guessed", () => {
	it("N29: returns null (not []) when the governing tsconfig cannot be parsed", () => {
		const root = project({ "tsconfig.json": "{ not json ,,, }", "src/widget.ts": "" });
		expect(scanSelfImports(SELF_IMPORT, join(root, "src/widget.ts"))).toBeNull();
	});

	it("N30: discloses the unparsable config in the NOT MEASURED warning", () => {
		const root = project({ "tsconfig.json": "{ not json ,,, }", "src/widget.ts": "" });
		const warning = selfImportNotMeasuredWarning(join(root, "src/widget.ts"));
		expect(warning).toContain("NOT MEASURED");
		expect(warning).toContain(join(root, "tsconfig.json"));
	});

	it("N31: returns null for a file whose directory is not on disk — no tree to resolve in", () => {
		expect(scanSelfImports(SELF_IMPORT, "no/such/dir/widget.ts")).toBeNull();
	});

	it("N32: discloses the missing directory in the NOT MEASURED warning", () => {
		const warning = selfImportNotMeasuredWarning("no/such/dir/widget.ts");
		expect(warning).toContain("NOT MEASURED");
		expect(warning).toContain("directory is not on disk yet");
	});

	it("P28: measures normally — and stays silent — for a file in a parsable project", () => {
		const root = project({
			"tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }),
			"src/widget.ts": "",
		});
		const importer = join(root, "src/widget.ts");
		expect(scanSelfImports(SELF_IMPORT, importer)).toEqual([
			{ line: 1, text: 'import { x } from "./widget.js";' },
		]);
		expect(selfImportNotMeasuredWarning(importer)).toBeNull();
	});

	// test-contract: bug — the reviewer's reproduction, end to end through the
	// scan with the REAL filesystem: moduleSuffixes sends `"./widget.js"` to the
	// sibling, so the pre_block rail must report nothing.
	it("N33: reports nothing when moduleSuffixes routes the specifier to a sibling", () => {
		const root = project({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { moduleResolution: "bundler", moduleSuffixes: [".native", ""] },
			}),
			"src/widget.ts": "",
			"src/widget.native.ts": "",
		});
		expect(scanSelfImports(SELF_IMPORT, join(root, "src/widget.ts"))).toEqual([]);
	});
});
