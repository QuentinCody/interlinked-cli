import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGoBuild, runGolangciLint } from "../go.js";

describe("Go runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "go-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const input = () => ({
		scope: { projectRoot: tmp, mode: "project" as const },
		timeoutMs: 5_000,
	});

	it("runGoBuild is a function + returns [] without go.mod", () => {
		expect(typeof runGoBuild).toBe("function");
		expect(runGoBuild(input())).toEqual([]);
	});

	it("runGolangciLint is a function and does not report a missing module as clean", () => {
		expect(typeof runGolangciLint).toBe("function");
		const out = runGolangciLint(input());
		// Absent binary stays []; a real failure must be a no-verdict warning.
		expect(out.every((finding) => finding.message.includes("did not produce a verdict"))).toBe(true);
	});
});
