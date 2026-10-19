import { describe, expect, it } from "vitest";
import { reservationPathMatchesPattern } from "./reservation-path-pattern.js";

describe("reservationPathMatchesPattern — positive (must fire)", () => {
	it("P1: exact path matches itself", () => {
		expect(reservationPathMatchesPattern("src/a.ts", "src/a.ts")).toBe(true);
	});
	it("P2: dir/** matches a nested file and the dir itself", () => {
		expect(reservationPathMatchesPattern("src/auth/login.ts", "src/auth/**")).toBe(true);
		expect(reservationPathMatchesPattern("src/auth", "src/auth/**")).toBe(true);
	});
	it("P3: **/*.ts and **/Makefile match in any directory", () => {
		expect(reservationPathMatchesPattern("deep/x/y.ts", "**/*.ts")).toBe(true);
		expect(reservationPathMatchesPattern("a/b/Makefile", "**/Makefile")).toBe(true);
		expect(reservationPathMatchesPattern("Makefile", "**/Makefile")).toBe(true);
	});
	it("P4: *.env matches by suffix", () => {
		expect(reservationPathMatchesPattern("staging.env", "*.env")).toBe(true);
	});
});

describe("reservationPathMatchesPattern — negative (must not fire)", () => {
	it("N1: a different exact path does not match", () => {
		expect(reservationPathMatchesPattern("src/b.ts", "src/a.ts")).toBe(false);
	});
	it("N2: dir/** does not match a sibling directory sharing the prefix", () => {
		expect(reservationPathMatchesPattern("src/authz/x.ts", "src/auth/**")).toBe(false);
	});
	it("N3: **/Makefile does not match a file merely ending in Makefile", () => {
		expect(reservationPathMatchesPattern("a/NotMakefile", "**/Makefile")).toBe(false);
	});
	it("N4: *.env does not match another extension", () => {
		expect(reservationPathMatchesPattern("staging.txt", "*.env")).toBe(false);
	});
});
