// Cross-repo falsification of the `extraneous_deps` pre_warn check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json): 7 reads on
// real foreign repositories, 7 confirmed false positives, 0 true positives.
// Three blind spots, each a resolution fact of real Node projects the
// detector did not model:
//   1. a type-only import of `X` is satisfied by a declared `@types/X`
//   2. a workspace member resolves the ROOT manifest's hoisted dependencies
//   3. a package resolves its own `name` through its `exports` map
// Every negative below rebuilds the cited repository's manifest layout in a
// throwaway tree and feeds the REAL import line (trimmed, attributed). The
// positives pin the class each fix must keep: the same shapes with the
// declaration genuinely missing still fire.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkExtraneousDependencies,
	isTypeOnlyImportLine,
	typesPackageFor,
} from "../../checks/agent-safety-deps.js";

let root: string | null = null;
afterEach(() => {
	if (root !== null) rmSync(root, { recursive: true, force: true });
	root = null;
});

/** A throwaway tree with the given files (JSON values are serialized). The
 *  checked file itself is never written — the detector reads only manifests. */
function tree(files: Record<string, string | object>): (rel: string) => string {
	root = mkdtempSync(join(tmpdir(), "extraneous-deps-foreign-"));
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
	}
	const base = root;
	return (rel) => join(base, rel);
}

// zod's layout: a private root with `workspaces` + shared devDependencies,
// and `packages/zod` (name "zod", an `exports` map, NO dependency fields).
// Trimmed from zod-clone/package.json and zod-clone/packages/zod/package.json.
const ZOD_ROOT = {
	private: true,
	type: "module",
	workspaces: ["packages/*"],
	devDependencies: {
		"@types/benchmark": "^2.1.5",
		benchmark: "^2.1.4",
		tinybench: "^2.9.0",
		vitest: "^4.1.5",
		zod: "workspace:*",
	},
};
const ZOD_PKG = {
	name: "zod",
	version: "4.6.7",
	type: "module",
	exports: {
		"./package.json": "./package.json",
		".": { import: "./index.js", require: "./index.cjs" },
		"./v3": { import: "./v3/index.js", require: "./v3/index.cjs" },
	},
};
function zodTree(): (rel: string) => string {
	return tree({ "package.json": ZOD_ROOT, "packages/zod/package.json": ZOD_PKG });
}
const ZOD_BENCH = "packages/zod/src/v3/benchmarks";

// date-fns' layout: a pnpm workspace (root `pnpm-workspace.yaml`) whose docs
// member declares `@types/mdast` but no runtime `mdast`. Trimmed from
// date-fns-clone/pkgs/docs/package.json.
const DATE_FNS_DOCS = {
	name: "@date-fns/docs",
	type: "module",
	exports: { ".": "./src/index.ts" },
	dependencies: { typedoc: "^0.28.20" },
	devDependencies: {
		"@types/mdast": "^4.0.4",
		"@types/node": "26",
		"mdast-util-to-markdown": "^2.1.2",
		smolcanon: "^0.1.0",
		smolxxh: "^0.1.0",
	},
};
function dateFnsTree(): (rel: string) => string {
	return tree({
		"pnpm-workspace.yaml": "packages:\n  - pkgs/*\n",
		"package.json": { name: "@date-fns/root", devDependencies: { vitest: "^5.0.1" } },
		"pkgs/docs/package.json": DATE_FNS_DOCS,
	});
}

