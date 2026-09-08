import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { claimingProjectRoot } from "./__tests__/self-import-fixture.js";
import {
	checkExtraneousDependencies,
	checkPhantomDependencies,
	checkSelfImport,
	findWorkspaceRootFor,
} from "./agent-safety-deps.js";

// Session review r4, finding 3 (2026-09-05): a file no project claims is NOT
// MEASURED (`[]` here), so the bare-name cases live under a throwaway project
// that claims its whole root; the importer itself is never written.
const at = claimingProjectRoot();

// Smoke-test coverage for the agent-safety dependency-hygiene check family.
// Deeper coverage lives in `src/harness/__tests__/generic-checks-extended-*.test.ts`
// and friends — this file satisfies the harness's per-source-file test rule
// and guards the shape of the exported check functions.

describe("agent-safety deps check surface — smoke", () => {
	it("checkSelfImport returns an array", () => {
		expect(Array.isArray(checkSelfImport("", "a.ts"))).toBe(true);
	});
});

// DEFECT FIXED 2026-08-07. The specifier-extraction regex used to run against
// STRIPPED content, where quoted string CONTENTS are blanked to `""`/`''`.
// `['"]([^'"]+)['"]` requires at least one non-quote character between the
// quotes, which a blanked specifier never has — so `fromMatch` was always null
// and this detector could never flag anything, for any input. The assertions
// below were deliberately pinned to that broken behavior by an earlier session,
// precisely so an accidental "fix" would surface as a flipped assertion rather
// than landing unnoticed. That pin worked: this change is the intentional fix,
// and the assertions are flipped to the CORRECT behavior.
//
// The specifier now comes from the original line; the STRIPPED line still
// decides whether the line looks like an import at all, so a `from "..."` inside
// a comment or string literal is still ignored (see the N-cases below).
describe("checkSelfImport — positive (must fire)", () => {
	it("P1: flags a literal self-import (relative specifier matching the file's own base name)", () => {
		const out = checkSelfImport('import { x } from "./same-file";\n', at("same-file.ts"));
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./same-file";' }]);
	});

	it("P2: flags a self-import written with an explicit .js extension from a .ts file", () => {
		const out = checkSelfImport('import { x } from "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./widget.js";' }]);
	});

	it("N0: does NOT flag an import of a DIFFERENT relative module", () => {
		expect(checkSelfImport('import { x } from "./other";\n', at("widget.ts"))).toEqual([]);
	});

	// The fixture directory must EXIST (it moved from the fictional `src/foo` to
	// this real one on 2026-09-05): resolution runs the compiler against the real
	// tree now, and the compiler will not look inside a directory that is not
	// there. Verdict, assertion count and contract are unchanged.
	it("P3: flags a self-import written as a round trip through the parent (review 2026-09-04)", () => {
		const line = 'import { x } from "../checks/canonical.js";\n';
		expect(checkSelfImport(line, "src/harness/checks/canonical.ts")).toEqual([
			{ line: 1, text: 'import { x } from "../checks/canonical.js";' },
		]);
		expect(checkSelfImport('import { x } from "./sub/../widget.js";\n', at("widget.ts"))).toHaveLength(1);
	});

	it("N0b: does NOT flag a same-BASENAME module in another directory (FP found 2026-09-03)", () => {
		const line = 'import { canonicalJson } from "../../mutation/protocol-v3/canonical.js";\n';
		expect(checkSelfImport(line, "src/harness/shadow/protocol/canonical.ts")).toEqual([]);
		expect(checkSelfImport('import { x } from "../canonical.js";\n', at("canonical.ts"))).toEqual([]);
		expect(checkSelfImport('import { x } from "./sub/widget.js";\n', at("widget.ts"))).toEqual([]);
	});

	// Finding 7 [P2] (2026-09-04): the repaired detector still had deterministic
	// false negatives on shapes with no `from "..."` clause, and treated .mts/.cts
	// unevenly against the other JS/TS extensions. Fixed below.
	it("P4: flags a side-effect self-import (no `from` clause at all)", () => {
		const out = checkSelfImport('import "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'import "./widget.js";' }]);
	});

	it("P5: flags a self-import written as `export { x } from \"...\"`", () => {
		const out = checkSelfImport('export { x } from "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'export { x } from "./widget.js";' }]);
	});

	it("P6: flags a self-import written as `export * from \"...\"`", () => {
		const out = checkSelfImport('export * from "./widget";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'export * from "./widget";' }]);
	});

	it("P7: flags a self-import written as `export * as ns from \"...\"`", () => {
		const out = checkSelfImport('export * as ns from "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'export * as ns from "./widget.js";' }]);
	});

	it("P8: flags a .mts file importing its own .mjs spelling (extension parity)", () => {
		const out = checkSelfImport('import { x } from "./widget.mjs";\n', at("widget.mts"));
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./widget.mjs";' }]);
	});

	it("P9: flags a .cts file self-importing with a .cts extension", () => {
		const out = checkSelfImport('import { x } from "./widget.cts";\n', at("widget.cts"));
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./widget.cts";' }]);
	});

	// Finding 4 [P1] (2026-09-05): the detector stripped EVERY TS/JS-family
	// extension and compared stems, so these three named the importer. They do
	// not: TypeScript resolves `"./widget.mjs"` to widget.mts/.mjs and
	// `"./widget.cjs"` to widget.cts/.cjs, and a `.js` specifier never reaches the
	// .mts family at all. `self_import` is a severity-error `pre_block` rail, so
	// each of these was a valid import refused with no recourse. None of the three
	// touches the filesystem — the importer is not a candidate at all.
	it("N6: does NOT flag `./widget.mjs` from widget.ts — it names widget.mts/.mjs", () => {
		expect(checkSelfImport('export { x } from "./widget.mjs";\n', at("widget.ts"))).toEqual([]);
	});

	it("N7: does NOT flag `./widget.cjs` from widget.ts — it names widget.cts/.cjs", () => {
		expect(checkSelfImport('import { x } from "./widget.cjs";\n', at("widget.ts"))).toEqual([]);
	});

	it("N8: does NOT flag `./widget.js` from widget.mts — .js never reaches the .mts family", () => {
		expect(checkSelfImport('import { x } from "./widget.js";\n', at("widget.mts"))).toEqual([]);
	});

	// Finding 4 [P2] (2026-09-05). The line-oriented parser saw no `from "…"` on
	// the opening line of a multiline declaration, so the reviewer's ordinary
	// `import {\n\tx\n} from "./widget.js";` in widget.ts returned NOTHING from a
	// deterministic pre_block rail. The detector now reads declarations off the
	// TypeScript AST and reports the declaration's START line.
	it("P11: flags the reviewer's multiline self-import at the declaration's START line", () => {
		const out = checkSelfImport('import {\n\tx\n} from "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: "import {" }]);
	});

	it("P12: flags a multiline `export … from` self-re-export", () => {
		const out = checkSelfImport('export {\n\tx,\n} from "./widget.js";\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: "export {" }]);
	});

	it("P13: flags `import x = require(\"./self\")`", () => {
		const out = checkSelfImport('import x = require("./widget.js");\n', at("widget.ts"));
		expect(out).toEqual([{ line: 1, text: 'import x = require("./widget.js");' }]);
	});

	it("P14: flags a dynamic `import(\"./self.js\")` with a string-literal argument", () => {
		const src = 'export async function load() {\n\treturn import("./widget.js");\n}\n';
		expect(checkSelfImport(src, at("widget.ts"))).toEqual([
			{ line: 2, text: 'return import("./widget.js");' },
		]);
	});

	it("N4: does NOT flag a multiline import of a DIFFERENT module", () => {
		expect(checkSelfImport('import {\n\tx\n} from "./other.js";\n', at("widget.ts"))).toEqual([]);
	});

	it("N5: does NOT flag a dynamic import whose argument is a variable", () => {
		const src = 'const p = "./widget.js";\nexport function f() {\n\treturn import(p);\n}\n';
		expect(checkSelfImport(src, at("widget.ts"))).toEqual([]);
	});

	it("P10: flags a self-import through a nested platform-style path", () => {
		const line = 'import { x } from "../protocol/canonical.js";\n';
		expect(checkSelfImport(line, "src/harness/shadow/protocol/canonical.ts")).toEqual([
			{ line: 1, text: 'import { x } from "../protocol/canonical.js";' },
		]);
	});

	it("N1: does NOT flag a side-effect import of a DIFFERENT module", () => {
		expect(checkSelfImport('import "./other.js";\n', at("widget.ts"))).toEqual([]);
	});

	it("N2: does NOT flag `export * from \"...\"` naming a different module", () => {
		expect(checkSelfImport('export * from "./other.js";\n', at("widget.ts"))).toEqual([]);
	});

	it("N3: does NOT flag a same-basename .mts/.cts pair in different directories", () => {
		const line = 'import { x } from "../../other/widget.mjs";\n';
		expect(checkSelfImport(line, "src/harness/widget.mts")).toEqual([]);
	});

	it("returns [] for a non-JS/TS extension", () => {
		const out = checkSelfImport('import x from "./thing";\n', "thing.py");
		expect(out).toEqual([]);
	});

	it("returns [] when the import specifier is not relative (bare specifier)", () => {
		const out = checkSelfImport('import x from "thing";\n', at("thing.ts"));
		expect(out).toEqual([]);
	});

	it("returns [] for a line that isn't an import statement at all", () => {
		const out = checkSelfImport("const x = 1;\n", at("same-file.ts"));
		expect(out).toEqual([]);
	});
});

describe("findWorkspaceRootFor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the immediate package dir when no workspace marker exists", () => {
		const pkgDir = join(tmp, "solo");
		mkdirSync(pkgDir);
		writeFileSync(join(pkgDir, "package.json"), "{}");
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});

	it("walks up to a parent with `workspaces` field", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});

	it("walks up to a parent with `pnpm-workspace.yaml`", () => {
		writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const pkgDir = join(tmp, "packages", "bar");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "bar" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});
});

describe("_resolvePackageDeps / _loadPackageDeps — malformed package.json", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "malformed-pkg-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] (pkgDeps undefined) when the nearest package.json is not valid JSON", () => {
		writeFileSync(join(tmp, "package.json"), "{ not valid json");
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("does not throw when package.json has NO dependencies/devDependencies fields at all", () => {
		// Exercises the `|| {}` fallback for every one of the four dep-kind keys.
		writeFileSync(join(tmp, "package.json"), "{}");
		expect(() =>
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).not.toThrow();
	});

	it("reaches the filesystem root without finding a package.json (5-level walk exhausted or root hit)", () => {
		// A deep tmp subtree with no package.json anywhere in its ancestry up to
		// the filesystem root — walks past 5 levels or hits `parent === pkgDir`.
		const deep = join(tmp, "a", "b", "c", "d", "e", "f");
		mkdirSync(deep, { recursive: true });
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(deep, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("stops at `parent === pkgDir` when the walk reaches the filesystem root within 5 hops", () => {
		// A path one level below the filesystem root: after the first miss, the
		// second hop's `dirname("/")` is `"/"` again — `parent === pkgDir` fires.
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			"/__interlinked_agent_safety_deps_root_probe__/index.ts",
		);
		expect(out).toEqual([]);
	});

	it("N1: treats a non-object (`null`) package.json as unusable rather than reading fields off it", () => {
		writeFileSync(join(tmp, "package.json"), "null");
		expect(() =>
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).not.toThrow();
		expect(
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).toEqual([]);
	});
});

describe("findWorkspaceRootFor — parent package.json without a `workspaces` field", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-noworkspaces-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("keeps walking past a parent package.json that has no `workspaces` field", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root-no-ws" }));
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});

	it("N1: keeps walking past a parent package.json that parses to `null`", () => {
		// isJsonObject(null) is false, so `json.workspaces` is never read off a
		// non-object value — the walk treats it the same as "no workspaces field"
		// rather than relying on the surrounding catch to swallow a TypeError.
		writeFileSync(join(tmp, "package.json"), "null");
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});
});

describe("checkPhantomDependencies — early-return edge cases", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-edge-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] when the package.json path does not exist", () => {
		expect(checkPhantomDependencies(join(tmp, "nope", "package.json"))).toEqual([]);
	});

	it("returns [] when package.json is not valid JSON", () => {
		writeFileSync(join(tmp, "package.json"), "{ not valid json");
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("returns [] when `dependencies` is present but not an object (malformed field)", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: "not-an-object" }));
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("N1: does not throw when package.json parses to `null`", () => {
		// Pre-fix, `pkg.dependencies` ran AFTER the try/catch closed, so a
		// legally-parsed `null` (JSON.parse("null") === null, valid JSON)
		// threw a TypeError uncaught instead of returning [].
		writeFileSync(join(tmp, "package.json"), "null");
		expect(() => checkPhantomDependencies(join(tmp, "package.json"))).not.toThrow();
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("N2: returns [] when `dependencies` is an array instead of a keyed object", () => {
		// Pre-fix, `typeof deps !== "object"` admitted arrays (typeof [] ===
		// "object"), so Object.keys would have read back numeric-index
		// strings ("0", "1", ...) as fake dependency names.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: ["not", "an", "object"] }),
		);
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("returns [] when `dependencies` is an empty object", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("skips @types/* packages (type-only, never imported at runtime)", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "@types/node": "1.0.0" } }),
		);
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("falls back to line 1 when the phantom dep name has no literal quoted match in raw content", () => {
		// The dep name contains a unicode-escaped character in the JSON literal
		// (`é`), so the raw file text never contains the literal quoted
		// decoded name — `lines.findIndex` returns -1 and the ternary falls back
		// to line 1.
		const rawJson = '{\n  "dependencies": {\n    "caf\\u00e9-pkg": "1.0.0"\n  }\n}\n';
		writeFileSync(join(tmp, "package.json"), rawJson);
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		const out = checkPhantomDependencies(join(tmp, "package.json"));
		expect(out).toEqual([
			{
				line: 1,
				text:
					'Phantom dependency: "café-pkg" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.',
			},
		]);
	});
});

