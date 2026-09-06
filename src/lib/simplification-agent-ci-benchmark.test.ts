import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSimplificationBenchmarkSuiteReceipt,
	evaluateSimplificationBenchmarkPair,
	parseSimplificationBenchmarkFixture,
	type SimplificationBenchmarkFixture,
	type SimplificationBenchmarkVariantObservation,
} from "./simplification-agent-ci-benchmark.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import { SIMPLIFICATION_REMEDIES } from "./simplification-types.js";

/**
 * `validRawFixture()` builds a minimal, hand-verified fixture that satisfies
 * every parse rule in `parseSimplificationBenchmarkFixture` (schema keys,
 * repo-relative paths, sorted/unique strings, a real sha256 shape). The
 * malformed-input tests below build a fresh fixture and corrupt exactly one
 * field so each test isolates the parse branch it targets.
 */
interface ValidRawFixture {
	schema_version: string;
	fixture_id: string;
	remedy: string;
	contract: Record<string, unknown>;
	variants: {
		overbuilt: Array<Record<string, unknown>>;
		minimal: Array<Record<string, unknown>>;
	};
	expected: Record<string, unknown>;
}

function validRawFixture(): ValidRawFixture {
	return {
		schema_version: "simplification-benchmark-pair/v1",
		fixture_id: "test-fixture",
		remedy: SIMPLIFICATION_REMEDIES[0],
		contract: {
			description: "test description",
			required_behaviors: ["behavior-a", "behavior-b"],
			scorer_sha256: "a".repeat(64),
		},
		variants: {
			overbuilt: [{ path: "a.ts", language: "ts", content: "x" }],
			minimal: [{ path: "a.ts", language: "ts", content: "y" }],
		},
		expected: {
			overbuilt_matching_findings_min: 1,
			minimal_total_findings_max: 0,
			rank_margin_min: 0.1,
			protected_false_positives_max: 0,
		},
	};
}

