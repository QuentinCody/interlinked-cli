import { expect, it } from "vitest";
import { DMMULROY_TYPESCRIPT_PROFILE } from "./profile.js";

it("pins portable source provenance and retains every standard group", () => {
	const profile = DMMULROY_TYPESCRIPT_PROFILE;
	expect(profile.id).toBe("dmmulroy-typescript");
	expect(profile.source.revision).toBe("db1b93212222dc5b1a723e48aedb2ed1835b1ed7");
	expect(profile.source.sha256).toBe("059a56054945277ea835ebcbf2030bb6613113c2cd066226f88e1424e7307642");
	expect(profile.standards).toHaveLength(35);
	expect(new Set(profile.standards.map(row => row.id)).size).toBe(35);
	for (const row of profile.standards) {
		expect(row.source.startLine).toBeGreaterThan(0);
		expect(row.source.endLine).toBeGreaterThanOrEqual(row.source.startLine);
		expect(row.source.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(row.unmeasured.length).toBeGreaterThan(0);
	}
});

it("retains unsupported guidance without private measurements or automatic policy adoption", () => {
	const future = DMMULROY_TYPESCRIPT_PROFILE.standards.find(row => row.id === "s35");
	expect(future?.checkIds).toEqual([]);
	expect(future?.syntaxRules).toEqual([]);
	expect(JSON.stringify(DMMULROY_TYPESCRIPT_PROFILE)).not.toContain('"measurements"');
	expect(JSON.stringify(DMMULROY_TYPESCRIPT_PROFILE)).not.toContain("/Users/");
});
