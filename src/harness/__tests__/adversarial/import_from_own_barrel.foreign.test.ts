// Cross-repo falsification of the `import_from_own_barrel` pre_warn check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json: 7 read,
// 7 confirmed false positives, 0 true positives). Each negative case is the
// REAL snippet at the cited location (trimmed, attributed); the positives pin
// the bug class — a value import from a barrel that really does re-export the
// importer — so the fix cannot be a blanket exemption.
//
// Three blind spots closed as classes:
//   1. a bare `test.ts` / `spec.ts` with test-runner evidence is a test unless
//      the barrel reaches it (detector-local `isBareTestModule`; the shared
//      classifiers stay unchanged so a product `spec.ts` is still product, P11);
//   2. `import type` / `export type` / all-`type` brace clauses are erased at
//      emit and cannot form a module-init edge;
//   3. a `./index` that exists on disk is a barrel only if it reaches the
//      importer through same-directory edges (transitively); an
//      implementation module named `index.ts` is not a barrel. A MISSING
//      index keeps the finding (the barrel may be unsaved).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { _resetPackageNameCacheForTests, checkImportFromOwnBarrel } from "../../checks/imports.js";
import { isStrictTestFile, isTestSourcePath } from "../../checks/shared-test-classification.js";

let sandbox = "";

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "own-barrel-foreign-"));
	_resetPackageNameCacheForTests();
});

afterEach(() => {
	_resetPackageNameCacheForTests();
	rmSync(sandbox, { recursive: true, force: true });
});

/** Write `<sandbox>/<dir>/<name>` and return its absolute path. */
function fileAt(dir: string, name: string, content: string): string {
	const full = join(sandbox, dir);
	mkdirSync(full, { recursive: true });
	const path = join(full, name);
	writeFileSync(path, content);
	return path;
}

// zod packages/zod/src/v3/index.ts + external.ts (verbatim): index → external → ZodError.
const ZOD_INDEX = 'import * as z from "./external.js";\nexport * from "./external.js";\nexport { z };\nexport default z;\n';
const ZOD_EXTERNAL = [
	'export * from "./errors.js";',
	'export * from "./helpers/parseUtil.js";',
	'export * from "./helpers/typeAliases.js";',
	'export * from "./helpers/util.js";',
	'export * from "./types.js";',
	'export * from "./ZodError.js";',
	"",
].join("\n");

// date-fns pkgs/core/src/add/index.ts (head, verbatim): the `add` implementation.
const DATE_FNS_ADD_INDEX = [
	'import { addDays } from "../addDays/index.ts";',
	'import { addMonths } from "../addMonths/index.ts";',
	'import { constructFrom } from "../constructFrom/index.ts";',
	'import { toDate } from "../toDate/index.ts";',
	'import type { ContextOptions, DateArg, Duration } from "../types.ts";',
	"",
	"export interface AddOptions<",
	"  DateType extends Date = Date,",
	"> extends ContextOptions<DateType> {}",
	"",
].join("\n");

