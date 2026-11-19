import { expect, it } from "vitest";
import { getCommanderOptionEvidence, withCommanderOptionEvidence } from "./commander-option-evidence.js";

it("restores nested query providers and removes the provider after a throw", () => {
	const outer = { root: "/outer", importers: () => ({ files: [], complete: false }) };
	const inner = { root: "/inner", importers: () => ({ files: [], complete: false }) };
	expect(getCommanderOptionEvidence()).toBeUndefined();
	withCommanderOptionEvidence(outer, () => {
		expect(getCommanderOptionEvidence()).toBe(outer);
		expect(() => withCommanderOptionEvidence(inner, () => { expect(getCommanderOptionEvidence()).toBe(inner); throw new Error("controlled"); })).toThrow("controlled");
		expect(getCommanderOptionEvidence()).toBe(outer);
	});
	expect(getCommanderOptionEvidence()).toBeUndefined();
});