function loadFixtures(): SimplificationBenchmarkFixture[] {
	const directory = fileURLToPath(
		new URL("./__tests__/fixtures/simplification-positive/", import.meta.url),
	);
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const input: unknown = JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
			const parsed = parseSimplificationBenchmarkFixture(input);
			if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`);
			return parsed.fixture;
		});
}

function observation(
	fixture: SimplificationBenchmarkFixture,
	variant: "overbuilt" | "minimal",
): SimplificationBenchmarkVariantObservation {
	return {
		variant,
		scorer_passed: true,
		checks_passed: true,
		findings: variant === "overbuilt"
			? [{
				fingerprint: `${fixture.fixture_id}-finding`,
				remedy: fixture.remedy,
				score: 0.9,
				protected_behavior: false,
			}]
			: [],
	};
}

describe("simplification positive benchmark pairs", () => {
	const fixtures = loadFixtures();

	it("pins an overbuilt/minimal canary for every remedy", () => {
		expect(buildSimplificationBenchmarkSuiteReceipt(fixtures)).toMatchObject({
			fixture_count: 5,
			remedies_covered: ["delete", "stdlib", "native", "yagni", "shrink"],
			complete_remedy_coverage: true,
			fixture_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("requires recall, minimal restraint, independent checks, and rank separation", () => {
		for (const fixture of fixtures) {
			expect(evaluateSimplificationBenchmarkPair(
				fixture,
				observation(fixture, "overbuilt"),
				observation(fixture, "minimal"),
			), fixture.fixture_id).toEqual({ passed: true, failures: [] });
		}
	});

	it("fails an unsafe or indistinguishable specialist result", () => {
		const fixture = fixtures[0]!;
		const overbuilt = observation(fixture, "overbuilt");
		const minimal = observation(fixture, "minimal");
		overbuilt.findings[0]!.protected_behavior = true;
		minimal.findings = [{ ...overbuilt.findings[0]!, score: 0.9 }];
		expect(evaluateSimplificationBenchmarkPair(fixture, overbuilt, minimal)).toMatchObject({
			passed: false,
			failures: expect.arrayContaining([
				"minimal_variant_overcalled",
				"overbuilt_rank_margin_not_met",
				"protected_behavior_false_positive",
			]),
		});
	});

	it("flags an overbuilt observation mislabeled as minimal", () => {
		const fixture = fixtures[0]!;
		const overbuilt = observation(fixture, "overbuilt");
		overbuilt.variant = "minimal";
		const minimal = observation(fixture, "minimal");
		const result = evaluateSimplificationBenchmarkPair(fixture, overbuilt, minimal);
		expect(result.failures).toContain("variant_labels_mismatch");
	});

	it("flags an overbuilt variant that misses the true-positive recall floor", () => {
		const fixture = fixtures[0]!;
		const overbuilt = observation(fixture, "overbuilt");
		overbuilt.findings = [];
		const minimal = observation(fixture, "minimal");
		const result = evaluateSimplificationBenchmarkPair(fixture, overbuilt, minimal);
		expect(result.failures).toContain("overbuilt_true_positive_missing");
	});

	it("orders a receipt's fixtures stably when two fixture ids tie", () => {
		const duplicate: SimplificationBenchmarkFixture = {
			...fixtures[0]!,
			remedy: fixtures[1]!.remedy,
		};
		const receipt = buildSimplificationBenchmarkSuiteReceipt([fixtures[0]!, duplicate]);
		// A stable (non-swapping) comparator leaves the input order [fixtures[0], duplicate]
		// untouched; the sha256 is the only observable that reveals order, since
		// fixture_count is order-invariant and remedies_covered/complete_remedy_coverage
		// derive from a Set. Compute the expected digest over the un-swapped input order
		// directly, so a comparator that swaps the tied pair (e.g. `return -1`) fails this.
		expect(receipt.fixture_sha256).toBe(
			createHash("sha256")
				.update(canonicalSimplificationAgentCiJson([fixtures[0]!, duplicate]), "utf8")
				.digest("hex"),
		);
	});
});

describe("parseSimplificationBenchmarkFixture malformed input", () => {
	it("rejects a fixture missing a required top-level field", () => {
		const { expected: _expected, ...rest } = validRawFixture();
		const result = parseSimplificationBenchmarkFixture(rest);
		expect(result).toEqual({
			ok: false,
			reason: "benchmark fixture has an unknown or missing field",
		});
	});

	it("rejects a fixture whose remedy is not a known remedy", () => {
		const raw = { ...validRawFixture(), remedy: "not-a-real-remedy" };
		const result = parseSimplificationBenchmarkFixture(raw);
		expect(result).toEqual({
			ok: false,
			reason: "benchmark fixture identity or variants are invalid",
		});
	});

	it("rejects a contract carrying an unknown key, and accepts that contract without it", () => {
		const raw = validRawFixture();
		// Both inputs below carry every required contract field with a VALID value, so
		// the exact-key guard is the only check that can tell them apart. A contract
		// that merely OMITS a field is rejected identically by the field checks that
		// follow, which is why the extra-key/no-extra-key pair is the discriminating one.
		expect(parseSimplificationBenchmarkFixture({
			...raw,
			contract: { ...raw.contract, unexpected_key: "surplus" },
		})).toEqual({
			ok: false,
			reason: "benchmark fixture contract, files, or expectations are invalid",
		});
		expect(parseSimplificationBenchmarkFixture(raw)).toMatchObject({
			ok: true,
			fixture: {
				contract: {
					description: "test description",
					required_behaviors: ["behavior-a", "behavior-b"],
					scorer_sha256: "a".repeat(64),
				},
			},
		});
	});

	it("rejects a contract whose scorer_sha256 is not a 64-hex-char digest", () => {
		const raw = validRawFixture();
		const result = parseSimplificationBenchmarkFixture({
			...raw,
			contract: { ...raw.contract, scorer_sha256: "not-a-valid-hash" },
		});
		expect(result).toEqual({
			ok: false,
			reason: "benchmark fixture contract, files, or expectations are invalid",
		});
	});

	it("rejects a variant file entry with an absolute path", () => {
		const raw = validRawFixture();
		const result = parseSimplificationBenchmarkFixture({
			...raw,
			variants: {
				overbuilt: [{ path: "/abs/path.ts", language: "ts", content: "x" }],
				minimal: raw.variants.minimal,
			},
		});
		expect(result).toEqual({
			ok: false,
			reason: "benchmark fixture contract, files, or expectations are invalid",
		});
	});

	it("rejects expected thresholds carrying an unknown key, and accepts them without it", () => {
		const raw = validRawFixture();
		// Same discrimination as the contract pair: all four thresholds hold valid
		// values in both inputs, so only the exact-key guard can reject the first one.
		expect(parseSimplificationBenchmarkFixture({
			...raw,
			expected: { ...raw.expected, unexpected_key: 7 },
		})).toEqual({
			ok: false,
			reason: "benchmark fixture contract, files, or expectations are invalid",
		});
		expect(parseSimplificationBenchmarkFixture(raw)).toMatchObject({
			ok: true,
			fixture: {
				expected: {
					overbuilt_matching_findings_min: 1,
					minimal_total_findings_max: 0,
					rank_margin_min: 0.1,
					protected_false_positives_max: 0,
				},
			},
		});
	});

	it("rejects expected thresholds below the minimum true-positive requirement", () => {
		const raw = validRawFixture();
		const result = parseSimplificationBenchmarkFixture({
			...raw,
			expected: { ...raw.expected, overbuilt_matching_findings_min: 0 },
		});
		expect(result).toEqual({
			ok: false,
			reason: "benchmark fixture contract, files, or expectations are invalid",
		});
	});
});
