import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTaplo } from "../taplo.js";

describe("runTaplo", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "taplo-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an array on an empty tmpdir (no .toml files to validate)", () => {
		expect(
			Array.isArray(
				runTaplo({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});
});
