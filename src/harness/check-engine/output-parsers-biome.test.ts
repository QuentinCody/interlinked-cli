// Pins the biome diagnostic-header parser, including the `parse`/`syntax`
// family (finding 2026-06, round 6): those headers were unmatched, so a file
// biome could not even parse produced ZERO findings and the runner read it as
// clean — the poison-corpus check caught the fail-open on its first run.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { parseBiomeOutput } from "./output-parsers-biome.js";

describe("parseBiomeOutput", () => {
	it("parses lint-rule diagnostics as warnings", () => {
		const out = parseBiomeOutput(
			"src/a.ts:3:7 lint/suspicious/noExplicitAny ━━━━━━━━━━━\n  × Unexpected any.\n",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "warning",
			file: "src/a.ts",
			line: 3,
			column: 7,
			ruleId: "lint/suspicious/noExplicitAny",
		});
	});

	it("parses format diagnostics", () => {
		const out = parseBiomeOutput("src/b.ts:1:1 format ━━━━━━━━━━━\n");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ruleId).toBe("format");
	});

	it("parses ASSIST diagnostics — organizeImports (finding 2026-06: these were silently dropped, so an assist-only run reported 'lint NOT validated' and waved unsorted imports through)", () => {
		const out = parseBiomeOutput(
			"src/a.ts:5:1 assist/source/organizeImports ━━━━━━━━━━━\n  × The imports and exports are not sorted.\n",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "warning",
			file: "src/a.ts",
			line: 5,
			column: 1,
			ruleId: "assist/source/organizeImports",
		});
	});

	it("parses SUPPRESSIONS diagnostics — unused biome-ignore (B3: was silently dropped, so an unused suppression produced exit 1 + zero parsed findings → the 'lint NOT validated' synthetic, masking a finding whole-repo `biome check` fails on)", () => {
		const out = parseBiomeOutput(
			"src/x.test.ts:47:1 suppressions/unused ━━━━━━━━━━━\n  ! Suppression comment has no effect.\n",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "warning",
			file: "src/x.test.ts",
			line: 47,
			column: 1,
			ruleId: "suppressions/unused",
		});
	});

	it("parses ASSIST diagnostics with the real ` FIXABLE ` token before the box chars", () => {
		const out = parseBiomeOutput(
			"src/a.ts:1:1 assist/source/organizeImports  FIXABLE  ━━━\n  × The imports and exports are not sorted.\n",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ ruleId: "assist/source/organizeImports", severity: "warning" });
	});

	it("parses PARSE diagnostics as errors (round 6 — these were silently dropped)", () => {
		const out = parseBiomeOutput(
			[
				"poison.ts:1:7 parse ━━━━━━━━━━━",
				"  × Expected an identifier, an array pattern, or an object pattern but instead found '='.",
				"poison.ts:1:9 parse ━━━━━━━━━━━",
			].join("\n"),
		);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ severity: "error", file: "poison.ts", line: 1, column: 7 });
		expect(nonNull(out[0]).message).toContain("does not parse");
	});

	// Census gap (docs/reviews/kill-proof-census-harness.md, "Three worst gaps" 3): only `parse`
	// headers were pinned as errors.
	// test-contract: bug — a bare `syntax` header is the parse family; it must be an error, never a warning
	it("parses bare SYNTAX diagnostics as errors, exactly like parse", () => {
		const out = parseBiomeOutput("poison.ts:1:7 syntax ━━━━━━━━━━━\n  × Expected a semicolon.\n");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ severity: "error", ruleId: "syntax", line: 1, column: 7 });
		expect(nonNull(out[0]).message).toBe("syntax: file does not parse");
	});

	// test-contract: bug — biome 2 prints the syntax rule group as `syntax/<group>/<rule>`; the bare-word
	// alternation dropped it, so a file biome rejects produced zero findings (the fail-open the header describes)
	it("parses syntax/<group>/<rule> diagnostics as errors (biome 2.4.13 header, verified against the binary)", () => {
		const out = parseBiomeOutput(
			[
				"dup.ts:3:3 syntax/correctness/noDuplicatePrivateClassMembers ━━━━━━━━━━━",
				"  × Duplicate private class member \"#x\"",
				"attr.ts:1:30 syntax/correctness/noTypeOnlyImportAttributes ━━━━━━━━━━━",
			].join("\n"),
		);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "error",
			file: "dup.ts",
			line: 3,
			column: 3,
			ruleId: "syntax/correctness/noDuplicatePrivateClassMembers",
			message: "syntax/correctness/noDuplicatePrivateClassMembers: syntax error",
		});
		expect(out[1]).toMatchObject({ severity: "error", file: "attr.ts", line: 1, column: 30 });
	});

	it("ignores non-diagnostic lines (summaries, diff bodies)", () => {
		const out = parseBiomeOutput(
			["Checked 1 file in 1083µs. No fixes applied.", "Found 6 errors.", "  > 1 │ const = {{{"].join(
				"\n",
			),
		);
		expect(out).toEqual([]);
	});
});
