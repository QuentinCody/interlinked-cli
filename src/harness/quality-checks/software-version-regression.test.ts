import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { formatQualityWarnings, runQualityChecks } from "../quality-checks.js";
import type { QualityCheckConfig } from "../types.js";
import {
	anchorFamilyOf,
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
	type SoftwareVersionFreshnessConcern,
	type SoftwareVersionReference,
	type SoftwareVersionRegression,
} from "./software-version-regression.js";

const SOFTWARE_VERSION_CHECKS: Record<string, QualityCheckConfig> = {
	software_version_regression: {
		enabled: true,
		file_types: ["package.json", ".ts", ".yaml", "Dockerfile"],
		timeout_ms: 1_000,
		severity: "error",
	},
	freshness_sensitive_reference: {
		enabled: true,
		file_types: ["package.json", ".ts", ".yaml", "Dockerfile"],
		timeout_ms: 1_000,
		severity: "warning",
	},
};

describe("software version regression detector", () => {
	it("ignores non-string dependency entries without dropping valid version references", () => {
		const refs = collectSoftwareVersionReferences(JSON.stringify({ dependencies: {
			invalid: 42, valid: "2.3.4",
		} }), "package.json");
		expect(refs.map(ref => ({ label: ref.label, version: ref.version }))).toEqual([
			{ label: "dependencies valid", version: "2.3.4" },
		]);
	});
	it("detects package dependency downgrades in package.json", () => {
		const before = collectSoftwareVersionReferences(
			JSON.stringify({ dependencies: { react: "^19.0.0" } }, null, 2),
			"package.json",
		);
		const after = collectSoftwareVersionReferences(
			JSON.stringify({ dependencies: { react: "^18.2.0" } }, null, 2),
			"package.json",
		);

		const regressions = detectSoftwareVersionRegressions(before, after);

		expect(regressions).toHaveLength(1);
		expect(nonNull(regressions[0]).after.label).toBe("dependencies react");
		expect(nonNull(regressions[0]).before.version).toBe("^19.0.0");
		expect(nonNull(regressions[0]).after.version).toBe("^18.2.0");
	});

	it("detects model-name downgrades in code assignments", () => {
		const before = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v6";\n',
			"src/models.ts",
		);
		const after = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v4";\n',
			"src/models.ts",
		);

		const regressions = detectSoftwareVersionRegressions(before, after);

		expect(regressions).toHaveLength(1);
		expect(nonNull(regressions[0]).after.label).toBe("model");
		expect(nonNull(regressions[0]).before.version).toBe("vendor-model-v6");
		expect(nonNull(regressions[0]).after.version).toBe("vendor-model-v4");
	});

	it("detects GitHub Action and Docker tag downgrades", () => {
		const before = collectSoftwareVersionReferences(
			["uses: actions/setup-node@v6", "FROM node:22-alpine"].join("\n"),
			".github/workflows/ci.yml",
		);
		const after = collectSoftwareVersionReferences(
			["uses: actions/setup-node@v4", "FROM node:20-alpine"].join("\n"),
			".github/workflows/ci.yml",
		);

		const labels = detectSoftwareVersionRegressions(before, after).map((r) => r.after.label);

		expect(labels).toEqual(["GitHub Action actions/setup-node", "Docker image node"]);
	});

	it("does not flag upgrades or model provider changes", () => {
		const before = collectSoftwareVersionReferences(
			['export const model = "vendor-model-v4";', 'export const sdkVersion = "4.1.0";'].join("\n"),
			"src/config.ts",
		);
		const after = collectSoftwareVersionReferences(
			['export const model = "other-model-v4";', 'export const sdkVersion = "5.0.0";'].join("\n"),
			"src/config.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	// A model-catalog module lists many same-family entries at different
	// versions. Every sibling collapses into one anchor (array indices are not
	// tracked, and a model's "family" is its leading name token), so the
	// detector used to compare each entry against whichever sibling was listed
	// first and flag every lower-versioned one as a downgrade — even when the
	// catalog was byte-identical and only an unrelated line changed. Synthetic
	// names per the fixture policy: the anchor collision is the behavior under
	// test, not any real product name.
	const catalogOf = (...versions: string[]): string =>
		[
			"export const MODELS = [",
			...versions.map((v) => `  { model: "${v}" },`),
			"];",
		].join("\n");

	it("does not flag unchanged catalog entries when a newer sibling is added", () => {
		const before = collectSoftwareVersionReferences(
			catalogOf("vendor-model-v6", "vendor-model-v5", "vendor-model-v4"),
			"src/lib/models.ts",
		);
		const after = collectSoftwareVersionReferences(
			catalogOf("vendor-model-v7", "vendor-model-v6", "vendor-model-v5", "vendor-model-v4"),
			"src/lib/models.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("does not flag adding a lower-versioned sibling while the higher one survives", () => {
		const before = collectSoftwareVersionReferences(catalogOf("vendor-model-v6"), "src/lib/models.ts");
		const after = collectSoftwareVersionReferences(
			catalogOf("vendor-model-v6", "vendor-model-v4"),
			"src/lib/models.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("still flags a genuine downgrade inside a catalog (higher version replaced by a lower one)", () => {
		const before = collectSoftwareVersionReferences(
			catalogOf("vendor-model-v6", "vendor-model-v4"),
			"src/lib/models.ts",
		);
		const after = collectSoftwareVersionReferences(
			catalogOf("vendor-model-v3", "vendor-model-v4"),
			"src/lib/models.ts",
		);

		const downgrade = detectSoftwareVersionRegressions(before, after).find(
			(r) => r.before.version === "vendor-model-v6" && r.after.version === "vendor-model-v3",
		);
		expect(downgrade).toBeDefined();
	});

	it("does not flag unchanged nested versions in a package-lock.json", () => {
		const lockfile = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "1.0.0" },
					"node_modules/zod": { version: "3.22.0" },
				},
			},
			null,
			2,
		);

		const before = collectSoftwareVersionReferences(lockfile, "package-lock.json");
		const after = collectSoftwareVersionReferences(lockfile, "package-lock.json");

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("flags a real downgrade of a nested package-lock.json dependency", () => {
		const beforeContent = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "2.0.0" },
				},
			},
			null,
			2,
		);
		const afterContent = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "1.0.0" },
				},
			},
			null,
			2,
		);

		const before = collectSoftwareVersionReferences(beforeContent, "package-lock.json");
		const after = collectSoftwareVersionReferences(afterContent, "package-lock.json");

		const regressions = detectSoftwareVersionRegressions(before, after);
		const lodashDowngrade = regressions.find(
			(r) => r.before.version === "2.0.0" && r.after.version === "1.0.0",
		);
		expect(lodashDowngrade).toBeDefined();
	});

	// A version-like string that has a fixed value in one location while a
	// DIFFERENT location holds a lower one used to cross-pair whenever both
	// locations collapsed to one anchor (anonymous scopes all pushed a bare
	// "{}"). Deleting/editing the higher-versioned block then read as a
	// downgrade of the surviving one — the registry-metadata.test.ts FP.
	it("does not flag deleting one it()-block while editing a sibling's version fixture (test file)", () => {
		const blockA = [
			'it("uses the pinned metadata", () => {',
			'  expect(meta).toEqual({ version: "4.17.21" });',
			"});",
		].join("\n");
		const blockB = (v: string) =>
			[
				'it("uses the legacy pin", () => {',
				`  expect(meta).toEqual({ version: "${v}" });`,
				"});",
			].join("\n");
		const before = collectSoftwareVersionReferences(
			`${blockA}\n${blockB("1.0.0")}\n`,
			"src/harness/registry-metadata.test.ts",
		);
		const after = collectSoftwareVersionReferences(
			`${blockB("1.0.1")}\n`,
			"src/harness/registry-metadata.test.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("does not flag removing a function whose sibling function pins a different version (src file)", () => {
		const seedDemo = ["function seedDemo() {", '  return { version: "3.0.0" };', "}"].join("\n");
		const seedLegacy = (v: string) =>
			["function seedLegacy() {", `  return { version: "${v}" };`, "}"].join("\n");
		const before = collectSoftwareVersionReferences(
			`${seedDemo}\n${seedLegacy("1.0.0")}\n`,
			"src/lib/seeds.ts",
		);
		const after = collectSoftwareVersionReferences(`${seedLegacy("1.2.0")}\n`, "src/lib/seeds.ts");

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("does not flag an unrelated edit in a test file pinning versions in different it()-blocks", () => {
		const blocks = (unrelated: number) =>
			[
				'it("high", () => {',
				'  run({ sdk_version: "5.0.0" });',
				"});",
				'it("low", () => {',
				'  run({ sdk_version: "2.0.0" });',
				"});",
				`const unrelated = ${unrelated};`,
			].join("\n");
		const before = collectSoftwareVersionReferences(blocks(1), "src/lib/registry.test.ts");
		const after = collectSoftwareVersionReferences(blocks(2), "src/lib/registry.test.ts");

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("does not flag a version that moved to a counter-shifted sibling anchor (family survival)", () => {
		const entry = (v: string) => ["registry.push({", `  version: "${v}",`, "});"].join("\n");
		const before = collectSoftwareVersionReferences(entry("5.0.0"), "src/lib/registry.ts");
		// A lower-versioned sibling inserted ABOVE shifts the survivor from
		// `fn:push` to `fn:push#1`; the 5.0.0 must still count as present.
		const after = collectSoftwareVersionReferences(
			`${entry("2.0.0")}\n${entry("5.0.0")}`,
			"src/lib/registry.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("still flags an in-place model downgrade in a test file (model refs survive the test-file skip)", () => {
		const before = collectSoftwareVersionReferences(
			'const model = "vendor-model-v6";\n',
			"src/lib/models.test.ts",
		);
		const after = collectSoftwareVersionReferences(
			'const model = "vendor-model-v4";\n',
			"src/lib/models.test.ts",
		);

		const regressions = detectSoftwareVersionRegressions(before, after);

		expect(regressions).toHaveLength(1);
		expect(nonNull(regressions[0]).before.version).toBe("vendor-model-v6");
	});

	// Line-proximity backstop: residual anchor collisions (same key twice in
	// ONE scope) sit far apart; a real replacement lands near the old line.
	const refAt = (version: string, line: number): SoftwareVersionReference => ({
		anchor: "generic:version@id:cfg",
		label: "version",
		kind: "generic",
		version,
		line,
		text: `version: "${version}"`,
	});

	it("does not pair same-anchor refs more than 15 lines apart (proximity backstop)", () => {
		const before = [refAt("5.0.0", 3)];
		const after = [refAt("2.0.0", 60)];

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("still pairs same-anchor refs within the proximity window", () => {
		const before = [refAt("5.0.0", 3)];
		const after = [refAt("2.0.0", 5)];

		expect(detectSoftwareVersionRegressions(before, after)).toHaveLength(1);
	});

	it("strips only counter suffixes when grouping anchors into families", () => {
		expect(anchorFamilyOf("generic:version@fn:push#1")).toBe("generic:version@fn:push");
		expect(anchorFamilyOf("generic:version@describe:bug ~1.{}#2")).toBe(
			"generic:version@describe:bug ~1.{}",
		);
		expect(anchorFamilyOf("package:lodash")).toBe("package:lodash");
	});

	it("flags newly introduced freshness-sensitive model refs without claiming they are deprecated", () => {
		const before = collectSoftwareVersionReferences("export const x = 1;\n", "src/config.ts");
		const after = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v4";\n',
			"src/config.ts",
		);

		const concerns = detectSoftwareVersionFreshnessConcerns(before, after);

		expect(concerns).toHaveLength(1);
		expect(nonNull(concerns[0]).ref.version).toBe("vendor-model-v4");
		expect(nonNull(concerns[0]).reason).toContain("verify against provider docs");
		expect(nonNull(concerns[0]).verifyHint.source).toContain("official model provider documentation");
		expect(nonNull(concerns[0]).reason).not.toContain("deprecated");
	});

	it("reads requirement-style pins only from requirements-style files, never from a code assignment", () => {
		// Before the gate, `count = state.count(old)` in a .py file became "Python package count" at version
		// "state.count(old)", and the word `old` raised a legacy-wording freshness concern (two FPs, 2026-10-21).
		const code = "count = state.count(old)\nstate = state.replace(old, new)\n";
		const before = collectSoftwareVersionReferences("", "scratch/e66/timeline.py");
		const after = collectSoftwareVersionReferences(code, "scratch/e66/timeline.py");
		expect(after).toEqual([]);
		expect(detectSoftwareVersionFreshnessConcerns(before, after)).toEqual([]);
		for (const manifest of ["requirements.txt", "requirements-dev.txt", "requirements/base.in", "constraints.txt", "Pipfile"]) {
			expect(collectSoftwareVersionReferences("requests==2.31.0\n", manifest).map((r) => r.anchor)).toEqual(["package:requests"]);
		}
	});
});

describe("freshness model-identifier false positives (CLAUDE.md / .claude paths / rule ids)", () => {
	// Negative cases — none of these embed a real model identifier; the bare
	// substring "claude" must not be classified as an Anthropic model name.
	const negativeCases: Array<{ name: string; content: string }> = [
		{
			name: "CLAUDE.md filename in prose",
			content: 'description: "Distill AGENTS.md, CLAUDE.md and GEMINI.md into rules"\n',
		},
		{
			name: "CLAUDE.local.md filename",
			content: 'home: "home:.claude/CLAUDE.local.md"\n',
		},
		{
			name: ".claude/ path segment",
			content: 'path: ".claude/skills/migrate-to-shoehorn/SKILL.md"\n',
		},
		{
			name: "kebab-case rule id embedding claude",
			content: 'id: "enforce-claude-no-cypress"\n',
		},
		{
			name: "kebab-case rule id enforce-local-claude-md-*",
			content: 'id: "enforce-local-claude-md-test-before-commit"\n',
		},
		{
			name: "prose mentioning CLAUDE.md with a line number",
			content: 'reason: "CLAUDE.md:88 — Always run npm test before committing."\n',
		},
	];

	for (const { name, content } of negativeCases) {
		it(`does not flag ${name} as a model identifier`, () => {
			const before = collectSoftwareVersionReferences("placeholder: 1\n", "skills/enforce/SKILL.md");
			const after = collectSoftwareVersionReferences(content, "skills/enforce/SKILL.md");
			const concerns = detectSoftwareVersionFreshnessConcerns(before, after);
			const modelConcerns = concerns.filter((c) => c.ref.kind === "model");
			expect(modelConcerns).toEqual([]);
		});
	}

	// Positive cases — genuine pinned model identifiers MUST still fire.
	const positiveCases: Array<{ name: string; value: string }> = [
		{ name: "claude-3-opus-20240229", value: "claude-3-opus-20240229" },
		{ name: "claude-3-5-sonnet-20241022", value: "claude-3-5-sonnet-20241022" },
		// REAL_WORLD_VERSION_FIXTURE_OK — the genuine pinned identifier is the behavior under test.
		{ name: "gpt-4-0613", value: "gpt-4-0613" },
		{ name: "o3", value: "o3" }, // REAL_WORLD_VERSION_FIXTURE_OK — exact o-series compact alias is the behavior under test.
		{ name: "o4-mini", value: "o4-mini" }, // REAL_WORLD_VERSION_FIXTURE_OK — exact o-series compact alias is the behavior under test.
		{ name: "openai/o3-mini", value: "openai/o3-mini" }, // REAL_WORLD_VERSION_FIXTURE_OK — namespaced o-series alias is the behavior under test.
	];

	for (const { name, value } of positiveCases) {
		it(`still flags genuine model identifier ${name}`, () => {
			const before = collectSoftwareVersionReferences("export const x = 1;\n", "src/config.ts");
			const after = collectSoftwareVersionReferences(
				`export const llmId = "${value}";\n`,
				"src/config.ts",
			);
			const concerns = detectSoftwareVersionFreshnessConcerns(before, after);
			const modelConcerns = concerns.filter((c) => c.ref.kind === "model");
			expect(modelConcerns.length).toBeGreaterThan(0);
			expect(nonNull(modelConcerns[0]).ref.version).toBe(value);
		});
	}

	it("classifies compact o-series values under software keys as model references", () => {
		const before = collectSoftwareVersionReferences("export const x = 1;\n", "src/config.ts");
		const after = collectSoftwareVersionReferences(
			['export const engine = "o3";', 'export const runtime = "o4-mini";'].join("\n"), // REAL_WORLD_VERSION_FIXTURE_OK — software-key classification of compact o-series IDs is the behavior under test.
			"src/config.ts",
		);
		const concerns = detectSoftwareVersionFreshnessConcerns(before, after);
		expect(concerns.map((c) => c.ref.version)).toEqual(["o3", "o4-mini"]); // REAL_WORLD_VERSION_FIXTURE_OK — exact o-series IDs are asserted intentionally.
		expect(concerns.every((c) => c.ref.kind === "model")).toBe(true);
	});
});

describe("runQualityChecks software_version_regression", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-version-regression-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports a PostToolUse quality result with knowledge-cutoff remediation", async () => {
		const filePath = join(dir, "package.json");
		const beforeContent = JSON.stringify({ dependencies: { "@ai/sdk": "^6.0.0" } }, null, 2);
		const afterContent = JSON.stringify({ dependencies: { "@ai/sdk": "^4.0.0" } }, null, 2);
		writeFileSync(filePath, afterContent);

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "s",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-04T00:00:00.000Z",
			},
			SOFTWARE_VERSION_CHECKS,
			dir,
			{
				baseline: {
					missingReturnTypes: new Set(),
					complexFunctions: new Set(),
					capturedAt: 1_777_852_800_000,
					suppressionCount: 0,
					asAnyCastCount: 0,
					nonNullAssertionCount: 0,
					softwareVersions: collectSoftwareVersionReferences(beforeContent, filePath),
				},
			},
		);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			name: "software_version_regression",
			severity: "error",
			file: filePath,
		});
		expect(nonNull(results[0]).detail).toContain("@ai/sdk ^6.0.0 -> ^4.0.0");

		const [warning] = formatQualityWarnings(results);
		expect(warning).toContain("[interlinked:software_version_regression] [heuristic]");
		expect(warning).toContain("knowledge cutoff date");
		expect(warning).toContain("search/fetch official docs");
		expect(warning).toContain("PostToolUse attention required");
	});

	it("does not re-flag a pre-existing model reference when an earlier insert shifts its line (no baseline)", async () => {
		// Bug 2: an Edit that inserts content earlier in the file shifts the
		// line numbers of an untouched model reference downstream. With no
		// PreToolUse baseline, the check must reconstruct the before-file by
		// reverting the edit (new_string -> old_string) so the unchanged
		// reference is not reported as newly introduced.
		const filePath = join(dir, "config.ts");
		const oldStr = "const a = 1;\n";
		const newStr = "const a = 1;\nconst inserted = 2;\nconst more = 3;\n";
		const afterContent = `${newStr}export const llmId = "claude-3-opus-20240229";\n`;
		writeFileSync(filePath, afterContent);

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "s",
				agent_source: "claude",
				tool_name: "Edit",
				tool_input: { file_path: filePath, old_string: oldStr, new_string: newStr },
				timestamp: "2026-05-04T00:00:00.000Z",
			},
			SOFTWARE_VERSION_CHECKS,
			dir,
		);

		expect(results.find((r) => r.name === "freshness_sensitive_reference")).toBeUndefined();
	});

	it("reports a freshness-sensitive new model reference without hardcoding current models", async () => {
		const filePath = join(dir, "config.ts");
		writeFileSync(filePath, 'export const model = "vendor-model-v4";\n');

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "s",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-04T00:00:00.000Z",
			},
			SOFTWARE_VERSION_CHECKS,
			dir,
		);

		expect(results.find((r) => r.name === "software_version_regression")).toBeUndefined();
		const freshnessResult = results.find((r) => r.name === "freshness_sensitive_reference");
		expect(freshnessResult).toBeDefined();
		expect(freshnessResult?.message).toContain("freshness-sensitive software reference");
		expect(freshnessResult?.detail).toContain("vendor-model-v4");
		expect(freshnessResult?.detail).toContain("official model provider documentation");

		const warning = formatQualityWarnings(results).join("\n");
		expect(warning).toContain("[interlinked:freshness_sensitive_reference] [heuristic]");
		expect(warning).toContain("Verify the newly introduced reference against official current sources");
	});
});

