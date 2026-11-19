import { describe, expect, it } from "vitest";
import { annotateRelations, isCompanionPair, languageLookup, type CouplingPair } from "./metrics-coupling.js";

function pair(a: string, b: string): CouplingPair {
	return { a, b, support: 5, revA: 6, revB: 6, strength: 80, percentile: 90 };
}

describe("isCompanionPair — Python test naming", () => {
	it("MUST-FIRE: test_<stem>.py beside <stem>.py, and <stem>_test.py, are companions", () => {
		expect(isCompanionPair("pkg/test_core.py", "pkg/core.py")).toBe(true);
		expect(isCompanionPair("pkg/core.py", "pkg/core_test.py")).toBe(true);
	});

	it("MUST-FIRE: the test file in a tests/ folder next to the module's folder", () => {
		expect(isCompanionPair("pkg/tests/test_core.py", "pkg/core.py")).toBe(true);
	});

	it("MUST-NOT-FIRE: a different stem, or two modules, are not companions", () => {
		expect(isCompanionPair("pkg/test_core.py", "pkg/other.py")).toBe(false);
		expect(isCompanionPair("pkg/core.py", "pkg/util.py")).toBe(false);
		expect(isCompanionPair("pkg/test_core.py", "pkg/test_core_extra.py")).toBe(false);
	});
});

describe("languageLookup", () => {
	const scripts = (): boolean | null => null;
	const python = (a: string, b: string): boolean | null => (a === "a.py" && b === "b.py" ? true : false);

	it("MUST-FIRE: a pair of Python files goes to the Python graph, every other pair to the script graph", () => {
		const lookup = languageLookup(scripts, python);
		expect(lookup("a.py", "b.py")).toBe(true);
		expect(lookup("a.py", "c.py")).toBe(false);
		expect(lookup("a.ts", "b.ts")).toBeNull();
		expect(lookup("a.py", "b.ts")).toBeNull();
	});

	it("labels Python pairs linked, hidden and unknown by the same rule as every language", () => {
		const lookup = languageLookup(scripts, (a) => (a === "u.py" ? null : a === "l.py"));
		const rows = annotateRelations([pair("l.py", "m.py"), pair("h.py", "m.py"), pair("u.py", "m.py")], lookup);
		expect(rows.map((row) => row.relation)).toEqual(["linked", "hidden", "unknown"]);
	});
});
