import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getImplicitConfig, loadArtifactFile, loadStructureConfig } from "./structure-loader.js";

describe("loadStructureConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "struct-load-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns implicit=true when no structure.json exists", () => {
		const r = loadStructureConfig(tmp);
		expect(r.implicit).toBe(true);
		expect(r.config).toBeNull();
		expect(r.errors).toEqual([]);
	});

	it("returns errors for malformed JSON", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(join(tmp, "interlinked", "structure.json"), "{not json");
		const r = loadStructureConfig(tmp);
		expect(r.config).toBeNull();
		expect(r.errors.length).toBeGreaterThan(0);
	});

	it("loads a valid structure.json", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "structure.json"),
			JSON.stringify({ version: 1, mode: "minimal", artifacts: {} }),
		);
		const r = loadStructureConfig(tmp);
		expect(r.config?.mode).toBe("minimal");
		expect(r.implicit).toBe(false);
	});

	it("returns schema errors for unknown top-level keys", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "structure.json"),
			JSON.stringify({ version: 1, mode: "minimal", bogus: true }),
		);
		const r = loadStructureConfig(tmp);
		expect(r.config).toBeNull();
		expect(r.errors.some((e) => /Unknown/.test(e))).toBe(true);
	});

	it("reports a read failure when structure.json is unreadable (a directory, not a file)", () => {
		// existsSync() is true for a directory, so the code proceeds past the
		// "no structure.json" branch straight into readFileSync, which throws
		// EISDIR — exercising the read-failure catch, not the parse-failure path.
		const structurePath = join(tmp, "interlinked", "structure.json");
		mkdirSync(structurePath, { recursive: true });
		const r = loadStructureConfig(tmp);
		expect(r.config).toBeNull();
		expect(r.implicit).toBe(false);
		expect(r.errors).toEqual([`Failed to read ${structurePath}`]);
	});

	it("reports missing declared artifact files without failing the whole load", () => {
		// Valid, parseable structure.json that declares an artifact file which
		// does not exist on disk — exercises validateDeclaredPaths' path-error
		// callback (the `env` artifact key is never otherwise validated here).
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "structure.json"),
			JSON.stringify({ version: 1, mode: "minimal", artifacts: { env: "env.json" } }),
		);
		const r = loadStructureConfig(tmp);
		expect(r.implicit).toBe(false);
		expect(r.config?.artifacts.env).toBe("env.json");
		expect(r.errors).toEqual(["$.artifacts.env: File not found: interlinked/env.json"]);
	});
});

describe("getImplicitConfig", () => {
	it("returns a minimal mode config by default", () => {
		const c = getImplicitConfig();
		expect(c.mode).toBe("minimal");
		expect(c.version).toBe(1);
	});
});

describe("loadArtifactFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "struct-art-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports `File not found` when missing", () => {
		const r = loadArtifactFile(tmp, "public_api", "public-api.json");
		expect(r.data).toBeNull();
		expect(r.errors[0]).toMatch(/File not found/);
	});

	it("returns parsed data for a valid env file", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "env.json"),
			JSON.stringify({ version: 1, keys: [] }),
		);
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.errors).toEqual([]);
		expect(r.data).toBeTruthy();
	});

	it("reports JSON parse errors", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(join(tmp, "interlinked", "env.json"), "{broken");
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.data).toBeNull();
		expect(r.errors.length).toBeGreaterThan(0);
	});

	it("reports a read failure when the artifact path is unreadable (a directory, not a file)", () => {
		// existsSync() is true for a directory, so the code proceeds past the
		// "file not found" branch straight into readFileSync, which throws
		// EISDIR — the read-failure catch, not the JSON-parse-failure path.
		mkdirSync(join(tmp, "interlinked", "env.json"), { recursive: true });
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.data).toBeNull();
		expect(r.errors).toEqual(["Failed to read interlinked/env.json"]);
	});

	it("reports schema validation errors for a parseable but invalid artifact file", () => {
		// Valid JSON, but `version` must be exactly 1 per validateEnvFile —
		// exercises the validation-failure branch distinct from parse failure.
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "env.json"),
			JSON.stringify({ version: 2, keys: [] }),
		);
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.data).toBeNull();
		expect(r.errors).toEqual(["$.version: Must be 1"]);
	});
});