describe("checkPhantomDependencies — the 10-match cap", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-cap-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("stops reporting after 10 phantom dependencies even when 12 are declared and unreferenced", () => {
		const deps: Record<string, string> = {};
		for (let i = 0; i < 12; i++) deps[`phantom-pkg-${i}`] = "1.0.0";
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: deps }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		const out = checkPhantomDependencies(join(tmp, "package.json"));
		expect(out).toHaveLength(10);
	});
});

describe("checkPhantomDependencies — workspace awareness", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-ws-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("does NOT flag a dep imported only by a sibling workspace package", () => {
		// Workspace root with `workspaces` field
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);

		// packages/foo declares the dep but doesn't import it anywhere in its own dir
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({ name: "foo", dependencies: { "@scoped/util": "1.0.0" } }),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		// packages/bar imports the dep — that's the cross-workspace usage that
		// the single-dir grep (pre-fix) missed.
		const barDir = join(tmp, "packages", "bar");
		mkdirSync(barDir, { recursive: true });
		writeFileSync(
			join(barDir, "package.json"),
			JSON.stringify({ name: "bar" }),
		);
		writeFileSync(
			join(barDir, "consumer.ts"),
			'import { foo } from "@scoped/util";\nconsole.log(foo);\n',
		);

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toEqual([]);
	});

	it("flags a dep that's nowhere in the workspace", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({
				name: "foo",
				dependencies: { "totally-unused-pkg": "1.0.0" },
			}),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("totally-unused-pkg");
	});
});

