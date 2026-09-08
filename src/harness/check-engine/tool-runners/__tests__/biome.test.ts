import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBiome } from "../biome.js";

describe("runBiome", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "biome-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] on an empty tmpdir (no biome config → nothing to lint)", () => {
		const results = runBiome({
			scope: { projectRoot: tmp, mode: "project" },
			timeoutMs: 5_000,
		});
		expect(Array.isArray(results)).toBe(true);
	});
});
