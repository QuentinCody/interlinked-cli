import { describe, expect, it } from "vitest";
import { CI_FALLBACK_SEED, ciGlobalSeed, parsePropertyBudget } from "./property-budget.js";

describe("parsePropertyBudget", () => {
    it("does not install the CI fallback or override seed during varying-seed exploration", () => {
        expect(ciGlobalSeed({ CI: "1", INTERLINKED_FC_EXPLORE: "1" })).toBeNull();
        expect(ciGlobalSeed({ CI: "1", INTERLINKED_FC_EXPLORE: "1", INTERLINKED_FC_CI_SEED: "77" })).toBeNull();
    });
	it("returns null when unset", () => {
		expect(parsePropertyBudget(undefined)).toBeNull();
		expect(parsePropertyBudget("")).toBeNull();
	});

	it("parses a positive integer", () => {
		expect(parsePropertyBudget("30")).toBe(30);
		expect(parsePropertyBudget("1")).toBe(1);
	});

	it("returns null for non-positive or non-numeric values", () => {
		expect(parsePropertyBudget("0")).toBeNull();
		expect(parsePropertyBudget("-5")).toBeNull();
		expect(parsePropertyBudget("abc")).toBeNull();
	});

	it("P1: under CI the global seed is the explicit INTERLINKED_FC_CI_SEED or the fixed fallback", () => {
		expect(ciGlobalSeed({ CI: "true" })).toBe(CI_FALLBACK_SEED);
		expect(ciGlobalSeed({ CI: "1", INTERLINKED_FC_CI_SEED: "77" })).toBe(77);
		expect(ciGlobalSeed({ CI: "1", INTERLINKED_FC_CI_SEED: "abc" })).toBe(CI_FALLBACK_SEED);
	});

	it("N1: outside CI there is no global seed (local runs stay random)", () => {
		expect(ciGlobalSeed({})).toBeNull();
		expect(ciGlobalSeed({ INTERLINKED_FC_CI_SEED: "77" })).toBeNull();
	});

	it("is inert as a module import when the env is unset (no throw)", async () => {
		// Importing the setup module with INTERLINKED_PROPERTY_NUMRUNS unset must
		// not load fast-check or mutate global config — a bare re-import is safe.
		await expect(import("./property-budget.js")).resolves.toBeDefined();
	});
});