describe("import_from_own_barrel — negative (must not fire)", () => {
	it("N1: date-fns pkgs/core/src/_lib/addLeadingZeros/test.ts:2 — bare `test.ts` basename is a test file", () => {
		// date-fns pkgs/core/src/_lib/addLeadingZeros/test.ts (lines 1-4)
		const content = [
			'import { describe, expect, it } from "vitest";',
			'import { addLeadingZeros } from "./index.ts";',
			"",
			'describe("addLeadingZeros", () => {',
		].join("\n");
		// No index on disk at this relative path: only the test-file skip can clear it.
		expect(checkImportFromOwnBarrel(content, "pkgs/core/src/_lib/addLeadingZeros/test.ts")).toEqual([]);
	});

	it("N2: date-fns pkgs/core/src/_lib/getRoundingMethod/test.ts:2 — bare `test.ts` basename is a test file", () => {
		// date-fns pkgs/core/src/_lib/getRoundingMethod/test.ts (lines 1-2)
		const content = 'import { describe, expect, it } from "vitest";\nimport { getRoundingMethod } from "./index.ts";\n';
		expect(checkImportFromOwnBarrel(content, "pkgs/core/src/_lib/getRoundingMethod/test.ts")).toEqual([]);
	});

	it("N3: date-fns pkgs/core/src/_lib/getTimezoneOffsetInMilliseconds/test.ts:2 — bare `test.ts` basename is a test file", () => {
		// date-fns pkgs/core/src/_lib/getTimezoneOffsetInMilliseconds/test.ts (lines 1-2)
		const content =
			'import { describe, expect, it } from "vitest";\nimport { getTimezoneOffsetInMilliseconds } from "./index.ts";\n';
		expect(checkImportFromOwnBarrel(content, "pkgs/core/src/_lib/getTimezoneOffsetInMilliseconds/test.ts")).toEqual([]);
	});

	it("N4: date-fns pkgs/core/src/add/index.tp.ts:3 — `import type` is erased at emit (no index on disk)", () => {
		// date-fns pkgs/core/src/add/index.tp.ts (lines 1-3)
		const content = [
			'import { fromTp, toTpInstant } from "../_lib/tp/index.ts";',
			'import type { DateArg, Duration } from "../types.ts";',
			'import type { AddOptions } from "./index.ts";',
		].join("\n");
		// Relative path with no sibling index: only the type-only skip can clear it.
		expect(checkImportFromOwnBarrel(content, "pkgs/core/src/add/index.tp.ts")).toEqual([]);
	});

	it("N5: date-fns pkgs/core/src/add/test.ts:5 — bare `test.ts` basename is a test file", () => {
		// date-fns pkgs/core/src/add/test.ts (lines 1-6)
		const content = [
			'import { TZDate, tz } from "@date-fns/tz";',
			'import { UTCDate } from "@date-fns/utc";',
			'import { describe, expect, it } from "vitest";',
			'import { assertType } from "../_lib/test/index.ts";',
			'import { add } from "./index.ts";',
			'import { getDstTransitions } from "../_lib/test/tzOffsetTransitions.ts";',
		].join("\n");
		expect(checkImportFromOwnBarrel(content, "pkgs/core/src/add/test.ts")).toEqual([]);
	});

	it("N6: date-fns pkgs/core/src/addBusinessDays/index.tp.ts:7 — `import type` from an implementation index on disk", () => {
		// date-fns pkgs/core/src/addBusinessDays/index.ts (lines 1-6) — the implementation, never imports index.tp.ts
		fileAt(
			"addBusinessDays",
			"index.ts",
			[
				'import { constructFrom } from "../constructFrom/index.ts";',
				'import { isSaturday } from "../isSaturday/index.ts";',
				'import { isSunday } from "../isSunday/index.ts";',
				'import { isWeekend } from "../isWeekend/index.ts";',
				'import { toDate } from "../toDate/index.ts";',
				'import type { ContextOptions, DateArg } from "../types.ts";',
				"",
			].join("\n"),
		);
		// date-fns pkgs/core/src/addBusinessDays/index.tp.ts (lines 1-7)
		const content = [
			'import { toTpInstant } from "../_lib/tp/index.ts";',
			'import { constructFrom } from "../constructFrom/index.ts";',
			'import { tpIsSaturday } from "../tp/isSaturday/index.ts";',
			'import { tpIsSunday } from "../tp/isSunday/index.ts";',
			'import { tpIsWeekend } from "../tp/isWeekend/index.ts";',
			'import type { DateArg } from "../types.ts";',
			'import type { AddBusinessDaysOptions } from "./index.ts";',
		].join("\n");
		const file = fileAt("addBusinessDays", "index.tp.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toEqual([]);
	});

	it("N7: zod packages/zod/src/v3/ZodError.ts:3 — type-only import from a REAL transitive barrel", () => {
		fileAt("v3", "index.ts", ZOD_INDEX);
		fileAt("v3", "external.ts", ZOD_EXTERNAL);
		// zod packages/zod/src/v3/ZodError.ts (lines 1-3)
		const content = [
			'import type { Primitive } from "./helpers/typeAliases.js";',
			'import { util, type ZodParsedType } from "./helpers/util.js";',
			'import type { TypeOf, ZodType } from "./index.js";',
		].join("\n");
		const file = fileAt("v3", "ZodError.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toEqual([]);
	});

	it("N8: date-fns add/ layout — a VALUE import from an implementation `index.ts` that never reaches the importer", () => {
		// Class pin for blind spot 3 on its own: the date-fns add/index.ts head
		// (real) beside a sibling whose import is NOT type-only.
		fileAt("add", "index.ts", DATE_FNS_ADD_INDEX);
		const content = 'import { add } from "./index.ts";\nexport const addOne = (d: Date) => add(d, { days: 1 });\n';
		const file = fileAt("add", "addOne.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toEqual([]);
	});

	it("N9: all-`type` brace clause and `export type … from` are erased too", () => {
		fileAt("lib", "index.ts", 'export * from "./foo.js";\n');
		const content = 'import { type Foo, type Bar } from "./index.js";\nexport type { Baz } from "./index.js";\n';
		const file = fileAt("lib", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toEqual([]);
	});
});

describe("import_from_own_barrel — positive (must fire)", () => {
	it("P1: a value import from a sibling barrel that re-exports the importer", () => {
		fileAt("lib", "index.ts", 'export * from "./foo.js";\nexport * from "./bar.js";\n');
		const content = 'import { bar } from "./index.js";\nexport const foo = () => bar();\n';
		const file = fileAt("lib", "foo.ts", content);
		const out = checkImportFromOwnBarrel(content, file);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toMatch(/own-directory barrel '\.\/index\.js'/);
	});

	it("P2: zod layout with a VALUE import — the barrel reaches ZodError.ts transitively via external.ts", () => {
		fileAt("v3", "index.ts", ZOD_INDEX);
		fileAt("v3", "external.ts", ZOD_EXTERNAL);
		const content = 'import { ZodType } from "./index.js";\nexport class ZodError extends Error {}\n';
		const file = fileAt("v3", "ZodError.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P3: a mixed clause `{ type A, b }` still carries a value import", () => {
		fileAt("lib", "index.ts", 'export * from "./foo.js";\n');
		const content = 'import { type A, b } from "./index.js";\n';
		const file = fileAt("lib", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P4: no sibling index on disk keeps the finding (the barrel may be unsaved)", () => {
		const content = 'import { Foo } from "./index";\n';
		expect(checkImportFromOwnBarrel(content, "src/lib/foo.ts")).toHaveLength(1);
	});

	it("P5: a side-effect `import \"./foo.js\"` in the index is a runtime edge back to the importer", () => {
		fileAt("lib", "index.ts", 'import "./foo.js";\nexport const ready = true;\n');
		const content = 'import { ready } from "./index.js";\n';
		const file = fileAt("lib", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P6: a bare `index.tp.ts`-style sibling IS flagged when the index re-exports it with a value import", () => {
		fileAt("add", "index.ts", 'export { tpyAdd } from "./index.tp.ts";\n');
		const content = 'import { AddOptions } from "./index.ts";\n';
		const file = fileAt("add", "index.tp.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	// Repair cases (2026-10-21 verifier, refine-result.json rescan evidence):
	// shapes the first refinement exempted beyond the confirmed blind spots.
	it("P7: repair — barrel reaches the importer through a SUBDIRECTORY barrel (`./lib` → `../foo`)", () => {
		fileAt("pkg", "index.ts", 'export * from "./lib";\n');
		fileAt("pkg/lib", "index.ts", 'export * from "../foo";\n');
		const content = 'import { helper } from "./index";\nexport const foo = () => helper();\n';
		const file = fileAt("pkg", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P8: repair — barrel re-exports the importer through a PATH ALIAS (`@/components/foo`)", () => {
		fileAt("components", "index.ts", 'export * from "@/components/foo";\n');
		const content = 'import { Bar } from "./index";\nexport const Foo = () => Bar;\n';
		const file = fileAt("components", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P9: repair — `import type from \"./index\"` is a VALUE default import of a binding named `type`", () => {
		fileAt("lib", "index.ts", 'export * from "./foo.js";\nexport default 1;\n');
		const content = 'import type from "./index.js";\n';
		const file = fileAt("lib", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P10: repair — `import type, { x } from \"./index\"` is a value import (default `type` + named `x`)", () => {
		fileAt("lib", "index.ts", 'export * from "./foo.js";\nexport const x = 1;\nexport default 1;\n');
		const content = 'import type, { x } from "./index.js";\n';
		const file = fileAt("lib", "foo.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
	});

	it("P11: repair — a PRODUCT `spec.ts` that the barrel re-exports is not a test file", () => {
		fileAt("schema", "index.ts", 'export * from "./spec";\nexport * from "./other";\n');
		const content = 'import { other } from "./index";\nexport const spec = () => other();\n';
		const file = fileAt("schema", "spec.ts", content);
		expect(checkImportFromOwnBarrel(content, file)).toHaveLength(1);
		// The shared classifiers must not reclassify a bare product `spec.ts`
		// (this repo's src/commands/spec.ts) as a test: that removed it from the
		// line cap and every isTestFile-gated surface.
		expect(isTestSourcePath("src/commands/spec.ts")).toBe(false);
		expect(isStrictTestFile("src/commands/spec.ts")).toBe(false);
	});
});
