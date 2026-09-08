import { describe, expect, it } from "vitest";
import { ERROR_ENTRIES } from "./entries-errors.js";

describe("ERROR_ENTRIES", () => {
	it("is non-empty", () => {
		expect(ERROR_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is severity=error and phase=pre_block (zero-FP contract)", () => {
		for (const c of ERROR_ENTRIES) {
			expect(c.severity, `${c.id} severity`).toBe("error");
			expect(c.phase, `${c.id} phase`).toBe("pre_block");
			expect(c.determinism, `${c.id} determinism`).toBe("fully_deterministic");
		}
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of ERROR_ENTRIES) {
			expect(c.pipeline).toBe("agent_safety");
		}
	});

	it("includes the canonical error-class checks (sanity: promise_reject_non_error)", () => {
		const ids = ERROR_ENTRIES.map((c) => c.id);
		expect(ids).toContain("promise_reject_non_error");
	});
});
