import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCausalEvidence } from "./impact-evidence-causal.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "impact-causal-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("readCausalEvidence", () => {
	it("reports not-recorded when no manifest is supplied", () => {
		const causal = readCausalEvidence(cwd, undefined);
		expect(causal.evidence_class).toBe("causal");
		expect(causal.available).toBe(false);
		expect(causal.availability).toBe("not-recorded");
		expect(causal.manifest_path).toBeNull();
		expect(causal.note).toBe("No controlled-experiment manifest was supplied.");
		expect(causal.artifacts_verified).toBe(false);
	});

	it("throws for an explicitly supplied unreadable manifest", () => {
		expect(() => readCausalEvidence(cwd, "missing.json")).toThrow(
			/Explicit experiment manifest is unreadable/,
		);
	});

	it("reports unavailable for a manifest that is not valid JSON", () => {
		writeFileSync(join(cwd, "bad.json"), "{not json", "utf8");
		const causal = readCausalEvidence(cwd, "bad.json");
		expect(causal.availability).toBe("unavailable");
		expect(causal.manifest_path).toBe(join(cwd, "bad.json"));
		expect(causal.note).toMatch(/^Experiment manifest is not valid JSON: /);
	});

	it("reports unavailable for a schema-invalid manifest", () => {
		writeFileSync(join(cwd, "wrong.json"), JSON.stringify({ schema_version: 1 }), "utf8");
		const causal = readCausalEvidence(cwd, "wrong.json");
		expect(causal.availability).toBe("unavailable");
		expect(causal.note).toMatch(/^Experiment manifest rejected: /);
		expect(causal.experiment_id).toBeNull();
	});

	it("resolves an absolute manifest path without joining the cwd", () => {
		const absolute = join(cwd, "abs.json");
		writeFileSync(absolute, "[]", "utf8");
		const causal = readCausalEvidence(cwd, absolute);
		expect(causal.manifest_path).toBe(absolute);
		expect(causal.availability).toBe("unavailable");
	});
});