// Characterization coverage for `checkExtraneousDependencies`, added ahead of
// a cyclomatic-complexity decomposition (fn was over the per-fn cap) so the
// refactor has a behavioral safety net. Each tmp dir gets its own
// package.json so the internal per-directory dependency cache can't leak
// state between cases.
//
// KNOWN DEFECT (verified 2026-08-01, preserved as-is — out of scope for the
// complexity decomposition): the specifier-extraction regex runs against
// `stripCommentsAndStrings(content)`, which blanks the CONTENTS of every
// quoted string to `""`/`''` (see `stripStrings` in shared-text-utils.ts).
// The `['"]([^'"]+)['"]` capture then requires at least one non-quote
// character, which the blanked specifier never has — so `fromMatch` is
// always null and the function never actually flags a real import/require
// line, regardless of whether the package is declared. Tests below assert
// the function's TRUE current behavior (always `[]` on realistic input) so
// an accidental behavior change during decomposition — e.g. reading the
// specifier from `originalLines` instead of `strippedLines`, which would
// silently "fix" this and flip these assertions — gets caught.
describe("checkExtraneousDependencies", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "extraneous-deps-"));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				dependencies: { lodash: "1.0.0", "@scope/present": "1.0.0" },
				devDependencies: { vitest: "1.0.0" },
			}),
		);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Assertions flipped 2026-08-07 with the specifier-extraction fix — see the
	// note above `checkSelfImport`. These previously pinned the dead behavior.
	it("P1: flags a bare import for a package missing from package.json", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import foo from "not-a-real-dep";' }]);
	});

	it("N1: does NOT flag an import for a declared dependency", () => {
		const out = checkExtraneousDependencies('import _ from "lodash";\n', join(tmp, "index.ts"));
		expect(out).toEqual([]);
	});

	it("P2: flags a missing SCOPED package", () => {
		const out = checkExtraneousDependencies(
			'import { z } from "@scope/missing-pkg";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import { z } from "@scope/missing-pkg";' }]);
	});

	it("P3: flags a bare require() for a missing package", () => {
		const out = checkExtraneousDependencies(
			'const x = require("not-a-real-dep");\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'const x = require("not-a-real-dep");' }]);
	});

	it("returns [] for a non-JS/TS file", () => {
		const out = checkExtraneousDependencies("import not_a_real_dep\n", join(tmp, "index.py"));
		expect(out).toEqual([]);
	});

	it("returns [] for a test file", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.test.ts"),
		);
		expect(out).toEqual([]);
	});

	it("returns [] when no package.json is found within 5 levels", () => {
		// Isolated tmp tree with no package.json anywhere in its ancestry
		// (unlike `tmp`, which has one written in beforeEach). Exercises the
		// early `!pkgDeps` return — a different code path than the cases
		// above (which all find package.json but never match a specifier),
		// even though the observable output is the same empty array.
		const orphan = mkdtempSync(join(tmpdir(), "extraneous-deps-orphan-"));
		try {
			const out = checkExtraneousDependencies(
				'import foo from "not-a-real-dep";\n',
				join(orphan, "index.ts"),
			);
			expect(out).toEqual([]);
		} finally {
			rmSync(orphan, { recursive: true, force: true });
		}
	});

	it("does not throw across repeated calls in the same directory (package.json cache path)", () => {
		expect(() => {
			checkExtraneousDependencies('import a from "pkg-a";\n', join(tmp, "one.ts"));
			checkExtraneousDependencies('import b from "pkg-b";\n', join(tmp, "two.ts"));
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Review finding 1 [P1] (2026-09-05, seventh pass): `checkSelfImport` end to end
// against a REAL project, with the real-filesystem probe and a real tsconfig —
// the registry calls it with exactly these two arguments, so this is the surface
// the pre_block rail actually blocks on. The reviewer's reproduction is the
// first case: `moduleSuffixes`, carried in through an `extends` chain, sends
// `"./widget.js"` to a sibling module, and a valid edit must not be refused.
// ---------------------------------------------------------------------------

describe("checkSelfImport — resolved under the project's own compiler options", () => {
	let root: string;
	const SELF_IMPORT = 'export { x } from "./widget.js";\n';

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "self-import-project-"));
		mkdirSync(join(root, "cfg"));
		mkdirSync(join(root, "src"));
		writeFileSync(
			join(root, "cfg", "base.json"),
			JSON.stringify({ compilerOptions: { moduleSuffixes: [".native", ""] } }),
		);
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({
				extends: "./cfg/base.json",
				compilerOptions: { moduleResolution: "bundler", module: "esnext" },
			}),
		);
		writeFileSync(join(root, "src", "widget.ts"), "export const x = 1;\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// test-contract: bug — reviewer-reproduced with TypeScript 5.9.3: the
	// candidate table blocked this edit because it could not see moduleSuffixes.
	it("N9: does NOT flag when an extends chain's moduleSuffixes names a sibling module", () => {
		writeFileSync(join(root, "src", "widget.native.ts"), "export const x = 1;\n");
		expect(checkSelfImport(SELF_IMPORT, join(root, "src", "widget.ts"))).toEqual([]);
	});

	// test-contract: invariant — the fix must not cost the true positive: with no
	// suffixed sibling the empty suffix wins and the import IS a self-import.
	it("P15: still flags the same import in the same project once the sibling is gone", () => {
		expect(checkSelfImport(SELF_IMPORT, join(root, "src", "widget.ts"))).toEqual([
			{ line: 1, text: 'export { x } from "./widget.js";' },
		]);
	});

	// test-contract: invariant — a config the compiler rejects yields NO findings
	// rather than findings from a guessed configuration.
	it("N10: reports nothing when the project's tsconfig cannot be parsed", () => {
		writeFileSync(join(root, "tsconfig.json"), "{ not json ,,, }");
		expect(checkSelfImport(SELF_IMPORT, join(root, "src", "widget.ts"))).toEqual([]);
	});
});
