import { describe, expect, it } from "vitest";
import { checkDuplicateExpectedLiteralPosNeg } from "./test-discrimination-posneg.js";

function run(content: string, path = "guard.test.ts"): ReturnType<typeof checkDuplicateExpectedLiteralPosNeg> {
	return checkDuplicateExpectedLiteralPosNeg(content, path);
}

describe("checkDuplicateExpectedLiteralPosNeg — positive (must fire)", () => {
	it("P1: negative title and positive title share a numeric literal via toBe, same target", () => {
		const found = run(`
			describe("parse", () => {
				it("rejects malformed input", () => {
					expect(parse("bad")).toBe(-42);
				});
				it("returns the sentinel for boundary input", () => {
					expect(parse("boundary")).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("duplicate_expected_literal_pos_neg");
		expect(found[0]?.text).toContain("-42");
	});

	it("P2: top-level (no describe) siblings share a string literal via toThrow on an arrow-wrapped call", () => {
		const found = run(`
			it("throws when the token is missing", () => {
				expect(() => tokenize(input)).toThrow("bad token");
			});
			it("shares the message for legacy input", () => {
				expect(() => tokenize(other)).toThrow("bad token");
			});
		`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("bad token");
	});

	it("P3: shared literal via toEqual, differing call arguments (target-only comparison ignores args)", () => {
		const found = run(`
			describe("compute", () => {
				it("returns the sentinel for an empty array", () => {
					expect(compute([])).toEqual(-13);
				});
				it("returns the same total for a placeholder run", () => {
					expect(compute(seedInput)).toEqual(-13);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	it("P4: shared string literal via toStrictEqual", () => {
		const found = run(`
			describe("resolve", () => {
				it("returns the sentinel record when the id is missing", () => {
					expect(resolve(id)).toStrictEqual("sentinel-record");
				});
				it("returns the default record for a fresh session", () => {
					expect(resolve(id)).toStrictEqual("sentinel-record");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	it("P5: fires at the negative block's own line, naming the positive sibling's line", () => {
		const found = run(`
			describe("validate", () => {
				it("rejects an invalid record", () => {
					expect(validate(bad)).toBe(-99);
				});
				it("matches the shared outcome for a control record", () => {
					expect(validate(control)).toBe(-99);
				});
			});
		`);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBeGreaterThan(0);
		expect(found[0]?.text).toContain("line");
	});

	// --- Title-direction rule: P/N prefix and describe-phrase inheritance ---

	it("P6: an N-prefixed title is NEGATIVE even with no vocabulary word, vs a P-prefixed POSITIVE sibling whose words read as vocabulary-negative", () => {
		const found = run(`
			describe("guard", () => {
				it("N1: returns the shared code for a boundary case", () => {
					expect(check(x)).toBe(-7);
				});
				it("P1: rejects duplicates but still returns the shared code", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("-7");
	});

	it("P7: an untagged it() inherits NEGATIVE from an enclosing 'negative (must not fire)' describe; a P-prefixed sibling overrides its inherited NEGATIVE to POSITIVE", () => {
		const found = run(`
			describe("guard — negative (must not fire)", () => {
				it("path A returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("P1: path B returns the shared code too", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	it("P8: a describe titled with 'must reject' (not covered by the base Check-Evidence phrase grammar) makes its untagged child NEGATIVE", () => {
		const found = run(`
			describe("token check — every case here must reject the input", () => {
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

	it("P9: a describe titled with 'must hold' makes its untagged child POSITIVE; an N-prefixed sibling overrides to NEGATIVE", () => {
		const found = run(`
			describe("invariant that must hold across restarts", () => {
				it("N1: a violation case returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("case B returns the shared code too", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Trivial-sentinel exclusion rule: a NON-trivial value still fires ---

	it("P10: a two-character, non-listed string literal still counts as a shared literal", () => {
		const found = run(`
			describe("status", () => {
				it("rejects a malformed record", () => {
					expect(status(x)).toBe("zz");
				});
				it("returns the same code for a placeholder", () => {
					expect(status(y)).toBe("zz");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Input-echo rule: a DIFFERENT echoed value must not suppress a real match ---

	it("P11: a similar but DIFFERENT value echoed earlier does not suppress the real shared literal (echo match is exact)", () => {
		const found = run(`
			describe("caps", () => {
				it("rejects malformed input", () => {
					capsSetAction("cyclomatic", "99");
					expect(capsFile()).toBe(15);
				});
				it("returns the shared value for a control run", () => {
					expect(capsFile()).toBe(15);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Constant-field rule: a call-aliased root counts when the FIELD VARIES elsewhere in the file ---

	it("P12: a bare property-path target whose root IS call-aliased still counts when the field takes a DIFFERENT literal elsewhere in the file (it genuinely varies)", () => {
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
				it("observes a different label elsewhere in the file", () => {
					// A DIFFERENT variable name than "result" so this doesn't
					// collide with the "resolve" describe's exact TARGET
					// (target-invariance is keyed by exact target, not field
					// name) — this block exercises field-NAME variance only.
					const otherResult = other();
					expect(otherResult.label).toBe("yy");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Input-echo rule: a nested object-literal argument is not over-suppressive ---

	it("P13: a DIFFERENT value nested in an object-literal argument does not suppress the real shared literal", () => {
		const found = run(`
			describe("coverage", () => {
				it("rejects a malformed report", () => {
					writeCoverageSummary(tmp, { "src/foo.ts": { lines: 99 } });
					expect(coverageStep(tmp)).toBe(80);
				});
				it("returns the shared value for a control run", () => {
					expect(coverageStep(tmp)).toBe(80);
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Literal-SET subset rule: an extra literal that's ALSO shared still fires ---

	it("P14: negative block's literal set is a SUBSET of the positive block's — fires", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(getCode(bad)).toBe(-7);
				});
				it("returns the shared code plus an extra shared detail for a control record", () => {
					expect(getCode(control)).toBe(-7);
					expect(getDetail(control)).toBe("shared-detail");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	it("P15: negative block has an EXTRA literal that ALSO appears in the positive block's set — still fires", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(getCode(bad)).toBe(-7);
					expect(getDetail(bad)).toBe("shared-detail");
				});
				it("returns the shared code plus the same detail for a control record", () => {
					expect(getCode(control)).toBe(-7);
					expect(getDetail(control)).toBe("shared-detail");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Target-invariance rule: a target asserted to exactly ONE literal
	// file-wide has never been proven to vary, so a shared-literal pair on
	// it is the "pure stub" case this detector exists to catch ---

	it("P16: the shared target's file-wide literal set has exactly one member — fires", () => {
		const found = run(`
			describe("guard", () => {
				it("allows a safe command", () => {
					expect(runGuard(cmd)).toBe("allow");
				});
				it("does not fire on a quoted mention", () => {
					expect(runGuard(other)).toBe("allow");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});

	// --- Literal-less-member rule: a target asserted with the SAME literal
	// everywhere (no toBeNull()/variable elsewhere) still reads as invariant ---

	it("P17: the target is asserted with the same literal everywhere in the file (no literal-less member elsewhere) — fires", () => {
		const found = run(`
			describe("guard", () => {
				it("allows a safe command", () => {
					expect(runGuard(cmd)).toBe("allow");
				});
				it("does not fire on a quoted mention", () => {
					expect(runGuard(other)).toBe("allow");
				});
			});
			describe("other tool entirely", () => {
				it("also allows its own safe input", () => {
					expect(runGuard(third)).toBe("allow");
				});
			});
		`);
		expect(found).toHaveLength(1);
	});
});

describe("checkDuplicateExpectedLiteralPosNeg — negative (must not fire)", () => {
	it("N1: literal differs between negative and positive siblings", () => {
		const found = run(`
			describe("parse", () => {
				it("rejects malformed input", () => {
					expect(parse("bad")).toBe(-42);
				});
				it("returns a normal value for good input", () => {
					expect(parse("ok")).toBe(-77);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N2: call target differs between negative and positive siblings", () => {
		const found = run(`
			describe("run", () => {
				it("rejects malformed input", () => {
					expect(parseA(x)).toBe(-42);
				});
				it("returns the default for a placeholder", () => {
					expect(parseB(x)).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N3: both siblings are negative-titled (skip — weaker smell, not this check's job)", () => {
		const found = run(`
			describe("validate", () => {
				it("rejects malformed input", () => {
					expect(validate(x)).toBe(-42);
				});
				it("throws for missing fields", () => {
					expect(validate(y)).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N4: positive sibling is skipped — a skipped case never runs and cannot vouch", () => {
		const found = run(`
			describe("compute", () => {
				it("rejects malformed input", () => {
					expect(compute(x)).toBe(-42);
				});
				it.skip("returns the same result for legacy input", () => {
					expect(compute(y)).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N5: the negative block itself is todo — excluded entirely", () => {
		const found = run(`
			describe("compute", () => {
				it.todo("rejects malformed input");
				it("returns the same result for legacy input", () => {
					expect(compute(y)).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N6: siblings live in different describe scopes", () => {
		const found = run(`
			describe("A", () => {
				it("rejects malformed input", () => {
					expect(parse(x)).toBe(-42);
				});
			});
			describe("B", () => {
				it("returns the fallback for legacy input", () => {
					expect(parse(y)).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N7: not a test file — the check no-ops regardless of content shape", () => {
		const found = run(
			`
			describe("parse", () => {
				it("rejects malformed input", () => { expect(parse("bad")).toBe(-42); });
				it("returns the sentinel for boundary input", () => { expect(parse("boundary")).toBe(-42); });
			});
		`,
			"src/lib/parse.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N8: negated matcher chain (.not.toBe) is a different assertion, not a duplicate", () => {
		const found = run(`
			describe("parse", () => {
				it("rejects malformed input", () => {
					expect(parse("bad")).not.toBe(-42);
				});
				it("returns the sentinel for boundary input", () => {
					expect(parse("boundary")).toBe(-42);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Title-direction rule: never compare two same-direction blocks ---

	it("N9: two untagged its inheriting NEGATIVE from the same 'negative (must not fire)' describe are never compared to each other", () => {
		const found = run(`
			describe("guard — negative (must not fire)", () => {
				it("path A returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("path B returns the shared code too", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N10: two untagged its inheriting POSITIVE from the same 'positive (must fire)' describe are never compared to each other", () => {
		const found = run(`
			describe("guard — positive (must fire)", () => {
				it("path A returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("path B returns the shared code too", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N11: a P-prefixed title is POSITIVE even though its words read as vocabulary-negative — no fire against another POSITIVE", () => {
		const found = run(`
			describe("guard", () => {
				it("P1: rejects duplicates but still returns the shared code", () => {
					expect(check(x)).toBe(-7);
				});
				it("returns the shared code for an ordinary case", () => {
					expect(check(y)).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Trivial-sentinel exclusion rule ---

	it("N12: shared numeric sentinel 0 never counts, even with an otherwise-matching negative/positive pair", () => {
		const found = run(`
			describe("parse", () => {
				it("rejects malformed input", () => {
					expect(parse("bad")).toBe(0);
				});
				it("returns the shared code for a placeholder", () => {
					expect(parse("boundary")).toBe(0);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N13: shared string sentinel 'ok' never counts", () => {
		const found = run(`
			describe("status", () => {
				it("rejects malformed input", () => {
					expect(status(x)).toBe("ok");
				});
				it("returns the same code for a placeholder", () => {
					expect(status(y)).toBe("ok");
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N14: a one-character string literal never counts (shorter than two characters)", () => {
		const found = run(`
			describe("status", () => {
				it("rejects malformed input", () => {
					expect(status(x)).toBe("a");
				});
				it("returns the same code for a placeholder", () => {
					expect(status(y)).toBe("a");
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Input-echo rule: an echoed value never counts ---

	it("N15: a literal echoed earlier as a call argument in the NEGATIVE block's own body is never counted (input echo)", () => {
		const found = run(`
			describe("caps", () => {
				it("rejects malformed input", () => {
					capsSetAction("cyclomatic", "15");
					expect(capsFile()).toBe(15);
				});
				it("returns the shared value for a control run", () => {
					expect(capsFile()).toBe(15);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Constant-field rule: a bare, un-aliased property path never counts ---

	it("N16: a bare property-path target with no call anywhere and no call-derived alias in either body is a constant field", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(result.label).toBe("zz");
				});
				it("returns the shared label for a control record", () => {
					expect(result.label).toBe("zz");
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N17: a bare property-path target whose root IS call-aliased is a constant field when the FIELD NEVER VARIES anywhere in the file", () => {
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
		`);
		expect(found).toHaveLength(0);
	});

	// --- Input-echo rule: a value nested inside an object-literal argument ---

	// --- Literal-SET subset rule: any extra literal the positive lacks suppresses the fire ---

	it("N1: negative block has an extra distinct string literal the positive block does not assert — no fire", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(resolve(bad).code).toBe(-7);
					expect(resolve(bad).detail).toBe("only-on-negative");
				});
				it("returns the shared code for a control record", () => {
					expect(resolve(control).code).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N2: negative block has an extra distinct regex literal via toMatch the positive block does not assert — no fire", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(resolve(bad).code).toBe(-7);
					expect(resolve(bad).message).toMatch(/only on negative/);
				});
				it("returns the shared code for a control record", () => {
					expect(resolve(control).code).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N3: negative block has an extra distinct literal nested one level in a toEqual({...}) argument the positive block does not assert — no fire", () => {
		const found = run(`
			describe("resolve", () => {
				it("rejects an invalid record", () => {
					expect(resolve(bad).code).toBe(-7);
					expect(resolve(bad).report).toEqual({ onlyOnNegative: 42 });
				});
				it("returns the shared code for a control record", () => {
					expect(resolve(control).code).toBe(-7);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N18: a literal nested inside an object-literal argument of a call in the negative block's body is treated as an echoed input", () => {
		const found = run(`
			describe("coverage", () => {
				it("rejects a malformed report", () => {
					writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80 } });
					expect(coverageStep(tmp)).toBe(80);
				});
				it("returns the shared value for a control run", () => {
					expect(coverageStep(tmp)).toBe(80);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Target-invariance rule: a target proven to vary elsewhere means the
	// other assertion already kills the stub, so this shared-literal pair is
	// a legitimate "must not over-fire" guard, not a duplicate ---

	it("N19: the shared target is asserted \"allow\" here and \"block\" elsewhere in the file — no fire", () => {
		const found = run(`
			describe("guard", () => {
				it("allows a safe command", () => {
					expect(runGuard(cmd)).toBe("allow");
				});
				it("does not fire on a quoted mention", () => {
					expect(runGuard(other)).toBe("allow");
				});
			});
			describe("blocking", () => {
				it("blocks rm -rf /", () => {
					expect(runGuard(bad)).toBe("block");
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	// --- Literal-less-member rule: toBeNull()/a variable elsewhere proves
	// the target varies even though it contributes no literal of its own ---

	it("N20: the shared target is asserted a literal here and toBeNull() elsewhere in the file — no fire", () => {
		const found = run(`
			describe("guard", () => {
				it("allows a safe command", () => {
					expect(runGuard(cmd)).toBe("allow");
				});
				it("does not fire on a quoted mention", () => {
					expect(runGuard(other)).toBe("allow");
				});
			});
			describe("elsewhere", () => {
				it("returns null for a disabled guard", () => {
					expect(runGuard(disabled)).toBeNull();
				});
			});
		`);
		expect(found).toHaveLength(0);
	});

	it("N21: the shared target is asserted a literal here and a non-literal expression (a variable) elsewhere in the file — no fire", () => {
		const found = run(`
			describe("guard", () => {
				it("allows a safe command", () => {
					expect(runGuard(cmd)).toBe("allow");
				});
				it("does not fire on a quoted mention", () => {
					expect(runGuard(other)).toBe("allow");
				});
			});
			describe("elsewhere", () => {
				it.each(modes)("returns the configured mode %s", (mode) => {
					expect(runGuard(cfg)).toBe(mode);
				});
			});
		`);
		expect(found).toHaveLength(0);
	});
});
