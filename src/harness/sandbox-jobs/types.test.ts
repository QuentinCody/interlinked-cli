// Pins the SandboxJob contract — the load-bearing assertion is that the wire
// shape has no execution channel and the validator rejects any smuggled one.

import { describe, expect, it } from "vitest";
import { isValidSandboxJobRequest, type SandboxJobRequest } from "./types.js";

const base: SandboxJobRequest = {
	schemaVersion: 1,
	kind: "leak",
	sessionId: "s1",
	file: "src/x.ts",
	overlays: [{ path: "src/x.ts", content: "export const a = 1;" }],
	timeoutMs: 25_000,
	riskTier: "lite",
};

describe("isValidSandboxJobRequest", () => {
	it.each([{ file: null }, { sessionId: 42 }, { overlays: [null] }, { overlays: [[]] }])("rejects invalid file/session identities and non-object overlays: %j", (invalid) => {
		expect(isValidSandboxJobRequest({ ...base, ...invalid })).toBe(false);
	});
	it("accepts a well-formed request for every known kind", () => {
		for (const kind of ["mutation", "leak", "flake", "asan", "miri"] as const) {
			expect(isValidSandboxJobRequest({ ...base, kind })).toBe(true);
		}
	});

	it("rejects an unknown kind", () => {
		expect(isValidSandboxJobRequest({ ...base, kind: "arbitrary" })).toBe(false);
	});

	it("rejects any smuggled execution channel (the security invariant)", () => {
		for (const forbidden of ["command", "argv", "script", "cmd", "exec", "shell"]) {
			expect(
				isValidSandboxJobRequest({ ...base, [forbidden]: "rm -rf /" }),
				`must reject a request carrying '${forbidden}'`,
			).toBe(false);
		}
	});

	// riskTier regression (2026-08-09): declared required, validated by nothing.
	// It selects which oracles run and how hard, so an absent or bogus tier
	// reaching Worker triage is a privilege decision made on undefined.
	it("accepts every declared risk tier", () => {
		for (const riskTier of ["trivial", "lite", "full"] as const) {
			expect(isValidSandboxJobRequest({ ...base, riskTier })).toBe(true);
		}
	});

	it("rejects a request with no riskTier at all", () => {
		const { riskTier: _omitted, ...noTier } = base;
		expect(isValidSandboxJobRequest(noTier)).toBe(false);
	});

	it("rejects a riskTier outside the declared union", () => {
		expect(isValidSandboxJobRequest({ ...base, riskTier: "none" })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, riskTier: "trivial " })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, riskTier: 0 })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, riskTier: { tier: "full" } })).toBe(false);
	});

	it("rejects malformed overlays and missing required fields", () => {
		expect(isValidSandboxJobRequest({ ...base, overlays: "nope" })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, overlays: [{ path: "x" }] })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, schemaVersion: 2 })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, timeoutMs: "soon" })).toBe(false);
		expect(isValidSandboxJobRequest(null)).toBe(false);
		expect(isValidSandboxJobRequest("string")).toBe(false);
	});
});
