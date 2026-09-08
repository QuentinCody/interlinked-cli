import { describe, expect, it, vi } from "vitest";
import { preBlockNotMeasuredWarnings } from "../pre-block-gate.js";
import { checkSelfImport } from "./agent-safety-deps.js";
import { scanSelfImports, selfImportMeasurable, selfImportNotMeasuredWarning } from "./self-import-scan.js";

// Simulate the optional `typescript` dep being absent (`--omit=optional`), the
// way identity-unavailable.test.ts does: the synchronous createRequire load
// throws, loadTs() caches null, and the AST pass returns null. Isolated to this
// file so every other self-import test keeps the real compiler.
//
// Review 2026-09-05 (sixth pass, finding 1): `self_import` is a
// `fully_deterministic`, severity-error `pre_block` check, so it may never
// block on a guess. The old line scanner that used to run here produced BOTH
// failure directions on real code — it missed a multiline declaration (false
// negative) and flagged `import alias = Existing.Namespace; // from "./widget.js"`
// because the `from "…"` in the trailing comment matched (false positive). The
// contract now is NOT MEASURED: no findings, and a self-import-specific
// warning that says so.
vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: () => () => {
			throw new Error("typescript not installed");
		},
	};
});

const MULTILINE_SELF_IMPORT = 'import {\n\tx\n} from "./widget.js";\n';
const ALIAS_WITH_TRAILING_COMMENT = 'import alias = Existing.Namespace; // from "./widget.js"\n';

describe("self_import without the optional typescript dep — not measured, never guessed", () => {
	it("reports the check as not measurable", () => {
		expect(selfImportMeasurable()).toBe(false);
	});

	it("N1: does NOT flag the alias-with-trailing-comment line the old line scanner flagged", () => {
		expect(scanSelfImports(ALIAS_WITH_TRAILING_COMMENT, "widget.ts")).toBeNull();
		expect(checkSelfImport(ALIAS_WITH_TRAILING_COMMENT, "widget.ts")).toEqual([]);
	});

	it("N2: reports NOTHING for the multiline self-import — the miss is disclosed, not silently wrong", () => {
		expect(scanSelfImports(MULTILINE_SELF_IMPORT, "widget.ts")).toBeNull();
		expect(checkSelfImport(MULTILINE_SELF_IMPORT, "widget.ts")).toEqual([]);
	});

	it("N3: does NOT flag a single-line self-import either — there is no partial scan", () => {
		expect(checkSelfImport('import { x } from "./widget.js";\n', "widget.ts")).toEqual([]);
	});

	it("P1: emits the self-import-specific NOT MEASURED warning for a JS/TS file", () => {
		const warning = selfImportNotMeasuredWarning("src/widget.ts");
		expect(warning).toContain("[interlinked:self_import]");
		expect(warning).toContain("NOT MEASURED");
		expect(warning).toContain("src/widget.ts");
		expect(warning).toContain("--omit=optional");
		expect(preBlockNotMeasuredWarnings("src/widget.ts")).toEqual([
			{ checkId: "self_import", message: warning },
		]);
	});

	it("P2: the warning covers every JS/TS-family extension the check itself covers", () => {
		for (const file of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.mts", "a.cts"]) {
			expect(selfImportNotMeasuredWarning(file)).not.toBeNull();
		}
	});

	it("N4: emits no warning for a file the check never covers", () => {
		expect(selfImportNotMeasuredWarning("thing.py")).toBeNull();
		expect(selfImportNotMeasuredWarning("README.md")).toBeNull();
		expect(preBlockNotMeasuredWarnings("thing.py")).toEqual([]);
	});
});
