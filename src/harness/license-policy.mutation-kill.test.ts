import { describe, expect, it } from "vitest";
import { DEFAULT_LICENSE_ALLOWLIST, isLicenseAllowed } from "./license-policy.js";

describe("isLicenseAllowed — mutation-directed (operator case)", () => {
	// test-contract: public-api — the documented contract is case-insensitive for operators too; a lowercase `or` in a registry license field must still mean dual-licensing
	it("treats a lowercase `or` as the SPDX OR operator", () => {
		expect(isLicenseAllowed("GPL-3.0 or MIT", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	// test-contract: invariant — a lowercase `and` still requires every conjunct, so a disallowed conjunct keeps the expression refused
	it("treats a lowercase `and` as the SPDX AND operator", () => {
		expect(isLicenseAllowed("mit and isc", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
		expect(isLicenseAllowed("mit and gpl-3.0", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});
});
