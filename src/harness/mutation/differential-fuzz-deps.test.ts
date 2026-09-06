import { describe, expect, it } from "vitest";
import {
	__resetDifferentialFuzzDepsCacheForTests,
	canResolve,
	differentialFuzzAvailability,
	loadFastCheck,
	loadTsModule,
	missingDependencyNote,
	transpileMutantModule,
} from "./differential-fuzz-deps.js";

describe("differential-fuzz-deps — positive (availability is honest and internally consistent)", () => {
	it("P1: differentialFuzzAvailability returns exactly the {ts, fastCheck} boolean shape", () => {
		const avail = differentialFuzzAvailability();
		expect(Object.keys(avail).sort()).toEqual(["fastCheck", "ts"]);
		expect(typeof avail.ts).toBe("boolean");
		expect(typeof avail.fastCheck).toBe("boolean");
	});

	it("P2: loadTsModule agrees with the availability flag, and resolves a usable compiler when true", () => {
		const avail = differentialFuzzAvailability();
		const ts = loadTsModule();
		expect(ts !== null).toBe(avail.ts);
		if (ts !== null) {
			expect(typeof ts.transpileModule).toBe("function");
		}
	});

	it("P3: loadFastCheck agrees with the availability flag, and resolves a usable module when true", async () => {
		const avail = differentialFuzzAvailability();
		const fc = await loadFastCheck();
		expect(fc !== null).toBe(avail.fastCheck);
		if (fc !== null) {
			expect(typeof fc.assert).toBe("function");
			expect(typeof fc.property).toBe("function");
		}
	});

	it("P4: transpileMutantModule strips types without type-checking when ts is available", () => {
		const out = transpileMutantModule("export const two: number = 1 + 1;", "probe.ts");
		if (differentialFuzzAvailability().ts) {
			expect(out).not.toBeNull();
			expect(out?.js).toContain("two");
			expect(out?.js).not.toContain(": number");
		} else {
			expect(out).toBeNull();
		}
	});

	it("P5: missingDependencyNote is empty when everything is available", () => {
		expect(missingDependencyNote({ ts: true, fastCheck: true })).toBe("");
	});

	it("P6: repeated calls return the SAME cached module reference (memoized, not re-resolved)", () => {
		expect(loadTsModule()).toBe(loadTsModule());
	});

	it("P7: canResolve returns true for a specifier that actually resolves from this module's location", () => {
		expect(canResolve("node:path")).toBe(true);
	});
});

describe("differential-fuzz-deps — negative (must report absence honestly, never throw)", () => {
	it("N1: missingDependencyNote names exactly the missing ones, in a stable order", () => {
		expect(missingDependencyNote({ ts: false, fastCheck: true })).toContain("typescript");
		expect(missingDependencyNote({ ts: true, fastCheck: false })).toContain("fast-check");
		const allMissing = missingDependencyNote({ ts: false, fastCheck: false });
		expect(allMissing).toContain("typescript");
		expect(allMissing).toContain("fast-check");
		expect(allMissing.indexOf("typescript")).toBeLessThan(allMissing.indexOf("fast-check"));
	});

	it("N2: missingDependencyNote never throws on the all-false shape", () => {
		expect(() => missingDependencyNote({ ts: false, fastCheck: false })).not.toThrow();
	});

	it("N3: canResolve catches an unresolvable specifier and returns false rather than throwing", () => {
		expect(() =>
			canResolve("definitely-not-a-real-package-xyz-p2u096"),
		).not.toThrow();
		expect(canResolve("definitely-not-a-real-package-xyz-p2u096")).toBe(false);
	});

	it("N3: cache reset does not change the resolution verdict (re-required, same outcome)", async () => {
		const before = differentialFuzzAvailability();
		__resetDifferentialFuzzDepsCacheForTests();
		expect(differentialFuzzAvailability()).toEqual(before);
		expect(loadTsModule() !== null).toBe(before.ts);
		expect(((await loadFastCheck()) !== null)).toBe(before.fastCheck);
	});
});
