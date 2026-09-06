import { describe, expect, it } from "vitest";
import { isReasonLegalInPhase, REASON_PHASES, REMOTE_PHASES, SHADOW_PHASES, SHADOW_UNAVAILABLE_REASONS } from "./reason-phases.js";

describe("REASON_PHASES — closed reason map (must hold)", () => {
	it("P1: timeout and cancelled are legal in every REMOTE phase", () => {
		expect([...REASON_PHASES.timeout]).toEqual([...REMOTE_PHASES]);
		expect([...REASON_PHASES.cancelled]).toEqual([...REMOTE_PHASES]);
	});

	it("P2: limits is legal wherever bounded output is produced, including admit and verify", () => {
		expect(REASON_PHASES.limits).toContain("verify");
		expect(REASON_PHASES.limits).toContain("admit");
	});

	it("P3: scanner failure is its own admit-phase reason, never folded into clean", () => {
		expect([...REASON_PHASES.scanner_unavailable]).toEqual(["admit"]);
	});

	it("P4: isReasonLegalInPhase accepts a declared pairing", () => {
		expect(isReasonLegalInPhase("projection", "project")).toBe(true);
		expect(isReasonLegalInPhase("dependency_source", "provision")).toBe(true);
	});

	it("P5: every reason and every phase is enumerated exactly once", () => {
		expect(new Set(SHADOW_UNAVAILABLE_REASONS).size).toBe(SHADOW_UNAVAILABLE_REASONS.length);
		expect(new Set(SHADOW_PHASES).size).toBe(SHADOW_PHASES.length);
		expect(Object.keys(REASON_PHASES).sort()).toEqual([...SHADOW_UNAVAILABLE_REASONS].sort());
	});
});

describe("REASON_PHASES — negative (must reject)", () => {
	it("N1: no reason maps to an empty phase list", () => {
		for (const [reason, phases] of Object.entries(REASON_PHASES)) {
			expect(phases.length, reason).toBeGreaterThan(0);
		}
	});

	it("N2: an undeclared reason/phase pairing is refused", () => {
		expect(isReasonLegalInPhase("secrets", "verify")).toBe(false);
		expect(isReasonLegalInPhase("mirror_lag", "admit")).toBe(false);
		expect(isReasonLegalInPhase("projection", "fetch")).toBe(false);
	});

	it("N3: every listed phase is a real phase — no typo can hide in the table", () => {
		for (const [reason, phases] of Object.entries(REASON_PHASES)) {
			for (const phase of phases) {
				expect(SHADOW_PHASES, `${reason}:${phase}`).toContain(phase);
			}
		}
	});
});
