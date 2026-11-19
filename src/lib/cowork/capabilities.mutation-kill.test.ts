import { describe, expect, it } from "vitest";
import { coworkHookSettings } from "./capabilities.js";

describe("coworkHookSettings — census kill", () => {
	// test-contract: invariant — every generated hook command carries a 15 second timeout
	it("sets timeout 15 on each hook entry", () => {
		for (const probe of [false, true]) {
			const hooks = coworkHookSettings("/x/cowork-hook.js", probe).hooks as Record<
				string,
				{ hooks: { timeout: number }[] }[]
			>;
			const entries = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
			expect(entries.length).toBeGreaterThan(0);
			for (const entry of entries) expect(entry.timeout).toBe(15);
		}
	});
});
