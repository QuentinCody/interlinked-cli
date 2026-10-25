// Cross-repo falsification of the `number_precision_loss` pre_warn check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json). Every
// N1-N6 negative below is REAL code from a foreign repository (tinybench) that
// an independent adjudication confirmed as a false positive: the 16+ digit run
// was the FRACTION of a float literal, not an integer literal. Each is
// attributed to its source file:line. The positives pin the bug class so the
// refinement cannot become a blanket exemption of long digit runs.
import { describe, expect, it } from "vitest";
import { checkNumberPrecisionLoss } from "../../checks/agent-safety-js-correctness.js";

describe("number_precision_loss — negative (must not fire)", () => {
	it("N1: tinybench src/student-t.ts:23 — fraction digits of a Lanczos coefficient are not an integer literal", () => {
		// tinybench/src/student-t.ts lines 21-25 (Lanczos coefficients, g=7).
		const content = [
			"const [leading, ...rest] = [",
			"  0.99999999999980993, 676.5203681218851, -1259.1392167224028,",
			"  771.32342877765313, -176.61502916214059, 12.507343278686905,",
			"]",
		].join("\n");
		expect(checkNumberPrecisionLoss(content, "src/student-t.ts")).toEqual([]);
	});

	it("N2: tinybench src/student-t.ts:25 — mantissa fraction digits before an exponent are not an integer literal", () => {
		// tinybench/src/student-t.ts line 24.
		const content = "  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,\n";
		expect(checkNumberPrecisionLoss(content, "src/student-t.ts")).toEqual([]);
	});

	it("N3: tinybench test/student-t.test.ts:143 — fraction digits of an expected critical value", () => {
		// tinybench/test/student-t.test.ts line 143.
		expect(checkNumberPrecisionLoss("  [74, 1.9925434951809327],\n", "test/student-t.test.ts")).toEqual([]);
	});

	it("N4: tinybench test/student-t.test.ts:145 — fraction digits of an expected critical value", () => {
		// tinybench/test/student-t.test.ts line 145.
		expect(checkNumberPrecisionLoss("  [80, 1.9900634212544461],\n", "test/student-t.test.ts")).toEqual([]);
	});

	it("N5: tinybench test/student-t.test.ts:146 — fraction digits of an expected critical value", () => {
		// tinybench/test/student-t.test.ts line 146.
		expect(checkNumberPrecisionLoss("  [100, 1.9839715185235522],\n", "test/student-t.test.ts")).toEqual([]);
	});

	it("N6: tinybench test/student-t.test.ts:148 — fraction digits of an expected critical value", () => {
		// tinybench/test/student-t.test.ts line 148.
		expect(checkNumberPrecisionLoss("  [150, 1.9759053308966206],\n", "test/student-t.test.ts")).toEqual([]);
	});

	it("N7: synthetic — a leading-dot fraction and a float exponent are not integer literals", () => {
		const content = "const a = .12345678901234567;\nconst b = 1.5e+12345678901234567;\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toEqual([]);
	});

	it("N8: synthetic — every decimal mantissa shape keeps its exponent exempt", () => {
		const content = [
			"const a = 15e-12345678901234567;",
			"const b = .5e+12345678901234567;",
			"const c = 1.e+12345678901234567;",
			"const d = 1_000E12345678901234567;",
			"const e = [2.5e-12345678901234567, -3E+12345678901234567];",
		].join("\n");
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toEqual([]);
	});
});

describe("number_precision_loss — positive (must fire)", () => {
	it("P1: an unsafe integer literal beside float literals on the same line still fires", () => {
		const content = "const row = [1.9925434951809327, 9007199254740993];\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toEqual([
			{ line: 1, text: "const row = [1.9925434951809327, 9007199254740993];" },
		]);
	});

	it("P2: the INTEGER part of a float literal beyond 2^53 still fires", () => {
		const content = "const big = 12345678901234567.5;\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toEqual([
			{ line: 1, text: "const big = 12345678901234567.5;" },
		]);
	});

	it("P3: a spread of an unsafe integer is not mistaken for a decimal point", () => {
		const content = "const xs = [...12345678901234567];\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toHaveLength(1);
	});

	it("P4: an unsafe integer after a subtraction from an identifier named e still fires", () => {
		const content = "const d = e-12345678901234567;\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toHaveLength(1);
	});

	// Repair (2026-10-21 verifier): the exponent exemption must require a
	// numeric mantissa that starts at a token boundary. Each shape below is
	// unspaced arithmetic, not a float exponent, so the unsafe integer fires.
	it("P5: repair — member named e minus an unsafe integer (obj.e-N)", () => {
		const line = "const d = obj.e-12345678901234567;";
		expect(checkNumberPrecisionLoss(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line }]);
	});

	it("P6: repair — member named E plus an unsafe integer (obj.E+N)", () => {
		const line = "const d = obj.E+12345678901234567;";
		expect(checkNumberPrecisionLoss(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line }]);
	});

	it("P7: repair — identifier ending in digit+e minus an unsafe integer (x1e-N)", () => {
		const line = "const d = x1e-12345678901234567;";
		expect(checkNumberPrecisionLoss(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line }]);
	});

	it("P8: repair — hex literal plus an unsafe integer (0x1e+N)", () => {
		const line = "const d = 0x1e+12345678901234567;";
		expect(checkNumberPrecisionLoss(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line }]);
	});
});
