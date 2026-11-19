import { expect, it } from "vitest";
import { getNumericZeroDefaultEvidence, withNumericZeroDefaultEvidence } from "./numeric-zero-default-evidence.js";

it("restores nested query scopes after normal returns and throws", () => {
	const outer = { root: "/outer", importers: () => ({ files: [], complete: false }) };
	const inner = { root: "/inner", importers: () => ({ files: [], complete: true }) };
	expect(getNumericZeroDefaultEvidence()).toBeUndefined();
	withNumericZeroDefaultEvidence(outer, () => {
		expect(getNumericZeroDefaultEvidence()).toBe(outer);
		expect(() => withNumericZeroDefaultEvidence(inner, () => { throw new Error("scope control"); })).toThrow("scope control");
		expect(getNumericZeroDefaultEvidence()).toBe(outer);
		withNumericZeroDefaultEvidence(inner, () => expect(getNumericZeroDefaultEvidence()).toBe(inner));
	});
	expect(getNumericZeroDefaultEvidence()).toBeUndefined();
});
