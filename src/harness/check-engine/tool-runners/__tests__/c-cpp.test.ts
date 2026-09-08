import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCCompile, runClangTidy } from "../c-cpp.js";

describe("C/C++ runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ccpp-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("runCCompile returns [] on an empty tmpdir (no .c/.cpp files)", () => {
		expect(
			Array.isArray(
				runCCompile({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});

	it("runClangTidy returns [] on an empty tmpdir", () => {
		expect(
			Array.isArray(
				runClangTidy({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});
});
