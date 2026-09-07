// Companion for the call-scoping resolver used by
// checkDuplicateThrowMessageAssertion — see that module's doc comment for
// the "why call-scoped" rationale. Full end-to-end coverage of the detector
// lives in test-discrimination-throw.test.ts; this file pins the resolver
// primitives directly, including the double-counting regression found via
// calibration (a plain `arr.map((x) => {...})` call must never be misread
// as a declaration of a function named `map`).

import { describe, expect, it } from "vitest";
import { calleeNameNearOffset, collectCalledIdentifiers, throwSitesReachableFrom } from "./test-discrimination-throw-scope.js";

describe("throwSitesReachableFrom — positive (must fire)", () => {
	it("P1: collects throw sites from a `function NAME(...)` declaration's own body", () => {
		const sut = `
export function a(x) {
	if (x < 0) throw new Error("bad");
	if (x > 10) throw new Error("bad");
}
`;
		expect(throwSitesReachableFrom(sut, "a")).toEqual([{ message: "bad" }, { message: "bad" }]);
	});

	it("P2: collects throw sites from a method-shorthand body", () => {
		const sut = `
const obj = {
	run(x) {
		if (x < 0) throw new Error("bad");
	},
};
`;
		expect(throwSitesReachableFrom(sut, "run")).toEqual([{ message: "bad" }]);
	});

	it("P3: collects throw sites from an arrow-assigned body", () => {
		const sut = `
const run = (x) => {
	if (x < 0) throw new Error("bad");
};
`;
		expect(throwSitesReachableFrom(sut, "run")).toEqual([{ message: "bad" }]);
	});

	it("P4: includes one hop into a same-file helper the body calls", () => {
		const sut = `
function validate(x) {
	if (x < 0) throw new Error("bad");
}
export function a(x) {
	validate(x);
	if (x > 10) throw new Error("bad");
}
`;
		expect(throwSitesReachableFrom(sut, "a")).toEqual([{ message: "bad" }, { message: "bad" }]);
	});
});

describe("throwSitesReachableFrom — negative (must not fire)", () => {
	it("N1: returns null when the name resolves to no declaration in the SUT", () => {
		const sut = `export function a(x) { if (x < 0) throw new Error("bad"); }`;
		expect(throwSitesReachableFrom(sut, "nowhereToBeFound")).toBeNull();
	});

	it("N2: a plain call with an inline arrow argument is NOT read as a declaration of that call's name (regression)", () => {
		// `specs.map((spec) => { ... })` must not be misread as a function named
		// `map` whose body is the arrow callback — that duplicated throw sites
		// already counted in the enclosing function's own body (found via
		// calibration against src/lib/gated-file-transaction.ts).
		const sut = `
export function a(specs) {
	if (specs.length === 0) throw new Error("bad");
	const writes = specs.map((spec) => {
		if (spec.bad) throw new Error("bad");
		return spec;
	});
	return writes;
}
`;
		// The real fix bounds this to a's OWN body (2 sites, not read again via
		// a bogus "map" hop): the throw inside the arrow is legitimately part of
		// a's body already (nested), so it appears once, not twice.
		expect(throwSitesReachableFrom(sut, "a")).toEqual([{ message: "bad" }, { message: "bad" }]);
	});
});

describe("calleeNameNearOffset — positive (must fire)", () => {
	it("P1: resolves a chain call to its last link", () => {
		const test = 'it("x", () => { expect(clientWith(fake).claimResult(JOB)).rejects.toThrow("x"); });';
		expect(calleeNameNearOffset(test, test.indexOf('.toThrow("x")'))).toBe("claimResult");
	});

	it("P2: is NOT fooled by a nested call inside an argument (regression)", () => {
		// `Float32Array.from(...)` is nested INSIDE aggregateFunctionVectors's own
		// argument list — the textually-last `name(` match is "from", but the
		// function actually under test is aggregateFunctionVectors. Found via
		// calibration against src/harness/semantic/embed-function.test.ts.
		const test = 'it("x", () => { expect(() => aggregateFunctionVectors([Float32Array.from([1, 0])], [], 2)).toThrow(/omitted/); });';
		expect(calleeNameNearOffset(test, test.indexOf(".toThrow(/omitted/)"))).toBe("aggregateFunctionVectors");
	});
});

describe("collectCalledIdentifiers — positive (must fire)", () => {
	it("P1: collects call identifiers, excluding the function's own name and control keywords", () => {
		const body = `{ if (x) { helperOne(x); } for (;;) { helperTwo(); } a(x); }`;
		expect(collectCalledIdentifiers(body, "a").sort()).toEqual(["helperOne", "helperTwo"]);
	});
});

describe("collectCalledIdentifiers — negative (must not fire)", () => {
	it("N1: returns an empty list for a body with no calls", () => {
		expect(collectCalledIdentifiers("{ return 1; }", "a")).toEqual([]);
	});
});
