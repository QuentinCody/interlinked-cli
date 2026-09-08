import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProposedFiles } from "../../checks/proposed-files.js";
import { inspectBiomeOverlayConfig } from "./biome-overlay-config.js";

describe("Biome sibling overlay configuration", () => {
	let root: string;
	let target: string;
	beforeEach(() => {
		vi.stubEnv("BIOME_CONFIG_PATH", undefined);
		root = mkdtempSync(join(tmpdir(), "biome-overlay-config-"));
		mkdirSync(join(root, "src"));
		target = join(root, "src", "index.ts");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts directory and extension selectors, including negative subtree patterns", () => {
		writeFileSync(join(root, "biome.json"), JSON.stringify({
			files: { includes: ["**/*.ts", "**/*.tsx", "!scratch/**", "!**/.stryker-tmp/**", "!.interlinked/quarantine-*/**"] },
			overrides: [{ includes: ["src/**"], linter: { rules: { suspicious: { noDoubleEquals: "error" } } } }],
		}));
		expect(inspectBiomeOverlayConfig(target)).toEqual({ status: "ok" });
	});

	it("reads JSONC comments and trailing commas without corrupting glob strings", () => {
		writeFileSync(join(root, "biome.jsonc"), '{ /* local */ "files": { "includes": ["**/*.ts",], }, }');
		expect(inspectBiomeOverlayConfig(target)).toEqual({ status: "ok" });
	});

	it.each(["**/index.ts", "**/*.test.ts", "!**/*.spec.ts", "**/*.{ts,tsx}"])("defers a filename selector it cannot prove invariant: %s", (pattern) => {
		writeFileSync(join(root, "biome.json"), JSON.stringify({ overrides: [{ includes: [pattern] }] }));
		expect(inspectBiomeOverlayConfig(target)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("may depend on the filename") });
	});

	it.each([
		{ extends: ["./base.json"] },
		{ root: false },
		{ plugins: ["./plugin.grit"] },
		{ vcs: { enabled: true, useIgnoreFile: true } },
		{ linter: { rules: { style: { useFilenamingConvention: "error" } } } },
		{ linter: { rules: { suspicious: { noImportCycles: "error" } } } },
		{ linter: { rules: { all: true } } },
	])("defers configuration requiring the original file identity: %j", (config) => {
		writeFileSync(join(root, "biome.json"), JSON.stringify(config));
		expect(inspectBiomeOverlayConfig(target)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Biome overlay unavailable") });
	});

	it("allows disabled identity-dependent settings", () => {
		writeFileSync(join(root, "biome.json"), JSON.stringify({
			extends: [], plugins: [], vcs: { enabled: true, useIgnoreFile: false },
			linter: { rules: { style: { useFilenamingConvention: { level: "off" } }, suspicious: { noImportCycles: "off" } } },
		}));
		expect(inspectBiomeOverlayConfig(target)).toEqual({ status: "ok" });
	});

	it("does not overlook an inherited nested override", () => {
		writeFileSync(join(root, "biome.json"), "{}");
		writeFileSync(join(root, "src", "biome.json"), '{"root":false}');
		expect(inspectBiomeOverlayConfig(target)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("inherited configuration") });
	});

	it.each(["{", "[]"])("does not turn an invalid configuration into a clean verdict: %s", (content) => {
		writeFileSync(join(root, "biome.json"), content);
		expect(inspectBiomeOverlayConfig(target)).toMatchObject({ status: "unavailable" });
	});

	it("skips an unconfigured target", () => {
		expect(inspectBiomeOverlayConfig(target)).toEqual({ status: "skipped", reason: "no Biome configuration" });
	});

	it("does not inspect a different configuration from BIOME_CONFIG_PATH", () => {
		writeFileSync(join(root, "biome.json"), "{}");
		vi.stubEnv("BIOME_CONFIG_PATH", join(root, "custom-config"));
		expect(inspectBiomeOverlayConfig(target)).toEqual({
			status: "unavailable", reason: expect.stringContaining("BIOME_CONFIG_PATH"),
		});
	});

	it.each([
		{ disk: null, proposed: "{}" },
		{ disk: "{}", proposed: '{"linter":{"enabled":false}}' },
		{ disk: "{}", proposed: null },
	])("defers a created, rewritten or deleted config in the same proposal: %j", ({ disk, proposed }) => {
		const path = join(root, "biome.json");
		if (disk !== null) writeFileSync(path, disk);
		const outcome = withProposedFiles(new Map([[path, proposed]]), () => inspectBiomeOverlayConfig(target));
		expect(outcome).toEqual({ status: "unavailable", reason: expect.stringContaining("changed by this proposal") });
	});

	it("still measures when a submitted configuration has unchanged bytes", () => {
		const path = join(root, "biome.json");
		writeFileSync(path, "{}");
		expect(withProposedFiles(new Map([[path, "{}"]]), () => inspectBiomeOverlayConfig(target))).toEqual({ status: "ok" });
	});
});
