// ===========================================
// output-json unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { outputJson } from "./output-json.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

// Delegates to the canonical `emptyResults()` so this fixture can never drift
// from `CodeQualityResults` when a new bucket is added (it previously held a
// hand-maintained key list that broke on every new check — e.g. untested_files).
function emptyCq(): CodeQualityResults {
	return emptyResults();
}

function captureStdout(fn: () => void): string {
	const chunks: string[] = [];
	const orig = process.stdout.write;
	process.stdout.write = ((c: string) => {
		chunks.push(c);
		return true;
	});
	try {
		fn();
		return chunks.join("");
	} finally {
		process.stdout.write = orig;
	}
}

describe("outputJson", () => {
    it("includes duplicate HTML ID locations in JSON output", () => {
        const cq = emptyCq();
        const issue = {
            check: "html_duplicate_id", file: "index.html", line: 4,
            message: 'Duplicate HTML id "panel"; first used on line 2.',
        };
        cq.htmlDuplicateId.push(issue);
        const out = captureStdout(() => outputJson({
            tscResults: [], linterResults: [], linterName: "biome",
            semgrepResults: [], gitleaksResults: [], auditResult: null,
            cq, suggestions: null, totalFiles: 1,
        }));
        expect(JSON.parse(out).html_duplicate_id).toEqual({
            issues: 1, files: ["index.html"], details: [issue],
        });
    });
	it("emits valid JSON to stdout", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.files_scanned).toBe(0);
		expect(parsed.tsc.issues).toBe(0);
		expect(parsed.biome.issues).toBe(0);
	});

	it("serializes code_clones findings for JSON consumers", () => {
		const cq = emptyCq();
		cq.codeClones.push({
			check: "code_clones",
			file: "src/example.ts",
			line: 12,
			message: "collectA() is 95% similar to collectB() -- extract the shared logic",
		});
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq,
				suggestions: null,
				totalFiles: 1,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.code_clones.issues).toBe(1);
		expect(parsed.code_clones.details[0].file).toBe("src/example.ts");
	});

	it("includes suggestions section when provided", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: new Map([
					[
						"a.ts",
						[{ check: "sql", line: 1, message: "m", source: "security", score: 0.9 }],
					],
				]),
				totalFiles: 1,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.suggestions).toBeDefined();
		expect(parsed.suggestions["a.ts"]).toHaveLength(1);
	});

	it("emits empty registry_parity section when no drift findings are passed", () => {
		// Regression: --json must always include the registry_parity key so
		// CI consumers can rely on its presence. Empty findings → issues: 0,
		// details: [].
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.registry_parity).toBeDefined();
		expect(parsed.registry_parity.issues).toBe(0);
		expect(parsed.registry_parity.details).toEqual([]);
	});

	it("includes registry drift findings in the JSON output", () => {
		// Regression: pre-fix, registry parity was only wired into the
		// streaming path, so `interlinked verify --json` silently dropped
		// drift findings that the interactive run would have shown.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				registryDrift: [
					{
						pair: "suggestion-checks",
						kind: "missing-from-right",
						id: "ghost-check",
						source_file: "src/harness/server/suggestion-checks.ts",
						target_file: "src/commands/verify/suggestions.ts",
						message: '[suggestion-checks] "ghost-check" is in left but not right',
					},
				],
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.registry_parity.issues).toBe(1);
		expect(parsed.registry_parity.details).toHaveLength(1);
		expect(parsed.registry_parity.details[0]).toMatchObject({
			pair: "suggestion-checks",
			kind: "missing-from-right",
			id: "ghost-check",
		});
	});

	it("emits empty decision_surface + multiple_lockfiles sections when not passed", () => {
		// Regression: --json must always include these keys so CI consumers
		// can rely on the schema. Absent args → empty by_category map +
		// total_surface 0, issues 0, details [].
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface).toBeDefined();
		expect(parsed.decision_surface.total_surface).toBe(0);
		expect(parsed.decision_surface.by_category).toEqual({});
		expect(parsed.multiple_lockfiles).toBeDefined();
		expect(parsed.multiple_lockfiles.issues).toBe(0);
		expect(parsed.multiple_lockfiles.details).toEqual([]);
	});

	it("emits the decision_surface metric when passed", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				decisionSurface: {
					projectRoot: "/repo",
					byCategory: {
						package_manager: ["npm"],
						test_framework: ["vitest"],
						linter: ["biome"],
						formatter: ["biome"],
						bundler: ["tsup"],
						http_client: [],
						date_lib: [],
					},
					totalSurface: 5,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface.total_surface).toBe(5);
		expect(parsed.decision_surface.by_category.test_framework).toEqual(["vitest"]);
		expect(parsed.decision_surface.by_category.linter).toEqual(["biome"]);
	});

	it("emits multiple_lockfiles details when multiplicity is true", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				lockfileMultiplicity: {
					lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
					managers: ["npm", "pnpm"],
					multiplicity: true,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.multiple_lockfiles.issues).toBe(1);
		expect(parsed.multiple_lockfiles.details).toHaveLength(1);
		expect(parsed.multiple_lockfiles.details[0].managers).toEqual(["npm", "pnpm"]);
		expect(parsed.multiple_lockfiles.details[0].message).toContain("Multiple lockfiles");
	});

	it("emits no multiple_lockfiles issue when multiplicity is false", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				lockfileMultiplicity: {
					lockfiles: ["package-lock.json"],
					managers: ["npm"],
					multiplicity: false,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.multiple_lockfiles.issues).toBe(0);
		expect(parsed.multiple_lockfiles.details).toEqual([]);
	});

	it("emits empty decision_surface_growth when not passed", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface_growth).toBeDefined();
		expect(parsed.decision_surface_growth.skipped).toBe("not-computed");
		expect(parsed.decision_surface_growth.total_growth).toBe(0);
		expect(parsed.decision_surface_growth.warnings).toEqual([]);
	});

	it("emits decision_surface_growth when the ratchet ran with growth", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				decisionSurfaceRatchet: {
					baselineRef: "origin/main",
					skipped: null,
					growthByCategory: {
						package_manager: [],
						test_framework: ["jest"],
						linter: [],
						formatter: [],
						bundler: [],
						http_client: [],
						date_lib: [],
					},
					totalGrowth: 1,
					warnings: [
						"[heuristic] decision_surface_growth — test_framework expanded since origin/main: added jest.",
					],
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface_growth.baseline_ref).toBe("origin/main");
		expect(parsed.decision_surface_growth.skipped).toBeNull();
		expect(parsed.decision_surface_growth.total_growth).toBe(1);
		expect(parsed.decision_surface_growth.growth_by_category.test_framework).toEqual(["jest"]);
		expect(parsed.decision_surface_growth.warnings).toHaveLength(1);
	});

	it("emits decision_surface_growth with skip reason when the ratchet skipped", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
				decisionSurfaceRatchet: {
					baselineRef: null,
					skipped: "not-a-repo",
					growthByCategory: {
						package_manager: [],
						test_framework: [],
						linter: [],
						formatter: [],
						bundler: [],
						http_client: [],
						date_lib: [],
					},
					totalGrowth: 0,
					warnings: [],
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface_growth.skipped).toBe("not-a-repo");
		expect(parsed.decision_surface_growth.baseline_ref).toBeNull();
		expect(parsed.decision_surface_growth.warnings).toEqual([]);
	});

	it("maps setupIssues into project_setup.details with file/message/fix", () => {
		// Exercises the `setupIssues?.map(...)` projection (line 89). The mapped
		// shape must carry exactly file/message/fix — nothing else from the
		// richer ProjectSetupIssue (e.g. `check`, `line`) leaks through.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 2,
				setupIssues: [
					{
						check: "missing-types-dep",
						file: "tsconfig.json",
						line: 4,
						message: 'compilerOptions.types lists "vitest" but it is not installed',
						fix: "npm i -D vitest",
					},
				],
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.project_setup.issues).toBe(1);
		expect(parsed.project_setup.details).toHaveLength(1);
		expect(parsed.project_setup.details[0]).toEqual({
			file: "tsconfig.json",
			message: 'compilerOptions.types lists "vitest" but it is not installed',
			fix: "npm i -D vitest",
		});
		// `check` and `line` are intentionally dropped by the projection.
		expect(parsed.project_setup.details[0]).not.toHaveProperty("check");
		expect(parsed.project_setup.details[0]).not.toHaveProperty("line");
	});

	it("summarizes semgrep findings with deduped+sorted files and raw details", () => {
		// Exercises the semgrep file-projection callback (line 141): the `files`
		// array is the deduped, sorted set of result files while `findings`
		// counts every row and `details` is the raw, unsummarized list.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [
					{
						tool: "semgrep",
						severity: "error",
						file: "src/z.ts",
						line: 3,
						message: "tainted sink",
						ruleId: "rule.taint",
					},
					{
						tool: "semgrep",
						severity: "warning",
						file: "src/a.ts",
						line: 9,
						message: "weak rng",
					},
					{
						tool: "semgrep",
						severity: "error",
						file: "src/z.ts",
						line: 40,
						message: "second hit in same file",
					},
				],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 2,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.semgrep.findings).toBe(3);
		// deduped (z.ts appears twice → once) and sorted (a before z).
		expect(parsed.semgrep.files).toEqual(["src/a.ts", "src/z.ts"]);
		expect(parsed.semgrep.details).toHaveLength(3);
		expect(parsed.semgrep.details[0].ruleId).toBe("rule.taint");
	});

	it("summarizes gitleaks secrets with deduped+sorted files and raw details", () => {
		// Exercises the gitleaks file-projection callback (line 146).
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [
					{
						tool: "gitleaks",
						severity: "error",
						file: "src/secrets.ts",
						line: 11,
						message: "Generic API Key",
					},
					{
						tool: "gitleaks",
						severity: "error",
						file: ".env",
						line: 1,
						message: "AWS key",
					},
					{
						tool: "gitleaks",
						severity: "error",
						file: ".env",
						line: 2,
						message: "second secret in same file",
					},
				],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 2,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.gitleaks.secrets).toBe(3);
		expect(parsed.gitleaks.files).toEqual([".env", "src/secrets.ts"]);
		expect(parsed.gitleaks.details).toHaveLength(3);
		expect(parsed.gitleaks.details[1].message).toBe("AWS key");
	});

	it("emits the populated dependency_audit block when auditResult is present", () => {
		// Exercises the truthy arm of the `auditResult ? {...} : {...}` ternary
		// (line 149-158): every severity bucket + tool name is surfaced.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: {
					tool: "npm-audit",
					total: 7,
					critical: 1,
					high: 2,
					moderate: 3,
					low: 1,
					detail: "7 vulnerabilities across 4 packages",
				},
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.dependency_audit).toEqual({
			vulnerabilities: 7,
			critical: 1,
			high: 2,
			moderate: 3,
			low: 1,
			tool: "npm-audit",
		});
		// The `detail` string is intentionally not surfaced in the JSON shape.
		expect(parsed.dependency_audit).not.toHaveProperty("detail");
	});

	it("emits the falsy dependency_audit block when auditResult is null", () => {
		// Pairs with the test above to pin both arms of the ternary: a null
		// audit collapses to a bare { vulnerabilities: 0 } with no severity keys.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.dependency_audit).toEqual({ vulnerabilities: 0 });
		expect(parsed.dependency_audit).not.toHaveProperty("critical");
		expect(parsed.dependency_audit).not.toHaveProperty("tool");
	});

	it("attaches the structure section verbatim when structureSection is provided", () => {
		// Exercises the `if (structureSection)` true branch (lines 317-318):
		// the object is passed through unchanged under the top-level `structure`
		// key.
		const structureSection = {
			adoption: { module: 0.5, env: 1 },
			findings: [{ category: "module", message: "missing companion test" }],
		};
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 0,
				structureSection,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.structure).toEqual(structureSection);
		expect(parsed.structure.adoption.env).toBe(1);
		expect(parsed.structure.findings[0].category).toBe("module");
	});

	it("omits the structure key entirely when structureSection is undefined", () => {
		// Pins the false arm of the structure guard: absent section → no
		// `structure` key at all (not an empty object).
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 0,
				structureSection: undefined,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed).not.toHaveProperty("structure");
	});

	it("omits the suggestions key when suggestions is null", () => {
		// Pins the false arm of the `if (suggestions)` guard (line 310): a null
		// map must not add a `suggestions` key to the payload.
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyResults(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed).not.toHaveProperty("suggestions");
	});

	it("dedupes and sorts files inside a summarize() bucket and counts every row", () => {
		// `summarize()` powers the count-only buckets (e.g. console_statements):
		// `issues` counts every row, `files` is the deduped+sorted unique set,
		// and no `details` array is emitted for these buckets.
		const cq = emptyResults();
		cq.consoleStatements.push(
			{ check: "console_statements", file: "src/b.ts", line: 1, message: "console.log" },
			{ check: "console_statements", file: "src/a.ts", line: 2, message: "console.log" },
			{ check: "console_statements", file: "src/b.ts", line: 9, message: "console.log" },
		);
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq,
				suggestions: null,
				totalFiles: 2,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.console_statements.issues).toBe(3);
		expect(parsed.console_statements.files).toEqual(["src/a.ts", "src/b.ts"]);
		// summarize() (no details) — distinct from summarizeWithDetails().
		expect(parsed.console_statements).not.toHaveProperty("details");
	});

	it("keys the linter bucket by the dynamic linterName", () => {
		// `[linterName]: summarizeWithDetails(...)` is a computed key — assert it
		// honors a non-biome linter name and surfaces its details.
		const cq: CodeQualityResults = emptyResults();
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [
					{
						tool: "oxlint",
						severity: "warning",
						file: "src/x.ts",
						line: 5,
						message: "no-unused-vars",
					},
				],
				linterName: "oxlint",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq,
				suggestions: null,
				totalFiles: 1,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.oxlint.issues).toBe(1);
		expect(parsed.oxlint.details[0].file).toBe("src/x.ts");
		expect(parsed.oxlint.files).toEqual(["src/x.ts"]);
		// No `biome` key when the linter is named oxlint.
		expect(parsed).not.toHaveProperty("biome");
	});
});
