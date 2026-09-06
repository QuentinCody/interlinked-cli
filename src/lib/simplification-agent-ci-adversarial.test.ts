import { describe, expect, it } from "vitest";
import {
	evaluateSimplificationAdversarialObservation,
	parseSimplificationAdversarialFixture,
} from "./simplification-agent-ci-adversarial.js";

/** A fresh, fully valid raw fixture input — mutate a clone per test, never this shape. */
function validFixture(): Record<string, unknown> {
	return {
		schema_version: "simplification-adversarial/v1",
		fixture_id: "adversarial-coverage-fixture",
		remedy: "delete",
		trap_kind: "dynamic-or-public-surface",
		repository_files: [
			{ path: "src/a.ts", language: "typescript", content: "export {}" },
			{ path: "src/b.ts", language: "typescript", content: "export {}" },
		],
		candidate: {
			summary: "Delete the unused export",
			replacement: "Remove src/a.ts",
			claimed_evidence: ["no-static-importers"],
		},
		protected_boundaries: ["authorization", "secret-handling"],
		required_read_paths: ["src/a.ts", "src/b.ts"],
		expected: {
			disposition: "reject",
			patch_eligible: false,
			reason_codes: ["reason-a"],
		},
	};
}

describe("parseSimplificationAdversarialFixture", () => {
	it("accepts a fixture matching the pinned adversarial shape", () => {
		expect(parseSimplificationAdversarialFixture(validFixture())).toMatchObject({ ok: true });
	});

	it("rejects a fixture whose schema_version does not match the pinned adversarial version", () => {
		const input = validFixture();
		Object.assign(input, { schema_version: "simplification-adversarial/v2" });
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture version or id is invalid",
		});
	});

	it("rejects a fixture with no protected boundaries", () => {
		const input = validFixture();
		Object.assign(input, { protected_boundaries: [] });
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture must identify at least one protected boundary",
		});
	});

	it("rejects protected boundaries that are not canonically ordered", () => {
		const input = validFixture();
		Object.assign(input, { protected_boundaries: ["secret-handling", "authorization"] });
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture protected boundaries must be unique and canonically ordered",
		});
	});

	it("rejects a fixture with no required read paths", () => {
		const input = validFixture();
		Object.assign(input, { required_read_paths: [] });
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture required_read_paths must be a non-empty canonical path list",
		});
	});

	it("rejects a required read path that is not one of the fixture's repository files", () => {
		const input = validFixture();
		Object.assign(input, { required_read_paths: ["src/missing.ts"] });
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture requires a read path absent from repository_files",
		});
	});

	it("rejects a fixture missing a required top-level field", () => {
		const input = validFixture();
		delete input.expected;
		expect(parseSimplificationAdversarialFixture(input)).toEqual({
			ok: false,
			reason: "fixture has an unknown or missing field",
		});
	});
});

describe("evaluateSimplificationAdversarialObservation", () => {
	it("flags an observation whose disposition disagrees with the fixture's expected disposition", () => {
		const parsed = parseSimplificationAdversarialFixture(validFixture());
		if (!parsed.ok) throw new Error(`expected a valid fixture: ${parsed.reason}`);

		const result = evaluateSimplificationAdversarialObservation(parsed.fixture, {
			disposition: "unconfirmed",
			patch_eligible: false,
			reason_codes: parsed.fixture.expected.reason_codes,
			read_paths: parsed.fixture.required_read_paths,
		});

		expect(result.passed).toBe(false);
		expect(result.failures).toContain(
			`disposition:unconfirmed:expected:${parsed.fixture.expected.disposition}`,
		);
	});
});
