import { describe, expect, it } from "vitest";
import { findDeadExports, findDeadTypeExports } from "./dead-exports-inline.js";

/**
 * Regression corpus from a live FP report (mcp-client-bio, 2026-07-28): the
 * detector flagged `describeUpstreamError` (imported by two sibling files),
 * and `registerSearch` / `registerGeneLookup` (consumed by the package entry
 * point) as unused. Root causes covered here: `.js` ESM specifiers not lining
 * up with `.ts` sources, re-export barrels not counting as consumption, and —
 * the umbrella — flagging EVERYTHING when the resolver produced no evidence.
 */
function repo(files: Record<string, string>) {
	return {
		listFiles: () => Object.keys(files),
		readFile: (p: string) => files[p] ?? null,
	};
}

const args = (file: string, content: string, cwd = "/repo") => ({
	content,
	filePath: file,
	cwd,
});

describe("findDeadExports — positive (must fire)", () => {
	it("P1: flags an export nothing imports, when resolution is proven working", () => {
		// `used` is imported (proving the resolver works for this pair); `dead`
		// is not — only `dead` may fire.
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});
});

describe("findDeadExports — negative (must not fire)", () => {
	it("N7: a 'public API' doc comment above the export suppresses it (the escape the message promises)", () => {
		// The finding text has always said "remove or document as public API";
		// this is the documenting convention actually honored.
		const files = {
			"src/lib.ts":
				"export const used = 1;\n/**\n * Deliberately part of the public API for external analyzers.\n */\nexport const seam = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("N8: a line-comment 'public API' marker directly above also suppresses", () => {
		const files = {
			"src/lib.ts":
				"export const used = 1;\n// public API — consumed by downstream repos\nexport const seam = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("P2: an unrelated comment above the export does NOT suppress", () => {
		const files = {
			"src/lib.ts":
				"export const used = 1;\n// helper for the thing\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N1: a sibling importing via a .js ESM specifier counts (the upstream-error case)", () => {
		const files = {
			"src/lib/upstream-error.ts":
				"export function describeUpstreamError(): string {\n\treturn 'x';\n}\n",
			"src/tools/gene-lookup.ts":
				'import { describeUpstreamError } from "../lib/upstream-error.js";\ndescribeUpstreamError();\n',
		};
		const out = findDeadExports(
			args("src/lib/upstream-error.ts", files["src/lib/upstream-error.ts"]),
			repo(files),
		);
		expect(out).toEqual([]);
	});

	it("N2: a named re-export barrel counts as consumption (the registerSearch case)", () => {
		const files = {
			"src/tools/search.ts": "export function registerSearch(): void {}\n",
			"src/index.ts": 'export { registerSearch } from "./tools/search.js";\n',
		};
		const out = findDeadExports(args("src/tools/search.ts", files["src/tools/search.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("P5: remedy names the un-export fix when the symbol is still used in its own file", () => {
		const files = {
			"src/lib.ts":
				"export const used = 1;\nexport function dead(): number { return 2; }\nconst v = dead();\nconsole.log(v);\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([
			expect.stringContaining("still used inside this file"),
		]);
	});

	it("P6: remedy names deletion when the symbol has no references at all", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("no references anywhere")]);
	});

	it("N17: an inline type specifier (`import { type Foo }`) counts as consumption", () => {
		// Regression: symbolsOf used to parse the specifier as the literal name
		// "type Foo", so the consumption was invisible and Foo was flagged.
		const files = {
			"src/lib.ts": "export const used = 1;\nexport class Foo {}\n",
			"src/main.ts":
				'import { used, type Foo } from "./lib.js";\nconsole.log(used);\nexport function f(x: Foo): Foo { return x; }\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("N18: a dynamic `import(\"./mod\")` marks the whole module consumed", () => {
		// Lazy runtime loads and `import("./mod").Foo` type positions have no
		// named clause — a resolving dynamic edge must count as namespace use.
		const files = {
			"src/lazy.ts": "export const heavy = 1;\n",
			"src/main.ts": 'export async function load() {\n\treturn import("./lazy.js");\n}\n',
		};
		const out = findDeadExports(args("src/lazy.ts", files["src/lazy.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("P4: a dynamic import of a DIFFERENT module is not evidence for this one", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts":
				'import { used } from "./lib.js";\nconsole.log(used);\nexport const p = import("./other.js");\n',
			"src/other.ts": "export const o = 1;\n",
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("P7: findDeadTypeExports flags an interface nothing imports (value lane stays silent about it)", () => {
		const files = {
			"src/lib.ts":
				"export const used = 1;\nexport interface DeadShape { id: string }\nexport type DeadAlias = number;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const typeOut = findDeadTypeExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(typeOut.map((m) => m.text)).toEqual([
			expect.stringContaining("'DeadShape'"),
			expect.stringContaining("'DeadAlias'"),
		]);
		const valueOut = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(valueOut).toEqual([]);
	});

	it("N19: a type consumed via `import type { … }` is not a dead type export", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport interface LiveShape { id: string }\n",
			"src/main.ts":
				'import { used } from "./lib.js";\nimport type { LiveShape } from "./lib.js";\nexport function f(x: LiveShape): number { return Number(x.id) + used; }\n',
		};
		const out = findDeadTypeExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("N3: a wildcard re-export makes every export potentially consumed", () => {
		const files = {
			"src/api.ts": "export const a = 1;\nexport const b = 2;\n",
			"src/index.ts": 'export * from "./api.js";\n',
		};
		expect(findDeadExports(args("src/api.ts", files["src/api.ts"]), repo(files))).toEqual([]);
	});

	it("N4: EVIDENCE GUARD — mentioned by other files but zero edges resolve ⇒ silent", () => {
		// The umbrella failure: the module's name appears in imports the resolver
		// cannot line up (path aliases, unusual layouts). Flagging every export in
		// that state is how one resolver gap became a page of false debt. A
		// heuristic with no evidence must say nothing.
		const files = {
			"src/thing.ts": "export const x = 1;\nexport const y = 2;\n",
			"src/user.ts": 'import { x } from "@aliased/thing";\nconsole.log(x);\n',
		};
		expect(findDeadExports(args("src/thing.ts", files["src/thing.ts"]), repo(files))).toEqual([]);
	});

	it("N5: a file mentioned by NOBODY still reports (genuinely orphaned)", () => {
		// The guard must not swallow the true-positive shape: no other file even
		// mentions this module's basename, so absence of edges IS the evidence.
		const files = {
			"src/orphan.ts": "export const alone = 1;\n",
			"src/other.ts": "export const unrelated = 2;\n",
		};
		const out = findDeadExports(args("src/orphan.ts", files["src/orphan.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'alone'")]);
	});

	it("N6: barrels, tests, and d.ts files are exempt", () => {
		const files = { "src/index.ts": "export const a = 1;\n" };
		expect(findDeadExports(args("src/index.ts", files["src/index.ts"]), repo(files))).toEqual([]);
		expect(findDeadExports(args("src/a.test.ts", "export const t = 1;\n"), repo({}))).toEqual([]);
		expect(findDeadExports(args("src/a.d.ts", "export const d: number;\n"), repo({}))).toEqual([]);
	});
});

/**
 * Mutation-survivor kills (2026-08-09, lane mut2-dead-exports-inline). Each
 * block below pins a SPECIFIC observable behavior — not "coverage" for its
 * own sake — chosen so a listed mutant changes the assertion's outcome.
 * Where a mutant provably cannot change any observable output (e.g. a
 * defensive `?.` that can never see `undefined`, or a counter compared only
 * to zero via ++ vs --), no test is added for it; see the unit's notes.
 */
describe("findDeadExports — EXPORTABLE_EXT covers every listed extension", () => {
	it("P3: an orphaned export is flagged for every extension in EXPORTABLE_EXT", () => {
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) {
			const out = findDeadExports(args(`src/lib${ext}`, "export const alone = 1;\n"), repo({}));
			expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'alone'")]);
		}
	});

	it("N9: unsupported extensions (not in EXPORTABLE_EXT) are ignored entirely", () => {
		const out = findDeadExports(args("src/notes.txt", "export const alone = 1;\n"), repo({}));
		expect(out).toEqual([]);
	});
});

describe("findDeadExports — EDGE_RE tolerates real-world whitespace", () => {
	it("N10: extra whitespace around import/from/type still resolves the edge", () => {
		const files = { "src/lib.ts": "export const used = 1;\nexport const dead = 2;\n" };
		const cases = [
			'import  { used } from "./lib.js";\nconsole.log(used);\n', // double space after import
			'import { used }  from "./lib.js";\nconsole.log(used);\n', // double space before from
			'import { used } from  "./lib.js";\nconsole.log(used);\n', // double space after from
			'import type { used } from "./lib.js";\nconsole.log(used);\n', // type-only import
			'import type  { used } from "./lib.js";\nconsole.log(used);\n', // double space after type
		];
		for (const main of cases) {
			const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo({ ...files, "src/main.ts": main }));
			expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
		}
	});

	it("N11: a namespace re-export with extra spacing around 'as' still marks everything used", () => {
		// A companion named import ("a") gives the evidence guard a resolved
		// edge regardless of the wildcard line's outcome, so if the wildcard
		// regex silently fails to match, the test sees 'b' wrongly flagged
		// instead of the evidence guard coincidentally also returning [].
		const files = {
			"src/api.ts": "export const a = 1;\nexport const b = 2;\n",
			"src/index.ts":
				'import { a } from "./api.js";\nexport *  as  Ns from "./api.js";\nconsole.log(a);\n',
		};
		expect(findDeadExports(args("src/api.ts", files["src/api.ts"]), repo(files))).toEqual([]);
	});

	it("N12: a default+named combined import registers the named symbols (multi-char default, spaced comma)", () => {
		const files = { "src/lib.ts": "export const used = 1;\nexport const dead = 2;\n" };
		const cases = [
			'import DefaultThing, { used } from "./lib.js";\nconsole.log(DefaultThing, used);\n',
			'import DefaultThing , { used } from "./lib.js";\nconsole.log(DefaultThing, used);\n',
			'import DefaultThing,  { used } from "./lib.js";\nconsole.log(DefaultThing, used);\n',
		];
		for (const main of cases) {
			const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo({ ...files, "src/main.ts": main }));
			expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
		}
	});

	it("N13: a bare default-only import (no braces) does not crash symbol parsing", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import DefaultOnly from "./lib.js";\nimport { used } from "./lib.js";\nconsole.log(DefaultOnly, used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N14: a bare default-only import is itself a resolved edge (comma+brace suffix stays optional)", () => {
		// Here the default-only import is the ONLY mention of the target, so if
		// the parser required a trailing ", { ... }" clause it would fail to
		// match at all, resolvedEdges would stay 0, and the evidence guard
		// would silently suppress 'dead' instead of correctly reporting it.
		const files = {
			"src/lib.ts": "export const dead = 1;\n",
			"src/main.ts": 'import DefaultOnly from "./lib.js";\nconsole.log(DefaultOnly);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});
});

describe("findDeadExports — hasPublicApiComment lookback boundary", () => {
	it("N14: a public API comment on the file's very first line still suppresses (i>=0 includes index 0)", () => {
		const files = { "src/lib.ts": "// public API\nexport const seam = 1;\n" };
		expect(findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files))).toEqual([]);
	});

	it("N15: a marker exactly one line beyond the 12-line lookback is NOT found (cap is exclusive, not off-by-one)", () => {
		// 12 filler comment lines directly above the export, then a 13th
		// ('public API') line the walk must never reach.
		const content = "// public API deep marker\n" + "// filler\n".repeat(12) + "export const seam = 1;\n";
		const out = findDeadExports(args("src/lib.ts", content), repo({}));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'seam'")]);
	});

	it("N16: a non-comment code line between a doc comment and the export breaks the contiguous block", () => {
		const content = "// public API\nconst blocker = 1;\nexport const seam = 2;\n";
		const out = findDeadExports(args("src/lib.ts", content), repo({}));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'seam'")]);
	});

	it("N17: a blank line between a doc comment and the export also breaks the block (blank is not a comment)", () => {
		const content = "// public API\n\nexport const seam = 1;\n";
		const out = findDeadExports(args("src/lib.ts", content), repo({}));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'seam'")]);
	});

	it("N18: a line ending (not starting) with '/*' is not itself a comment start", () => {
		const content = "// public API\nblah blah /*\nexport const seam = 1;\n";
		const out = findDeadExports(args("src/lib.ts", content), repo({}));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'seam'")]);
	});

	it("N19: multiple spaces between 'public' and 'API' still match the marker", () => {
		const content = "// public  API\nexport const seam = 1;\n";
		expect(findDeadExports(args("src/lib.ts", content), repo({}))).toEqual([]);
	});
});

describe("findDeadExports — alias and symbol-list parsing", () => {
	it("N20: a plain alias ('realName as aliasName') resolves the pre-alias symbol", () => {
		const files = {
			"src/lib.ts": "export const realName = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { realName as aliasName } from "./lib.js";\nconsole.log(aliasName);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N21: multiple spaces around 'as' in an alias still resolve the real symbol name", () => {
		const files = {
			"src/lib.ts": "export const realName = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { realName  as  aliasedName } from "./lib.js";\nconsole.log(aliasedName);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N22: KNOWN QUIRK (pinned, not fixed) — a symbol literally named 'type', imported via alias, is treated as the type-modifier and dropped from evidence, so it still reports as dead despite being imported", () => {
		const files = {
			"src/lib.ts": "export const type = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { type as aliasedType } from "./lib.js";\nconsole.log(aliasedType);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([
			expect.stringContaining("'type'"),
			expect.stringContaining("'dead'"),
		]);
	});
});

describe("findDeadExports — export-kind exemptions actually exempt (not just filter-through)", () => {
	it("N23: a bare default export (no other exports) is exempt, not just unreported by luck", () => {
		expect(findDeadExports(args("src/lib.ts", "export default 42;\n"), repo({}))).toEqual([]);
	});

	it("N24: a named re-export (no other exports) is exempt", () => {
		expect(
			findDeadExports(args("src/lib.ts", 'export { helper } from "./helper.js";\n'), repo({})),
		).toEqual([]);
	});

	it("N25: a namespace re-export with alias (no other exports) is exempt", () => {
		expect(
			findDeadExports(args("src/lib.ts", 'export * as Ns from "./other.js";\n'), repo({})),
		).toEqual([]);
	});

	it("N26: a type-only export (no other exports) is exempt", () => {
		expect(findDeadExports(args("src/lib.ts", "export type Foo = string;\n"), repo({}))).toEqual([]);
	});
});

describe("findDeadExports — MAX_FLAGGED caps the report at exactly 10", () => {
	it("N27: 12 unused exports produce exactly 10 findings, not fewer, not unbounded, not 11", () => {
		const content = Array.from({ length: 12 }, (_, i) => `export const dead${i} = ${i};`).join("\n") + "\n";
		const out = findDeadExports(args("src/many.ts", content), repo({}));
		expect(out.length).toBe(10);
	});
});

describe("findDeadExports — evidence and edge-resolution correctness", () => {
	it("N28: a bare (non-relative) specifier is never treated as resolving to us (evidence guard stays silent)", () => {
		// "lib" (no leading '.') mentions our basename but must not be walked as
		// a relative edge — if it were, path.resolve would coincidentally
		// compute our own targetKey and wrongly mark 'used' as consumed.
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "lib";\nconsole.log(used);\n',
		};
		expect(findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files))).toEqual([]);
	});

	it("N29: an import from an UNRELATED file with a same-named symbol does not suppress our export", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/other.ts": "export const dead = 99;\n",
			"src/main.ts":
				'import { used } from "./lib.js";\nimport { dead } from "./other.js";\nconsole.log(used, dead);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N30: an absolute filePath resolves against a non-empty args.cwd (cwd is honored, not blanked)", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("/repo/src/lib.ts", files["src/lib.ts"], "/repo"), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N31: a file outside the project root (selfRel starts with '..') is silent, not analyzed", () => {
		const out = findDeadExports(args("/other/lib.ts", "export const alone = 1;\n", "/repo"), repo({}));
		expect(out).toEqual([]);
	});
});

describe("findDeadExports — importer-scan correctness", () => {
	it("N32: a multi-dot target basename ('a.b.ts') still matches its real importer (candidate filter uses the trailing extension only)", () => {
		const files = {
			"src/a.b.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./a.b.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/a.b.ts", files["src/a.b.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N33: the target's own file content is never scanned as one of its own importers", () => {
		const files = {
			"src/lib.ts":
				'import { dead } from "./lib.js";\nexport const used = 1;\nexport const dead = 2;\nconsole.log(dead);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.length).toBe(2);
		expect(out.some((m) => m.text.includes("'used'"))).toBe(true);
		expect(out.some((m) => m.text.includes("'dead'"))).toBe(true);
	});

	it("N34: an unreadable candidate importer (readFile returns null) does not crash the scan", () => {
		const ghostRepo = {
			listFiles: () => ["src/main.ts", "src/ghost.ts"],
			readFile: (p: string) =>
				p === "src/main.ts" ? 'import { used } from "./lib.js";\nconsole.log(used);\n' : null,
		};
		const out = findDeadExports(
			args("src/lib.ts", "export const used = 1;\nexport const dead = 2;\n"),
			ghostRepo,
		);
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N35: a later importer file is still scanned after an earlier file that mentions but doesn't resolve to us", () => {
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/decoy.ts":
				'import { irrelevant } from "./other.js";\n// mentions lib in passing: lib\nconsole.log(irrelevant);\n',
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});
});

describe("findDeadExports — pathKey extension and barrel-suffix handling", () => {
	it("N36: an explicit '/index' specifier suffix normalizes to the bare directory target", () => {
		const files = {
			"src/foo.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./foo/index.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/foo.ts", files["src/foo.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("N37: a genuine 'index' directory segment in the MIDDLE of a path is not mistaken for the barrel suffix", () => {
		// Regression guard for the anchor on /\/index$/: an 'index' directory
		// that is not the last segment must not get silently collapsed away.
		const files = {
			"src/foo/extra.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./foo/index/extra.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/foo/extra.ts", files["src/foo/extra.ts"]), repo(files));
		// The importer's edge genuinely does not resolve to our target (it
		// references a different, unrelated "index" directory), and the
		// evidence guard keeps us silent rather than guessing.
		expect(out).toEqual([]);
	});

	it("N38: 'mjs'/'mts' extensions strip identically, so a .mts target still matches a .mjs-referencing importer", () => {
		const files = {
			"src/lib.mts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.mjs";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.mts", files["src/lib.mts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});
});
