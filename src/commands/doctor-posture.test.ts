// Companion for doctor-posture.ts — the composed tier/loader pins live in
// mode-posture.test.ts; these cover the check's own file handling.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postureEnumChecks } from "./doctor-posture.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "il-doctor-posture-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("postureEnumChecks", () => {
	// test-contract: public-api — an invalid RAW team value is a finding
	// naming the file, field, and JSON-rendered value.
	it("P1: reports an invalid team enum with file/field/value", () => {
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.json"),
			JSON.stringify({ structural_checks: { test_first_mode: "typo" } }),
		);
		const rows = postureEnumChecks(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.message).toContain("guard-rules.json");
		expect(rows[0]?.message).toContain('test_first_mode = "typo"');
	});

	// test-contract: boundary — absent files and malformed JSON are not this
	// check's findings (malformed files surface elsewhere).
	it("N1: absent files and malformed JSON yield no rows", () => {
		expect(postureEnumChecks(cwd)).toEqual([]);
		writeFileSync(join(cwd, ".interlinked", "guard-rules.json"), "{ nope");
		expect(postureEnumChecks(cwd)).toEqual([]);
	});

	it.each(["null", "[]", '"not a configuration"'])("leaves non-object configuration %s to the configuration-shape check", content => {
		writeFileSync(join(cwd, ".interlinked", "guard-rules.json"), content);
		expect(postureEnumChecks(cwd)).toEqual([]);
	});
});
