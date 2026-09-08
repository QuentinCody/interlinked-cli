import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireString } from "../../lib/value-validation.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GENERIC_CHECK_META,
	QUALITY_CHECK_META,
	STRUCTURAL_CHECK_META,
	SUGGESTION_CHECK_META,
} from "../check-metadata.js";
import { getBuiltinRules, getDefaultConfig } from "../rules-loader.js";
import { ALL_SEQUENCE_DETECTORS } from "../sequence-checks/registry.js";

const DOCS_DIR = join(import.meta.dirname, "..", "..", "..", "docs", "generated");

describe("docs freshness", () => {
	it("generated docs directory exists", () => {
		expect(existsSync(DOCS_DIR)).toBe(true);
	});

	it("guard-rules.md matches current BUILTIN_RULES count", () => {
		const path = join(DOCS_DIR, "guard-rules.md");
		if (!existsSync(path)) return; // skip if docs not generated yet
		const content = readFileSync(path, "utf-8");
		const rules = getBuiltinRules();
		expect(content).toContain(`${rules.length} built-in rules`);
	});

	it("every guard rule has a category", () => {
		const rules = getBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		const missing = rules.filter((r) => !(parseWire(r, wireObject({ "category": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value")).category);
		expect(missing.map((r) => r.id)).toEqual([]);
	});

	it("quality-checks.md matches current quality check count", () => {
		const path = join(DOCS_DIR, "quality-checks.md");
		if (!existsSync(path)) return;
		const content = readFileSync(path, "utf-8");
		const config = getDefaultConfig();
		const checkCount = Object.keys(config.quality_checks).length;
		expect(content).toContain(`${checkCount} PostToolUse checks`);
	});

	it("every quality check has a description", () => {
		const config = getDefaultConfig();
		for (const [name, check] of Object.entries(config.quality_checks)) {
			expect(
				check.description,
				`Quality check ${name} is missing a description`,
			).toBeTruthy();
		}
	});

	it("structural-checks.md matches STRUCTURAL_CHECK_META count", () => {
		const path = join(DOCS_DIR, "structural-checks.md");
		if (!existsSync(path)) return;
		const content = readFileSync(path, "utf-8");
		const count = Object.keys(STRUCTURAL_CHECK_META).length;
		expect(content).toContain(`${count} dependency-aware checks`);
	});

	it("cli-reference.md exists and contains structure commands", () => {
		const path = join(DOCS_DIR, "cli-reference.md");
		if (!existsSync(path)) return;
		const content = readFileSync(path, "utf-8");
		expect(content).toContain("## Structure");
		expect(content).toContain("### structure init");
		expect(content).toContain("### structure scan");
		expect(content).toContain("### structure status");
		expect(content).toContain("### structure accept");
		expect(content).toContain("### structure doctor");
		expect(content).toContain("### structure baseline");
		expect(content).toContain("--structure-only");
		expect(content).toContain("--adoption-gate");
	});

	it("every structural check config key has metadata", () => {
		const config = getDefaultConfig();
		const sc = config.structural_checks;
		// Keys that are config settings, not individual checks
		const skipKeys = new Set([
			"enabled",
			"staleness_window_s",
			"blast_radius_threshold",
			"completion_reminder_threshold",
			"impact_high_threshold",
			"layer_rules",
		]);
		for (const [key, value] of Object.entries(sc)) {
			if (typeof value !== "boolean") continue; // skip thresholds
			if (skipKeys.has(key)) continue;
			expect(
				STRUCTURAL_CHECK_META[key],
				`Structural check '${key}' is missing from STRUCTURAL_CHECK_META in check-metadata.ts`,
			).toBeTruthy();
		}
	});

	it("STRUCTURAL_CHECK_META keys match structural config boolean keys", () => {
		const config = getDefaultConfig();
		const sc = config.structural_checks;
		const skipKeys = new Set([
			"enabled",
			"staleness_window_s",
			"blast_radius_threshold",
			"completion_reminder_threshold",
			"impact_high_threshold",
			"layer_rules",
		]);
		const configKeys = Object.entries(sc)
			.filter(([k, v]) => typeof v === "boolean" && !skipKeys.has(k))
			.map(([k]) => k)
			.sort();
		const metaKeys = Object.keys(STRUCTURAL_CHECK_META).sort();
		expect(configKeys).toEqual(metaKeys);
	});

	it("QUALITY_CHECK_META keys match DEFAULT_CONFIG.quality_checks keys", () => {
		const config = getDefaultConfig();
		const configKeys = Object.keys(config.quality_checks).sort();
		const metaKeys = Object.keys(QUALITY_CHECK_META).sort();
		expect(configKeys).toEqual(metaKeys);
	});

	it("all guard rule IDs are unique", () => {
		const rules = getBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		const ids = rules.map((r) => r.id);
		const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
		expect(dups, `Duplicate guard rule IDs: ${dups.join(", ")}`).toEqual([]);
	});

	it("sequence-detectors.md exists", () => {
		const path = join(DOCS_DIR, "sequence-detectors.md");
		expect(existsSync(path)).toBe(true);
	});

	it("sequence-detectors.md matches current ALL_SEQUENCE_DETECTORS count", () => {
		const path = join(DOCS_DIR, "sequence-detectors.md");
		if (!existsSync(path)) return;
		const content = readFileSync(path, "utf-8");
		expect(content).toContain(
			`${ALL_SEQUENCE_DETECTORS.length} sequence detectors registered`,
		);
	});

	it("every sequence detector id appears in sequence-detectors.md", () => {
		const path = join(DOCS_DIR, "sequence-detectors.md");
		if (!existsSync(path)) return;
		expect(ALL_SEQUENCE_DETECTORS.length).toBeGreaterThan(0);
		const content = readFileSync(path, "utf-8");
		const missing = ALL_SEQUENCE_DETECTORS.filter(
			(d) => !content.includes(`\`${d.id}\``),
		);
		expect(
			missing.map((d) => d.id),
			`Sequence detectors missing from docs/generated/sequence-detectors.md: ${missing.map((d) => d.id).join(", ")}`,
		).toEqual([]);
	});

	it("every sequence detector has a non-empty description", () => {
		for (const detector of ALL_SEQUENCE_DETECTORS) {
			expect(
				detector.description,
				`Sequence detector ${detector.id} is missing a description`,
			).toBeTruthy();
		}
	});

	it("every determinism value in metadata registries is valid", () => {
		const valid = new Set(["fully_deterministic", "partially_deterministic", "heuristic"]);
		for (const [name, meta] of Object.entries(STRUCTURAL_CHECK_META)) {
			expect(
				valid.has(meta.determinism),
				`Invalid determinism for structural check ${name}: ${meta.determinism}`,
			).toBe(true);
		}
		for (const [name, meta] of Object.entries(QUALITY_CHECK_META)) {
			expect(
				valid.has(meta.determinism),
				`Invalid determinism for quality check ${name}: ${meta.determinism}`,
			).toBe(true);
		}
		for (const [name, meta] of Object.entries(GENERIC_CHECK_META)) {
			expect(
				valid.has(meta.determinism),
				`Invalid determinism for generic check ${name}: ${meta.determinism}`,
			).toBe(true);
		}
		for (const [name, meta] of Object.entries(SUGGESTION_CHECK_META)) {
			expect(
				valid.has(meta.determinism),
				`Invalid determinism for suggestion check ${name}: ${meta.determinism}`,
			).toBe(true);
		}
	});
});