/**
 * GO_REQUIRE_RE was EXPONENTIAL until 2026-08-04: its inner `[^\s]+` matched
 * the `/` that the outer group repeats on, so a slash-heavy go.mod line with no
 * following space partitioned exponentially — a 66-BYTE input took 51 SECONDS.
 * This parser runs daemon-side, so that is a hang of the guard path. Found by
 * an adversarial input probe over the redos_catastrophic corpus hits.
 */
describe("go.mod parsing cost", () => {
	it("parses a slash-heavy non-matching line in bounded time", () => {
		// 16x the input that took 51s before the fix. A ratio guard is pointless
		// here — the pre-fix form cannot finish this call at all, so completing
		// inside a generous absolute budget IS the signal.
		const hostile = `a${"/1/2/3/4/5/6/7/8".repeat(64)}9`;
		const start = performance.now();
		collectSoftwareVersionReferences(hostile, "go.mod");
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it("still extracts a real go.mod require line", () => {
		const refs = collectSoftwareVersionReferences("\tgithub.com/foo/bar v1.2.3\n", "go.mod");
		expect(refs.some((r) => r.anchor.includes("github.com/foo/bar"))).toBe(true);
	});

	it("still extracts a deep module path", () => {
		const refs = collectSoftwareVersionReferences("\texample.com/a/b/c/d v2.0.1\n", "go.mod");
		expect(refs.some((r) => r.anchor.includes("example.com/a/b/c/d"))).toBe(true);
	});
});

describe("Cargo.toml dependency parsing", () => {
	it("extracts a comparable Cargo dependency version from a .toml file", () => {
		const refs = collectSoftwareVersionReferences('serde = "1.2.3"\n', "Cargo.toml");
		expect(refs).toContainEqual(
			expect.objectContaining({
				anchor: "package:serde",
				label: "Cargo package serde",
				kind: "package",
				version: "1.2.3",
				line: 1,
			}),
		);
	});

	it("still parses a non-Cargo.toml file that merely ends in .toml", () => {
		const refs = collectSoftwareVersionReferences('tokio = "0.9.0"\n', "config/other.toml");
		expect(refs.some((r) => r.anchor === "package:tokio")).toBe(true);
	});

	it("ignores a Cargo dependency whose quoted value is not a comparable version", () => {
		// Note: `serde = "workspace"` ALSO matches the unconditional
		// requirement-style collector (REQUIREMENT_RE has no file-type gate),
		// which produces its OWN `package:serde` ref regardless of
		// comparability — so the assertion targets the Cargo-specific label,
		// not the shared anchor.
		const refs = collectSoftwareVersionReferences('serde = "workspace"\n', "Cargo.toml");
		expect(refs.some((r) => r.label === "Cargo package serde")).toBe(false);
	});

	it("does not run the Cargo-dependency parser for non-.toml files", () => {
		// Same caveat as above: the line still produces a requirement-style
		// `package:serde` ref via REQUIREMENT_RE, which has no file-type gate.
		// What the .toml gate (base === "cargo.toml" || filePath.endsWith(".toml"))
		// actually controls is the Cargo-labeled ref specifically.
		const refs = collectSoftwareVersionReferences('serde = "1.2.3"\n', "notes.md");
		expect(refs.some((r) => r.label === "Cargo package serde")).toBe(false);
	});
});

describe("formatSoftwareVersionRegressionDetail / formatSoftwareVersionFreshnessDetail", () => {
	function fakeRef(overrides: Partial<SoftwareVersionReference> = {}): SoftwareVersionReference {
		return {
			anchor: "package:x",
			label: "x",
			kind: "package",
			version: "1.0.0",
			line: 1,
			text: "x",
			...overrides,
		};
	}

	it("returns an empty string and adds no header for zero regressions", () => {
		expect(formatSoftwareVersionRegressionDetail([])).toBe("");
	});

	it("lists every regression with no '... and N more' line at or under the 8-item cap", () => {
		const regressions: SoftwareVersionRegression[] = Array.from({ length: 8 }, (_, i) => ({
			before: fakeRef({ version: "1.0.0", line: i + 1 }),
			after: fakeRef({ version: "0.9.0", line: i + 1, label: `pkg-${i}` }),
		}));
		const out = formatSoftwareVersionRegressionDetail(regressions);
		expect(out).toContain("Likely regressions:");
		expect(out).not.toContain("more");
		expect(out.split("\n")).toHaveLength(9); // header + 8 entries
	});

	it("truncates past 8 regressions and appends a '... and N more' summary line", () => {
		const regressions: SoftwareVersionRegression[] = Array.from({ length: 11 }, (_, i) => ({
			before: fakeRef({ version: "1.0.0", line: i + 1 }),
			after: fakeRef({ version: "0.9.0", line: i + 1, label: `pkg-${i}` }),
		}));
		const out = formatSoftwareVersionRegressionDetail(regressions);
		expect(out).toContain("  ... and 3 more");
	});

	it("returns an empty string and adds no header for zero freshness concerns", () => {
		expect(formatSoftwareVersionFreshnessDetail([])).toBe("");
	});

	it("truncates past 8 freshness concerns and appends a '... and N more' summary line", () => {
		const concerns: SoftwareVersionFreshnessConcern[] = Array.from({ length: 10 }, (_, i) => ({
			ref: fakeRef({ line: i + 1, label: `model-${i}` }),
			reason: "unverified",
			verifyHint: { source: "docs", instruction: "check the docs" },
		}));
		const out = formatSoftwareVersionFreshnessDetail(concerns);
		expect(out).toContain("Freshness-sensitive new references:");
		expect(out).toContain("  ... and 2 more");
	});
});

describe("collectPackageJsonRefs edge cases", () => {
	it("returns no refs for malformed JSON in a package.json file rather than throwing", () => {
		expect(() => collectSoftwareVersionReferences("{not valid json", "package.json")).not.toThrow();
		expect(collectSoftwareVersionReferences("{not valid json", "package.json")).toEqual([]);
	});

	it("returns no refs when package.json parses to a non-object (array)", () => {
		expect(collectSoftwareVersionReferences("[]", "package.json")).toEqual([]);
	});

	it("returns no refs when package.json parses to a non-object (primitive)", () => {
		expect(collectSoftwareVersionReferences("42", "package.json")).toEqual([]);
	});

	it("falls back to line 1 when the version text cannot be located verbatim in the source", () => {
		// `o` is a JSON-escaped "o" — JSON.parse resolves the key to
		// "version" but the literal substring "version" never appears in the
		// source text, so findJsonPropLine's line-by-line regex search never
		// matches and falls back to its line-1 default.
		const content = '{"versi\\u006fn": "9.9.9"}';
		const refs = collectSoftwareVersionReferences(content, "package.json");
		const versionRef = refs.find((r) => r.anchor === "package:self-version");
		expect(versionRef?.version).toBe("9.9.9");
		expect(versionRef?.line).toBe(1);
	});

	it("skips a dependencies section whose value is not an object", () => {
		const content = JSON.stringify({ version: "1.0.0", dependencies: "not-an-object" });
		const refs = collectSoftwareVersionReferences(content, "package.json");
		// The malformed `dependencies` section itself contributes NO package
		// refs (the `typeof deps !== "object"` guard skips it) — the JSON's
		// own `version` field still produces the self-version ref via the
		// structured collector, and separately via the line-level generic
		// scanner (SOFTWARE_KEY_RE matches the bare "version" key too).
		expect(refs.some((r) => r.anchor === "package:self-version" && r.version === "1.0.0")).toBe(
			true,
		);
		expect(refs.some((r) => r.anchor.startsWith("package:") && r.label.includes("dependencies"))).toBe(
			false,
		);
	});
});
