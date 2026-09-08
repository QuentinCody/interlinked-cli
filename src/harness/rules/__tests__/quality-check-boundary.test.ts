import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../../rules-loader.js";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "rules-quality-boundary-"));
	mkdirSync(join(cwd, ".interlinked"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeRules(value: unknown, local = true): void {
	writeFileSync(join(cwd, ".interlinked", local ? "guard-rules.local.json" : "guard-rules.json"), JSON.stringify(value));
}

describe("quality-check JSON boundaries", () => {
	it.each([null, [], 42, "invalid"])("ignores a non-object quality-check map: %j", (quality_checks) => {
		const before = loadRules(cwd).quality_checks;
		writeRules({ quality_checks });
		expect(loadRules(cwd).quality_checks).toEqual(before);
	});

	it("keeps valid local fields while rejecting malformed sibling fields", () => {
		const before = loadRules(cwd).quality_checks.typescript;
		writeRules({ quality_checks: { typescript: {
			enabled: false, command: "custom-tsc", file_types: [".ts", 4], timeout_ms: "slow",
			severity: "fatal", description: null, skip_test_files: "yes", use_osv_scanner: 1,
			mode: "typo", slack: "many", offline: [], max_dependent_tests: {},
		} } });
		expect(loadRules(cwd).quality_checks.typescript).toEqual({ ...before, enabled: false, command: "custom-tsc" });
	});

	it("adds complete valid checks beside malformed and incomplete entries", () => {
		const custom = {
			enabled: true, command: "custom-check", file_types: [".ts"], timeout_ms: 500,
			severity: "warning", description: "Custom checker", skip_test_files: true,
			use_osv_scanner: false, mode: "warn", slack: 2, offline: true, max_dependent_tests: 3,
		};
		writeRules({ quality_checks: {
			invalid: { enabled: true, file_types: 42, timeout_ms: "slow", severity: "typo" },
			null_entry: null, array_entry: [], incomplete: { enabled: false }, custom,
		} });
		const checks = loadRules(cwd).quality_checks;
		expect(checks.custom).toEqual(custom);
		expect(checks.invalid).toBeUndefined();
		expect(checks.null_entry).toBeUndefined();
		expect(checks.array_entry).toBeUndefined();
		expect(checks.incomplete).toBeUndefined();
	});

	it("does not treat prototype keys as existing team checks", () => {
		const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
		writeRules(JSON.parse('{"quality_checks":{"__proto__":{"enabled":false},"constructor":{"enabled":false}}}'), false);
		const checks = loadRules(cwd).quality_checks;
		expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
		expect(Object.hasOwn(checks, "__proto__")).toBe(false);
		expect(Object.hasOwn(checks, "constructor")).toBe(false);
	});

	it("adds a local prototype-named check as an own entry without changing the map prototype", () => {
		const custom = { enabled: true, file_types: [".ts"], timeout_ms: 500, severity: "warning" };
		const value: unknown = JSON.parse(`{"quality_checks":{"__proto__":${JSON.stringify(custom)}}}`);
		writeRules(value);
		const checks = loadRules(cwd).quality_checks;
		expect(Object.getPrototypeOf(checks)).toBe(Object.prototype);
		expect(Object.hasOwn(checks, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(checks, "__proto__")?.value).toEqual(custom);
	});

	it("limits team structural booleans to declared boolean settings", () => {
		const before = loadRules(cwd).structural_checks;
		writeRules({ structural_checks: { enabled: false, max_barrel_exports: true, invented_setting: true } }, false);
		expect(loadRules(cwd).structural_checks).toEqual({ ...before, enabled: false });
	});
});
