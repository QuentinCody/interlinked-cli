import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { biomeForegroundSizeArgs } from "./biome-size-policy.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "biome-size-policy-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("removes only the implicit native file size bound for plain and JSONC configurations", () => {
	writeFileSync(join(root, "biome.jsonc"), '{ /* policy */ "files": {"includes":["**/*.js",]}, }');
	expect(biomeForegroundSizeArgs(root)).toEqual(["--files-max-size=18446744073709551615"]);
});
it("preserves an explicit maximum and ambiguous or malformed inherited policies", () => {
	for (const config of [{ files: { maxSize: 128 } }, { extends: ["./missing.json"] }, { extends: ["//"] }]) {
		writeFileSync(join(root, "biome.json"), JSON.stringify(config));
		expect(biomeForegroundSizeArgs(root)).toEqual([]);
	}
	writeFileSync(join(root, "biome.json"), "{ malformed");
	expect(biomeForegroundSizeArgs(root)).toEqual([]);
});
it("detects explicit local and package-inherited maximums using data-only resolution", () => {
	writeFileSync(join(root, "base.json"), '{"files":{"maxSize":128}}');
	writeFileSync(join(root, "biome.json"), '{"extends":["./base.json"]}');
	expect(biomeForegroundSizeArgs(root)).toEqual([]);
	mkdirSync(join(root, "node_modules/fixture-biome"), { recursive: true });
	writeFileSync(join(root, "node_modules/fixture-biome/package.json"), '{"name":"fixture-biome","exports":"./policy.json"}');
	writeFileSync(join(root, "node_modules/fixture-biome/policy.json"), '{"files":{"maxSize":256}}');
	writeFileSync(join(root, "biome.json"), '{"extends":["fixture-biome"]}');
	expect(biomeForegroundSizeArgs(root)).toEqual([]);
});
it("removes the implicit bound for a resolved inheritance graph without explicit maxSize", () => {
	writeFileSync(join(root, "base.json"), '{"files":{"includes":["**/*.js"]}}');
	writeFileSync(join(root, "biome.json"), '{"extends":["./base.json"]}');
	expect(biomeForegroundSizeArgs(root)).toHaveLength(1);
});
it("honors an explicit environment configuration path", () => {
	writeFileSync(join(root, "selected.json"), '{"files":{"maxSize":256}}');
	vi.stubEnv("BIOME_CONFIG_PATH", "selected.json");
	expect(biomeForegroundSizeArgs(root)).toEqual([]);
});
