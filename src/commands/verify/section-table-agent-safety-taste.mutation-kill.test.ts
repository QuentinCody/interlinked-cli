// Mutation-kill companion for src/commands/verify/section-table-agent-safety-taste.ts.
//
// The golden-gen generator (scratch/fleet-r3/golden-gen/generate.mts) only
// handles `export const X = {...}` object-literal tables; this file's sole
// export, `tasteStructuralSections`, is `readonly SectionSpec[]` -- an ARRAY
// of object literals, which the generator's own header marks out of scope
// for v1 (confirmed: `--dry-run` against this file aborts with "no top-level
// 'export const X = {...}' object-literal table found"). Hand-written
// instead, same underlying strategy.
//
// All 306 recorded survivors (`mutation survivors --file
// section-table-agent-safety-taste.ts --json`) are StringLiteral mutants
// whose replacement is always exactly "" (every mutant's `replacement` field
// in the manifest is `""` -- Stryker's StringLiteral mutator empties a
// non-empty literal, never partially corrupts it). Cross-checking every
// survivor's originalLexeme against this file's 102 entries shows each one
// maps to exactly one entry's `label`, `noun`, or `passLabel` field
// (102 entries x 3 fields = 306, matching exactly). `key` never survives
// because it is typed `keyof CodeQualityResults`, so emptying it fails
// typecheck; `color` never survives because the sibling composed-table test
// (section-table-agent-safety.test.ts) already asserts
// `["31", "33"].includes(spec.color)`, which "" fails. That same sibling
// test is *why* label/noun/passLabel survive: it only asserts
// `typeof spec.label === "string"` etc, and "" satisfies typeof-string --
// exactly the "shape check accepts an empty string" gap the golden-gen
// generator's own header describes.
//
// A single exact boundary check -- no entry's label/noun/passLabel/key/color
// is ever the empty string -- is therefore a complete, deterministic kill for
// the entire open population: it is not a loose shape check, it targets the
// precise value every recorded mutant always produces. A second block pins
// exact full-object wording (toEqual, not toContain) on the
// punctuation-heaviest entries as an additional, more specific guard.

import { describe, expect, it } from "vitest";
import { tasteStructuralSections } from "./section-table-agent-safety-taste.js";

describe("tasteStructuralSections content (mutation-kill)", () => {
	// tasteStructuralSections is spread into the composed agentSafetySections
	// table that drives interlinked verify's rendered section table.
	// test-contract: public-api — an emptied label, noun, or passLabel silently blanks a rendered report row while its key-based lookup still succeeds
	it("no entry carries an empty label, noun, passLabel, key, or color (closes 306 StringLiteral survivors)", () => {
		// 103 since H8 (2026-10-02) added the hand_rolled_lexer row.
		expect(tasteStructuralSections.length).toBe(103);
		expect(tasteStructuralSections.find((entry) => entry.key === "handRolledLexer")?.label).toBe("hand-rolled lexer");
		for (const entry of tasteStructuralSections) {
			expect(entry.label, `label for key=${entry.key}`).not.toBe("");
			expect(entry.noun, `noun for key=${entry.key}`).not.toBe("");
			expect(entry.passLabel, `passLabel for key=${entry.key}`).not.toBe("");
			expect(entry.key, `key for label=${entry.label}`).not.toBe("");
			expect(entry.color, `color for key=${entry.key}`).not.toBe("");
		}
	});

	// test-contract: invariant — key values must be unique; a duplicate key
	// would silently alias two rows onto the same CodeQualityResults field
	// wherever this table is consumed by key.
	it("every key is unique", () => {
		const keys = tasteStructuralSections.map((entry) => entry.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	// test-contract: public-api — exact wording on entries with apostrophes,
	// backticks, and em dashes pins the literal content the array must
	// render, beyond mere non-emptiness, for fields most likely to be typo'd.
	it("preserves exact wording on entries with apostrophes/backticks/em dashes", () => {
		expect(tasteStructuralSections.find((e) => e.key === "designSlop")).toEqual({
			label: "design slop",
			key: "designSlop",
			noun: "AI-generated design tells (overused fonts, accent stripes, gradient text, AI palettes, bounce easing)",
			passLabel: "no AI design tells",
			color: "31",
		});
		expect(tasteStructuralSections.find((e) => e.key === "awaitStateToctou")).toEqual({
			label: "await state TOCTOU",
			key: "awaitStateToctou",
			noun: "same field deref'd before and after an await without re-check",
			passLabel: "no await-state TOCTOU",
			color: "31",
		});
		expect(tasteStructuralSections.find((e) => e.key === "homedirWriteEscape")).toEqual({
			label: "homedir write escape",
			key: "homedirWriteEscape",
			noun: "writes whose path derives from the user's real home directory",
			passLabel: "no writes escaping into the user's home",
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "typePredicateDrift")).toEqual({
			label: "type predicate drift",
			key: "typePredicateDrift",
			noun: "`value is T` guards that leave some of T's required properties unchecked",
			passLabel: "no drifting type predicates",
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "anonymousRegistration")).toEqual({
			label: "anonymous registration",
			key: "anonymousRegistration",
			noun: "registry entries whose implementation has no name — unreachable from their own id by grep, index, or embedding search",
			passLabel: "every registered implementation is named",
			color: "33",
		});
	});

	// test-contract: public-api — exact wording on entries with nested code
	// syntax (angle brackets, arrow functions, embedded double quotes, slashes)
	// pins the literal content beyond mere non-emptiness.
	it("preserves exact wording on entries with nested code syntax", () => {
		expect(tasteStructuralSections.find((e) => e.key === "errorDispatchByInstanceof")).toEqual({
			label: "error dispatch by instanceof",
			key: "errorDispatchByInstanceof",
			noun: "`instanceof <BuiltinError>` inside a catch — fragile across realm boundaries",
			passLabel: "no instanceof-builtin-Error dispatch in catch",
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "silentPromiseSwallow")).toEqual({
			label: "silent promise catch",
			key: "silentPromiseSwallow",
			noun: ".catch(() => {}) handlers that swallow rejections",
			passLabel: "no silent .catch swallows",
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "accumulatingSpread")).toEqual({
			label: "accumulating spread",
			key: "accumulatingSpread",
			noun: "O(n²) spread in reduce",
			passLabel: "no accumulating spreads",
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "targetBlankNoRel")).toEqual({
			label: "target _blank",
			key: "targetBlankNoRel",
			noun: 'target="_blank" without rel="noopener"',
			passLabel: 'no unsafe target="_blank"',
			color: "33",
		});
		expect(tasteStructuralSections.find((e) => e.key === "projectLocRatio")).toEqual({
			label: "project prod/test LOC ratio",
			key: "projectLocRatio",
			noun: "project-wide prod/test LOC ratio above limit",
			passLabel: "project prod/test LOC ratio within limits",
			color: "33",
		});
	});
});