describe("extraneous_deps — negative (must not fire)", () => {
	it("N1: date-fns pkgs/docs/scripts/buildMds.ts:3 — type-only import of `mdast` served by the declared `@types/mdast`", () => {
		const at = dateFnsTree();
		// date-fns/pkgs/docs/scripts/buildMds.ts, lines 1-7 (trimmed)
		const src = [
			'import { readFile } from "fs/promises";',
			'import type { Root } from "mdast";',
			'import { toMarkdown } from "mdast-util-to-markdown";',
			'import path from "path";',
			'import { canonize } from "smolcanon";',
			'import { xxh32 } from "smolxxh";',
			"",
		].join("\n");
		expect(checkExtraneousDependencies(src, at("pkgs/docs/scripts/buildMds.ts"))).toEqual([]);
	});

	it("N2: zod packages/zod/src/v3/benchmarks/datetime.ts:1 — `benchmark` hoisted from the workspace root devDependencies", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/datetime.ts, lines 1-3
		const src = 'import Benchmark from "benchmark";\n\nconst datetimeValidationSuite = new Benchmark.Suite("datetime");\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/datetime.ts`))).toEqual([]);
	});

	it("N3: zod packages/zod/src/v3/benchmarks/discriminatedUnion.ts:1 — root-hoisted `benchmark` next to a self-reference", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/discriminatedUnion.ts, lines 1-3
		const src = 'import Benchmark from "benchmark";\n\nimport { z } from "zod/v3";\n';
		const out = checkExtraneousDependencies(src, at(`${ZOD_BENCH}/discriminatedUnion.ts`));
		expect(out.filter((m) => m.line === 1)).toEqual([]);
	});

	it("N4: zod packages/zod/src/v3/benchmarks/discriminatedUnion.ts:3 — `zod/v3` is the enclosing package's own name through its `exports` map", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/discriminatedUnion.ts, line 3
		const src = 'import { z } from "zod/v3";\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/discriminatedUnion.ts`))).toEqual([]);
	});

	it("N5: zod packages/zod/src/v3/benchmarks/index.ts:1 — `import type Benchmark` against root-hoisted `benchmark` + `@types/benchmark`", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/index.ts, lines 1-3 (trimmed)
		const src = 'import type Benchmark from "benchmark";\n\nimport datetimeBenchmarks from "./datetime.js";\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/index.ts`))).toEqual([]);
	});

	it("N6: zod packages/zod/src/v3/benchmarks/ipv4.ts:1 — root-hoisted `benchmark` in a dev-only benchmark file", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/ipv4.ts, lines 1-3
		const src = 'import Benchmark from "benchmark";\n\nconst suite = new Benchmark.Suite("ipv4");\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/ipv4.ts`))).toEqual([]);
	});

	it("N7: zod packages/zod/src/v3/benchmarks/object.ts:1 — root-hoisted `benchmark` plus the package self-reference, whole file clean", () => {
		const at = zodTree();
		// zod/packages/zod/src/v3/benchmarks/object.ts, lines 1-3
		const src = 'import Benchmark from "benchmark";\n\nimport { z } from "zod/v3";\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/object.ts`))).toEqual([]);
	});

	it("N8: a named list whose every binding is `type`-prefixed is type-only too", () => {
		const at = dateFnsTree();
		const src = 'import { type Root, type Content } from "mdast";\n';
		expect(checkExtraneousDependencies(src, at("pkgs/docs/scripts/buildMds.ts"))).toEqual([]);
		expect(isTypeOnlyImportLine('import { type Root, type Content } from "";')).toBe(true);
	});

	it("N9: a scoped type-only import maps to the `@types/scope__pkg` spelling", () => {
		const at = tree({
			"package.json": { devDependencies: { "@types/babel__core": "^7.0.0" } },
		});
		expect(typesPackageFor("@babel/core")).toBe("@types/babel__core");
		const src = 'import type { PluginObj } from "@babel/core";\n';
		expect(checkExtraneousDependencies(src, at("src/plugin.ts"))).toEqual([]);
	});
});

describe("extraneous_deps — positive (must fire)", () => {
	it("P1: a VALUE import of `mdast` with only `@types/mdast` declared is still extraneous — the runtime package is missing", () => {
		const at = dateFnsTree();
		const src = 'import { u } from "mdast";\n';
		expect(checkExtraneousDependencies(src, at("pkgs/docs/scripts/buildMds.ts"))).toEqual([
			{ line: 1, text: 'import { u } from "mdast";' },
		]);
		// A default binding merely NAMED `type` is a value import as well.
		expect(isTypeOnlyImportLine('import type from "";')).toBe(false);
	});

	it("P2: a workspace member importing a package declared in NEITHER the member nor the root still fires", () => {
		const at = zodTree();
		const src = 'import Benchmark from "benchmark";\nimport { hrtime } from "nanotimer-missing";\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/datetime.ts`))).toEqual([
			{ line: 2, text: 'import { hrtime } from "nanotimer-missing";' },
		]);
	});

	it("P3: a package importing its own name WITHOUT an `exports` map is not a Node self-reference", () => {
		const at = tree({
			"package.json": ZOD_ROOT,
			"packages/zod/package.json": { name: "zod", version: "4.6.7", type: "module" },
		});
		// The root's `zod: workspace:*` must not leak in either — remove it.
		writeFileSync(
			at("package.json"),
			JSON.stringify({ ...ZOD_ROOT, devDependencies: { benchmark: "^2.1.4" } }),
		);
		const src = 'import { z } from "zod/v3";\n';
		expect(checkExtraneousDependencies(src, at(`${ZOD_BENCH}/object.ts`))).toEqual([
			{ line: 1, text: 'import { z } from "zod/v3";' },
		]);
	});

	it("P4: a type-only import whose `@types/*` package is ALSO undeclared fires", () => {
		const at = dateFnsTree();
		const src = 'import type { Node } from "unist";\n';
		expect(checkExtraneousDependencies(src, at("pkgs/docs/scripts/buildMds.ts"))).toEqual([
			{ line: 1, text: 'import type { Node } from "unist";' },
		]);
	});

	it("P5: a standalone package (no workspace) with a missing dependency is unchanged by the workspace union", () => {
		const at = tree({ "package.json": { dependencies: { lodash: "1.0.0" } } });
		const src = 'import { z } from "zod";\n';
		expect(checkExtraneousDependencies(src, at("src/index.ts"))).toEqual([
			{ line: 1, text: 'import { z } from "zod";' },
		]);
	});
});
