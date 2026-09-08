// Tests for the embedded semgrep starter rule pack and its materializer.
// The pack ships as a JS object (JSON is valid YAML, so semgrep loads it and
// we get native validation); the materializer writes it to a memoized temp
// file referenced via `--config`. semgrep itself need not be installed.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	INTERLINKED_SEMGREP_RULES,
	interlinkedSemgrepConfigArgs,
	interlinkedSemgrepConfigPath,
} from "./semgrep-rules.js";

describe("INTERLINKED_SEMGREP_RULES pack", () => {
	it("is a non-empty rules array", () => {
		expect(Array.isArray(INTERLINKED_SEMGREP_RULES.rules)).toBe(true);
		expect(INTERLINKED_SEMGREP_RULES.rules.length).toBeGreaterThan(0);
	});

	it("every rule has id/languages/severity/message/patterns", () => {
		for (const r of INTERLINKED_SEMGREP_RULES.rules) {
			expect(typeof r.id).toBe("string");
			expect(r.languages.length).toBeGreaterThan(0);
			expect(["ERROR", "WARNING", "INFO"]).toContain(r.severity);
			expect(r.message.length).toBeGreaterThan(0);
			expect(r.patterns.length).toBeGreaterThan(0);
		}
	});

	it("rule ids are unique and interlinked-namespaced", () => {
		const ids = INTERLINKED_SEMGREP_RULES.rules.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id.startsWith("interlinked-")).toBe(true);
	});

	it("serializes to JSON that round-trips (valid YAML for semgrep)", () => {
		const json = JSON.stringify(INTERLINKED_SEMGREP_RULES);
		expect(JSON.parse(json)).toEqual(INTERLINKED_SEMGREP_RULES);
	});
});

describe("interlinkedSemgrepConfigPath", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "semgrep-pack-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the pack and returns a path whose content round-trips", () => {
		const p = interlinkedSemgrepConfigPath(dir);
		expect(p).not.toBeNull();
		if (p === null) throw new Error("Expected a generated Semgrep config path");
		expect(existsSync(p)).toBe(true);
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(INTERLINKED_SEMGREP_RULES);
	});

	it("is idempotent — second call returns the same path without rewriting", () => {
		const a = interlinkedSemgrepConfigPath(dir);
		const b = interlinkedSemgrepConfigPath(dir);
		expect(a).toBe(b);
	});

	it("returns null when the base dir cannot be created", () => {
		const filePath = join(dir, "afile");
		writeFileSync(filePath, "x");
		// A base dir nested under a regular file → mkdirSync fails (ENOTDIR).
		expect(interlinkedSemgrepConfigPath(join(filePath, "sub"))).toBeNull();
	});
});

describe("interlinkedSemgrepConfigArgs", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "semgrep-args-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns ['--config', path] when the pack materializes", () => {
		const args = interlinkedSemgrepConfigArgs(dir);
		expect(args[0]).toBe("--config");
		expect(args[1]).toMatch(/rules-[0-9a-f]+\.yml$/);
	});

	it("returns [] when the pack cannot be written", () => {
		const filePath = join(dir, "afile");
		writeFileSync(filePath, "x");
		expect(interlinkedSemgrepConfigArgs(join(filePath, "sub"))).toEqual([]);
	});
});
