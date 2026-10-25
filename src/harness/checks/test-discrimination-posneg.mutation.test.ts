import { describe, expect, it } from "vitest";
import { checkDuplicateExpectedLiteralPosNeg } from "./test-discrimination-posneg.js";

function run(content: string, path = "guard.test.ts"): ReturnType<typeof checkDuplicateExpectedLiteralPosNeg> {
	return checkDuplicateExpectedLiteralPosNeg(content, path);
}

describe("checkDuplicateExpectedLiteralPosNeg mutation hardening — positive (must fire)", () => {
	// Basis: Check Evidence grammar `directionFromTitle` is consulted first
	// (test-discrimination-posneg.ts:124-126); "flags" reads POSITIVE there even
	// though "invalid" reads negative in the plain vocabulary fallback.
	it("P1: a title using the structural 'flags' phrase is POSITIVE even when its words read vocabulary-negative", () => {
		const found = run(`
			describe("scan", () => {
				it("rejects malformed input", () => {
					expect(scan(a)).toBe(-17);
				});
				it("flags an invalid record", () => {
					expect(scan(b)).toBe(-17);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// Basis: same grammar; "silent" is a structural NEGATIVE phrase.
	it("P2: a title using the structural 'stays silent' phrase is NEGATIVE even when its words read vocabulary-positive", () => {
		const found = run(`
			describe("scan", () => {
				it("returns the shared code for a clean record", () => {
					expect(scan(a)).toBe(-17);
				});
				it("stays silent for a clean record", () => {
					expect(scan(b)).toBe(-17);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// Basis: bare "must not" is a documented extra phrase (test-discrimination-posneg.ts:124-126).
	it("P3: a describe titled with a bare 'must not' makes its untagged child NEGATIVE", () => {
		const found = run(`
			describe("the guard must not misreport", () => {
				it("case A returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("P1: case B returns the shared code too", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// Basis: "prefix wins over phrase" (test-discrimination-posneg.ts:136-137).
	it("P4: a bare 'N:' prefix wins over a conflicting 'positive' phrase in the same title", () => {
		const found = run(`
			describe("check", () => {
				it("N: handles positive input", () => {
					expect(check(x)).toBe(-7);
				});
				it("P1: returns the shared code", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// Basis: literalOrNull handles single-quoted strings as literals (test-discrimination-posneg.ts:185-191).
	it("P5: a shared SINGLE-quoted string literal counts like a double-quoted one", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(resolve(bad)).toBe('shared-code');
				});
				it("returns the shared code for a control record", () => {
					expect(resolve(control)).toBe('shared-code');
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// Basis: the reported line is the negative block's own line (existing P5 title);
	// InlineMatch lines are 1-based, so the first line of content is line 1.
	it("P6: the match is reported at the negative block's 1-based line", () => {
		const found = run(
			[
				`it("rejects an invalid record", () => {`,
				`	expect(validate(bad)).toBe(-99);`,
				`});`,
				`it("returns the shared outcome for a control record", () => {`,
				`	expect(validate(control)).toBe(-99);`,
				`});`,
			].join("\n"),
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// Basis: the constant-field exemption counts a field as varying when ANY
	// target ending in that field name takes another literal (isFieldInvariantAcrossFile
	// doc, test-discrimination-posneg.ts:356-359); a call-form target `svc.label(x)`
	// normalizes to `svc.label` and must still contribute its field name `label`.
	it("P7: a call-form target ending in the same field name makes a call-aliased field count as varying", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					const result = resolve(bad);
					expect(result.label).toBe("zz");
				});
				it("returns the shared label for a control record", () => {
					const result = resolve(control);
					expect(result.label).toBe("zz");
				});
			});
			describe("other", () => {
				it("observes a different label through a method call", () => {
					expect(svc.label(item)).toBe("yy");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});
});

describe("checkDuplicateExpectedLiteralPosNeg mutation hardening — negative (must not fire)", () => {
	// Basis: "TRIVIAL sentinels ... 0/1/-1/100" never count (test-discrimination-posneg.ts:56-58).
	it("N1: a shared numeric sentinel 100 never counts", () => {
		const found = run(`
			describe("limit", () => {
				it("rejects an invalid record", () => {
					expect(limit(bad)).toBe(100);
				});
				it("returns the shared outcome for a control record", () => {
					expect(limit(control)).toBe(100);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// Basis: only a "plain literal" counts (test-discrimination-posneg.ts:185-187);
	// an interpolated template is computed, not a literal.
	it("N2: a shared interpolated template string is not a plain literal", () => {
		const found = run(
			[
				`describe("label", () => {`,
				`	it("rejects an invalid record", () => {`,
				"		expect(label(bad)).toBe(`value-${bad.id}`);",
				`	});`,
				`	it("returns the shared outcome for a control record", () => {`,
				"		expect(label(control)).toBe(`value-${bad.id}`);",
				`	});`,
				`});`,
			].join("\n"),
		);
		expect(found).toHaveLength(0);
	});

	// Basis: the check's documented matcher set is toBe/toEqual/toStrictEqual/toThrow/toMatch
	// (test-discrimination-posneg.ts:453-457, LITERAL_MATCHERS at :40-41).
	it("N3: a shared literal passed to an untracked matcher (toContain) is ignored", () => {
		const found = run(`
			describe("render", () => {
				it("rejects an invalid record", () => {
					expect(render(bad)).toContain("shared-fragment");
				});
				it("returns the shared fragment for a control record", () => {
					expect(render(control)).toContain("shared-fragment");
				});
			});
		`);
		expect(found).toHaveLength(0);
	});
});
